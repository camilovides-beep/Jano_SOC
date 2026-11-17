import { Body, Controller, HttpCode, HttpException, Logger, Post, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { DeepSeekService } from '../llm/deepseek.service';

/** Comprueba la cabecera X-Forward-Secret contra N8N_SECRET (tiempo constante). */
export function checkN8nSecret(req: Request, secret: string) {
  const got = Buffer.from(String(req.headers['x-forward-secret'] ?? '')), want = Buffer.from(secret);
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpException('no autorizado', 401);
}

const MAX_MEDIA = 16 * 1024 * 1024;

/**
 * Medios de WhatsApp para el flujo de n8n. Las claves (Meta, Deepgram, DeepSeek, ElevenLabs) se quedan en el avatar.
 * Verificado el 2026-11-14 con la documentacion y llamadas reales:
 *  - Meta: GET /{media-id} -> {url, mime_type}; la url caduca a los 5 min y se descarga con el mismo Bearer.
 *    POST /{phone-id}/media multipart (messaging_product, type, file) -> {id}. Audio admitido: audio/ogg SOLO con Opus y mono.
 *  - Deepgram pre-grabado: POST /v1/listen con el audio en el cuerpo. Probado con Ogg/Opus. Se fuerza language=es:
 *    con language=multi una nota de voz en espanol salio detectada como gallego (gl) y el agente respondio en gallego.
 *  - DeepSeek deepseek-flash acepta imagenes (content con image_url, data URL JPEG/PNG/GIF/WebP).
 *  - ElevenLabs POST /v1/text-to-speech/{voice}?output_format=opus_48000_32 -> Ogg/Opus mono 48 kHz.
 */
@Controller('n8n')
export class N8nController {
  private readonly log = new Logger(N8nController.name);
  constructor(private readonly cfg: ConfigService, private readonly llm: DeepSeekService) {}

  private graph(path: string) { return `https://graph.facebook.com/${this.cfg.whatsappApiVersion}/${path}`; }
  private get auth() { return { Authorization: `Bearer ${this.cfg.whatsappToken}` }; }

  private async download(mediaId: string): Promise<{ buf: Buffer; mime: string }> {
    if (!/^\d{5,30}$/.test(mediaId)) throw new HttpException('media_id inválido', 400);
    const meta = await fetch(this.graph(mediaId), { headers: this.auth, signal: AbortSignal.timeout(8000) });
    const m: any = await meta.json().catch(() => ({}));
    if (!meta.ok || !m.url) throw new HttpException(`Meta no entregó el medio (${meta.status})`, 502);
    if (Number(m.file_size) > MAX_MEDIA) throw new HttpException('archivo demasiado grande', 413);
    const file = await fetch(m.url, { headers: this.auth, signal: AbortSignal.timeout(20000) });
    if (!file.ok) throw new HttpException(`no se pudo descargar el medio (${file.status})`, 502);
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_MEDIA) throw new HttpException('archivo demasiado grande', 413);
    return { buf, mime: String(m.mime_type ?? file.headers.get('content-type') ?? '') };
  }

  /**
   * Convierte un mensaje de imagen o audio en texto para el agente.
   * Entrada: {type: 'image'|'audio', media_id, caption?}. Salida: {text, language}.
   */
  @Post('entender')
  @HttpCode(200)
  async understand(@Req() req: Request, @Body() body: { type?: string; media_id?: string; caption?: string }) {
    checkN8nSecret(req, this.cfg.n8nSecret);
    const t0 = Date.now();
    const { buf, mime } = await this.download(String(body?.media_id ?? ''));
    const caption = String(body?.caption ?? '').trim().slice(0, 1000);

    if (body?.type === 'audio') {
      const q = new URLSearchParams({ model: this.cfg.deepgramModel, language: 'es', smart_format: 'true' });
      const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
        method: 'POST', headers: { Authorization: `Token ${this.cfg.deepgramApiKey}`, 'Content-Type': mime.split(';')[0] || 'audio/ogg' },
        body: new Uint8Array(buf), signal: AbortSignal.timeout(30000),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpException(`Deepgram respondió ${res.status}`, 502);
      const alt = d.results?.channels?.[0]?.alternatives?.[0] ?? {};
      const text = String(alt.transcript ?? '').trim();
      const language = 'es'; // WhatsApp siempre en espanol latino (pedido por Javier el 2026-11-14)
      this.log.log(`n8n: audio transcrito (${buf.length} bytes, ${Date.now() - t0} ms, ${language})`);
      return { text, language, empty: !text };
    }

    if (body?.type === 'image') {
      const type = mime.split(';')[0];
      if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return { text: caption, language: 'es', unsupported: true };
      const prompt = 'Describe con detalle lo que se ve en esta imagen, en español, en un párrafo. Si tiene texto, transcríbelo.';
      const desc = await this.llm.complete([{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${type};base64,${buf.toString('base64')}` } },
      ] }]).catch((e) => { throw new HttpException(`DeepSeek no pudo ver la imagen: ${(e as Error).message.slice(0, 200)}`, 502); });
      this.log.log(`n8n: imagen descrita (${buf.length} bytes, ${Date.now() - t0} ms)`);
      const text = `(La persona envió una imagen. Lo que se ve: ${desc.trim()})${caption ? `\nSu mensaje con la imagen: ${caption}` : ''}`;
      return { text, language: 'es' };
    }
    throw new HttpException('type debe ser image o audio', 400);
  }

  /** Genera la respuesta con la voz de Javier y la envía como nota de voz. Entrada: {to, text, language?}. */
  @Post('responder-audio')
  @HttpCode(200)
  async replyAudio(@Req() req: Request, @Body() body: { to?: string; text?: string; language?: string }) {
    checkN8nSecret(req, this.cfg.n8nSecret);
    const to = String(body?.to ?? '').replace(/\D/g, '');
    const text = String(body?.text ?? '').trim().slice(0, 2500);
    if (to.length < 8 || to.length > 15 || !text) throw new HttpException('faltan to o text', 400);
    if (!this.cfg.whatsappToken || !this.cfg.whatsappPhoneNumberId) throw new HttpException('WhatsApp no está configurado', 503);
    if (!this.cfg.elevenApiKey || !this.cfg.elevenVoiceId) throw new HttpException('no hay voz configurada (ElevenLabs)', 503);
    const t0 = Date.now();

    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.cfg.elevenVoiceId}?output_format=opus_48000_32`, {
      method: 'POST', headers: { 'xi-api-key': this.cfg.elevenApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: voiceText(text), model_id: this.cfg.elevenModelId, language_code: 'es' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!tts.ok) throw new HttpException(`ElevenLabs respondió ${tts.status}`, 502);
    const audio = Buffer.from(await tts.arrayBuffer());

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'audio/ogg');
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'respuesta.ogg');
    const up = await fetch(this.graph(`${this.cfg.whatsappPhoneNumberId}/media`), { method: 'POST', headers: this.auth, body: form, signal: AbortSignal.timeout(20000) });
    const u: any = await up.json().catch(() => ({}));
    if (!up.ok || !u.id) throw new HttpException(`Meta no aceptó el audio (${up.status}): ${u.error?.message ?? ''}`.slice(0, 300), 502);

    const send = await fetch(this.graph(`${this.cfg.whatsappPhoneNumberId}/messages`), {
      method: 'POST', headers: { ...this.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'audio', audio: { id: u.id } }),
      signal: AbortSignal.timeout(10000),
    });
    const s: any = await send.json().catch(() => ({}));
    if (!send.ok) throw new HttpException(`Meta no envió el audio (${send.status}): ${s.error?.message ?? ''}`.slice(0, 300), 502);
    this.log.log(`n8n: nota de voz enviada (${audio.length} bytes, ${Date.now() - t0} ms)`);
    return { ok: true, message_id: s.messages?.[0]?.id ?? '' };
  }
}

/** Quita lo que no se debe leer en voz alta: emojis, asteriscos y enlaces. */
export function voiceText(s: string) {
  return s.replace(/https?:\/\/\S+/g, '').replace(/[*_~`#>]/g, '').replace(/\p{Extended_Pictographic}️?/gu, '').replace(/[ \t]+/g, ' ').trim();
}
