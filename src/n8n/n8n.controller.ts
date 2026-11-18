import { Body, Controller, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { WaError, WhatsAppService } from '../whatsapp/whatsapp.service';

/** Comprueba la cabecera X-Forward-Secret contra N8N_SECRET (tiempo constante). */
export function checkN8nSecret(req: Request, secret: string) {
  const got = Buffer.from(String(req.headers['x-forward-secret'] ?? '')), want = Buffer.from(secret);
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpException('no autorizado', 401);
}
const http = (e: unknown): never => { throw e instanceof WaError ? new HttpException(e.message, e.status) : e; };

/**
 * Medios de WhatsApp para el flujo de n8n (solo se usa con WHATSAPP_REPLIES=n8n; por defecto responde el avatar, ver
 * wa-chat.service.ts). Las claves (Meta, Deepgram, DeepSeek, ElevenLabs) se quedan en el avatar: el trabajo lo hace WhatsAppService.
 */
@Controller('n8n')
export class N8nController {
  constructor(private readonly cfg: ConfigService, private readonly wa: WhatsAppService) {}

  /** Convierte un mensaje de imagen o audio en texto para el agente. Entrada: {type: 'image'|'audio', media_id, caption?}. Salida: {text, language}. */
  @Post('entender')
  @HttpCode(200)
  async understand(@Req() req: Request, @Body() body: { type?: string; media_id?: string; caption?: string }) {
    checkN8nSecret(req, this.cfg.n8nSecret);
    return this.wa.understand(String(body?.type ?? ''), String(body?.media_id ?? ''), String(body?.caption ?? '')).catch(http);
  }

  /** Genera la respuesta con la voz de Javier y la envía como nota de voz. Entrada: {to, text, language?}. */
  @Post('responder-audio')
  @HttpCode(200)
  async replyAudio(@Req() req: Request, @Body() body: { to?: string; text?: string; language?: string }) {
    checkN8nSecret(req, this.cfg.n8nSecret);
    const to = String(body?.to ?? '').replace(/\D/g, ''), text = String(body?.text ?? '').trim().slice(0, 2500);
    if (to.length < 8 || to.length > 15 || !text) throw new HttpException('faltan to o text', 400);
    if (!this.wa.canSend) throw new HttpException('WhatsApp no está configurado', 503);
    return { ok: true, message_id: await this.wa.sendVoice(to, text).catch(http) };
  }
}
