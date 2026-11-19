import { Controller, Get, HttpCode, HttpException, Logger, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { LeadsService } from '../leads/leads.service';
import { SessionGateway } from '../session/session.gateway';
import { CallMedia } from './call-media';
import { CallSocket } from './call-socket';
import { WaChatService } from '../whatsapp/wa-chat.service';
import { OptOutService } from '../security/optout.service';

const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Webhook de WhatsApp (API de llamadas). Verificado con la documentacion de Meta el 2026-11-13:
 *  - GET  con hub.mode=subscribe, hub.verify_token y hub.challenge -> se responde el challenge si el token coincide.
 *  - POST con cabecera X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 del cuerpo crudo con el secreto de la app.
 *  - Llamada entrante: entry[].changes[] con field "calls" y value.calls[] {id, from, to, event: connect|terminate, session}.
 * Tambien acepta eventos reenviados por otro sistema (por ejemplo n8n) con la cabecera X-Forward-Secret.
 * CALL_MODE=rechazar (por defecto): registra, avisa por Telegram y rechaza.
 * CALL_MODE=prueba (etapa 2): contesta, envia dos pitidos, mide el audio recibido durante CALL_TEST_SECONDS y cuelga.
 * CALL_MODE=conversar (etapa 3): contesta y conecta la llamada con la misma conversacion del avatar web.
 */
@Controller('webhooks/whatsapp')
export class CallsController {
  private readonly log = new Logger(CallsController.name);
  private readonly active = new Map<string, CallMedia>();
  private readonly sockets = new Map<string, CallSocket>();
  /** Transcripcion de cada llamada en curso: quien llama, inicio y las frases de cada lado. */
  private readonly logs = new Map<string, { who: string; from: string; start: number; lines: string[]; avatar: string; speech: number }>();
  constructor(private readonly cfg: ConfigService, private readonly leads: LeadsService, private readonly gateway: SessionGateway, private readonly chat: WaChatService, private readonly optout: OptOutService) {}

  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    if (!this.cfg.whatsappVerifyToken || mode !== 'subscribe' || !safeEqual(String(token ?? ''), this.cfg.whatsappVerifyToken)) throw new HttpException('no autorizado', 403);
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody ?? Buffer.from('');
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const fwd = String(req.headers['x-forward-secret'] ?? '');
    const fromMeta = !!this.cfg.whatsappAppSecret && sig.startsWith('sha256=') &&
      safeEqual(sig.slice(7), createHmac('sha256', this.cfg.whatsappAppSecret).update(raw).digest('hex'));
    const fromForwarder = !!this.cfg.whatsappForwardSecret && safeEqual(fwd, this.cfg.whatsappForwardSecret);
    if (!fromMeta && !fromForwarder) throw new HttpException('firma invalida', 401);

    let body: any; try { body = JSON.parse(raw.toString('utf8')); } catch { return { ok: true }; }
    // Mensajes (texto, imagenes, notas de voz): los responde el avatar (WHATSAPP_REPLIES=avatar, por defecto) o se reenvian
    // tal cual a n8n (WHATSAPP_REPLIES=n8n). Solo si la firma es de Meta: un reenvio de otro sistema no dispara respuestas.
    const messages = (body?.entry ?? []).flatMap((e: any) => e?.changes ?? []).filter((c: any) => c?.field === 'messages');
    if (messages.length && fromMeta) {
      if (this.cfg.whatsappReplies === 'n8n' && this.cfg.n8nWebhookUrl) void this.forwardToN8n(raw);
      else if (this.cfg.whatsappReplies === 'avatar') for (const c of messages) this.chat.onWebhook(c.value);
    }
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field !== 'calls') continue; // mensajes y demas eventos no se tocan aqui
        const v = change.value ?? {};
        if (this.cfg.whatsappPhoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== this.cfg.whatsappPhoneNumberId) continue;
        for (const call of v.calls ?? []) {
          // WhatsApp a veces no manda "from" en la llamada (por ejemplo con nombre de usuario): se toma el wa_id del contacto.
          if (!call.from && v.contacts?.[0]?.wa_id) call.from = v.contacts[0].wa_id;
          void this.onCall(call, v.contacts?.[0]?.profile?.name).catch((e) => this.log.error(`llamada ${call?.id}: ${e.message}`));
        }
      }
    }
    return { ok: true };
  }

  private async onCall(call: any, name?: string) {
    const who = `${name ? name + ' ' : ''}(${call.from ?? 'número oculto'})`;
    if (call.event === 'connect') {
      this.log.log(`llamada entrante ${call.id} de ${who}; oferta SDP de ${String(call.session?.sdp ?? '').length} caracteres`);
      if (this.cfg.callMode === 'prueba' && call.session?.sdp && this.active.size < this.cfg.callMax) return this.testCall(call.id, call.session.sdp, who);
      if (this.cfg.callMode === 'conversar' && call.session?.sdp && this.active.size < this.cfg.callMax) return this.talkCall(call.id, call.session.sdp, who, call.from);
      void this.leads.telegram(`📞 Llamada de WhatsApp entrante de ${who}.\nEl avatar aún no contesta llamadas; se rechazó.`);
      const err = await this.callAction(call.id, 'reject');
      this.log.log(err ? `no se pudo rechazar ${call.id}: ${err}` : `llamada ${call.id} rechazada`);
    } else if (call.event === 'terminate') {
      this.log.log(`llamada ${call.id} terminada: ${call.status ?? 'sin estado'}${call.duration ? `, ${call.duration} s` : ''}`);
      this.sockets.get(call.id)?.hangup(); this.sockets.delete(call.id);
      const m = this.active.get(call.id); if (m) { this.active.delete(call.id); await this.report(call.id, m, call.duration); await m.close(); }
    }
  }

  /** Etapa 3: contestar y conectar la llamada con la conversacion del avatar (escucha, modelo, voz, herramientas). */
  private async talkCall(id: string, offer: string, who: string, from?: string) {
    const media = new CallMedia({ publicIp: this.cfg.callPublicIp, portMin: this.cfg.callPortMin, portMax: this.cfg.callPortMax });
    this.active.set(id, media);
    const t0 = Date.now();
    let rate = 24000;
    this.logs.set(id, { who, from: String(from ?? ''), start: Date.now(), lines: [], avatar: '', speech: 0 });
    const socket = new CallSocket(
      (msg) => {                                              // lo que la conversacion le manda al "navegador"
        const log = this.logs.get(id);
        if (msg.type === 'speech_start') { media.flushVoice(); rate = msg.sampleRate ?? rate; this.flushAvatar(id); if (log) log.speech = msg.id; }
        else if (msg.type === 'audio' && msg.audio) { media.pushVoice(Buffer.from(msg.audio, 'base64'), rate); if (log && msg.align?.chars) log.avatar += msg.align.chars.join(''); }
        else if (msg.type === 'user_final' && log) { this.flushAvatar(id); log.lines.push(`🧑 ${msg.text}`); }
        else if (msg.type === 'interrupt') { media.flushVoice(); if (log && log.avatar) log.avatar += ' [interrumpido]'; }
        else if (msg.type === 'error') this.log.warn(`llamada ${id}: la conversación avisó ${msg.reason}`);
      },
      () => { void this.hangupFromServer(id); },              // la conversacion se cerro (tiempo maximo, inactividad)
    );
    try {
      const sdp = await media.answer(offer);
      let err = await this.callAction(id, 'pre_accept', sdp);
      if (!err) err = await this.callAction(id, 'accept', sdp);
      if (err) throw new Error(err);
      this.log.log(`llamada ${id} contestada por el avatar en ${Date.now() - t0} ms`);
      media.onPcm16k = (pcm) => socket.audio(pcm);
      media.onPlaying = (playing) => socket.json({ type: 'playback', playing });
      media.startOutput();
      this.sockets.set(id, socket);
      this.gateway.handleConnection(socket as any);
      const phone = from ? `+${String(from).replace(/\D/g, '')}` : undefined;
      const visitor = from ? createHash('sha256').update(`wa:${from}`).digest('hex').slice(0, 32) : undefined; // memoria por numero
      socket.json({ type: 'hello', phone, visitor });
      void this.leads.telegram(`📞 El avatar contestó una llamada de WhatsApp de ${who}.`);
    } catch (e) {
      this.log.error(`llamada ${id}: ${(e as Error).message}`);
      this.active.delete(id); await media.close();
      await this.callAction(id, 'terminate');
    }
  }

  private async hangupFromServer(id: string) {
    this.sockets.delete(id);
    const m = this.active.get(id);
    if (m) { this.active.delete(id); await this.report(id, m); await m.close(); }
    const err = await this.callAction(id, 'terminate');
    this.log.log(err ? `no se pudo colgar ${id}: ${err}` : `llamada ${id} colgada por el avatar`);
  }

  private flushAvatar(id: string) {
    const log = this.logs.get(id); if (!log) return;
    const t = log.avatar.replace(/\s+/g, ' ').trim(); if (t) log.lines.push(`🤖 ${t}`); log.avatar = '';
  }

  /** Al terminar: transcripcion y grabacion de la llamada a Telegram (mas adelante iran a un panel). */
  private async report(id: string, media: CallMedia, duration?: number) {
    this.flushAvatar(id);
    const log = this.logs.get(id); this.logs.delete(id);
    if (!log) return;
    const secs = duration ?? Math.round((Date.now() - log.start) / 1000);
    const st = media.stats;
    const head = `📞 Llamada con el avatar — ${log.who}\n⏱ ${secs} s · audio recibido ${st.seconds.toFixed(0)} s · ICE: ${st.iceLog.join(' → ') || st.ice}`;
    const body = log.lines.length ? log.lines.join('\n') : '(no hubo conversación reconocida)';
    void this.leads.logConversation('llamada', log.who, secs, log.lines);
    // Si quien llamo pidio que no lo contacten, queda marcado (se revisa lo que dijo, en segundo plano).
    if (log.from) void this.optout.check(log.lines.filter((l) => l.startsWith('🧑')).map((l) => l.slice(2).trim()).join('\n'), log.from, 'llamada de WhatsApp', true);
    const err = await this.leads.telegramLong(`${head}\n\n${body}`);
    if (err) this.log.warn(`transcripcion de ${id}: ${err}`);
    const wav = media.recording();
    if (wav && wav.length > 44 + 32000) {
      const e2 = await this.leads.telegramFile(wav, `llamada-${new Date(log.start).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.wav`, `Grabación: ${log.who}, ${secs} s`);
      if (e2) this.log.warn(`grabacion de ${id}: ${e2}`);
    }
  }

  /** Etapa 2: contestar, enviar dos pitidos, medir el audio que llega y colgar. */
  private async testCall(id: string, offer: string, who: string) {
    const media = new CallMedia({ publicIp: this.cfg.callPublicIp, portMin: this.cfg.callPortMin, portMax: this.cfg.callPortMax });
    this.active.set(id, media);
    const t0 = Date.now();
    try {
      const sdp = await media.answer(offer);
      this.log.log(`llamada ${id}: respuesta SDP lista en ${Date.now() - t0} ms (${(sdp.match(/a=candidate/g) ?? []).length} candidatos)`);
      let err = await this.callAction(id, 'pre_accept', sdp);
      if (!err) err = await this.callAction(id, 'accept', sdp);
      if (err) throw new Error(err);
      this.log.log(`llamada ${id} aceptada en ${Date.now() - t0} ms`);
      media.startTestAudio(); // el audio sale solo despues del 200 OK de accept
      await new Promise((r) => setTimeout(r, this.cfg.callTestSeconds * 1000));
    } catch (e) {
      this.log.error(`llamada ${id}: ${(e as Error).message}`);
    } finally {
      const st = media.stats;
      if (this.active.has(id)) { await this.callAction(id, 'terminate'); this.active.delete(id); await media.close(); }
      const msg = `📞 Prueba de llamada de ${who}\nICE: ${st.ice}\nAudio recibido: ${st.packets} paquetes, ${st.seconds.toFixed(1)} s, con voz ${st.voiceSeconds.toFixed(1)} s (pico ${st.peak.toFixed(2)})`;
      this.log.log(msg.replace(/\n/g, ' | '));
      void this.leads.telegram(msg);
    }
  }

  private async forwardToN8n(raw: Buffer) {
    try {
      const res = await fetch(this.cfg.n8nWebhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forward-Secret': this.cfg.n8nSecret }, body: new Uint8Array(raw),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.warn(`n8n respondió ${res.status} al reenviar un mensaje`);
    } catch (e) { this.log.warn(`no se pudo reenviar el mensaje a n8n: ${(e as Error).name}`); }
  }

  /** POST /{phone-number-id}/calls con action pre_accept | accept | reject | terminate. Devuelve '' o el motivo del fallo. */
  private async callAction(callId: string, action: string, sdp?: string): Promise<string> {
    if (!this.cfg.whatsappToken || !this.cfg.whatsappPhoneNumberId) return 'WhatsApp no está configurado';
    try {
      const res = await fetch(`https://graph.facebook.com/${this.cfg.whatsappApiVersion}/${this.cfg.whatsappPhoneNumberId}/calls`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.cfg.whatsappToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', call_id: callId, action, ...(sdp ? { session: { sdp_type: 'answer', sdp } } : {}) }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return '';
      const d: any = await res.json().catch(() => ({}));
      return `Meta respondió ${res.status}${d.error?.code ? ` (código ${d.error.code})` : ''}: ${d.error?.error_data?.details ?? d.error?.message ?? 'sin detalle'}`;
    } catch (e) { return `sin conexión: ${(e as Error).name}`; }
  }
}
