import { Controller, Get, HttpCode, HttpException, Logger, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { LeadsService } from '../leads/leads.service';

const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Webhook de WhatsApp (API de llamadas). Verificado con la documentacion de Meta el 2026-11-13:
 *  - GET  con hub.mode=subscribe, hub.verify_token y hub.challenge -> se responde el challenge si el token coincide.
 *  - POST con cabecera X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 del cuerpo crudo con el secreto de la app.
 *  - Llamada entrante: entry[].changes[] con field "calls" y value.calls[] {id, from, to, event: connect|terminate, session}.
 * Tambien acepta eventos reenviados por otro sistema (por ejemplo n8n) con la cabecera X-Forward-Secret.
 * ETAPA 1: solo registra la llamada, avisa por Telegram y la rechaza (aun no hay audio).
 */
@Controller('webhooks/whatsapp')
export class CallsController {
  private readonly log = new Logger(CallsController.name);
  constructor(private readonly cfg: ConfigService, private readonly leads: LeadsService) {}

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
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field !== 'calls') continue; // mensajes y demas eventos no se tocan aqui
        const v = change.value ?? {};
        if (this.cfg.whatsappPhoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== this.cfg.whatsappPhoneNumberId) continue;
        for (const call of v.calls ?? []) void this.onCall(call, v.contacts?.[0]?.profile?.name).catch((e) => this.log.error(`llamada ${call?.id}: ${e.message}`));
      }
    }
    return { ok: true };
  }

  private async onCall(call: any, name?: string) {
    const who = `${name ? name + ' ' : ''}(${call.from ?? 'número oculto'})`;
    if (call.event === 'connect') {
      this.log.log(`llamada entrante ${call.id} de ${who}; oferta SDP de ${String(call.session?.sdp ?? '').length} caracteres`);
      void this.leads.telegram(`📞 Llamada de WhatsApp entrante de ${who}.\nEtapa 1: el avatar aún no contesta; la llamada se rechaza.`);
      const err = await this.callAction(call.id, 'reject');
      this.log.log(err ? `no se pudo rechazar ${call.id}: ${err}` : `llamada ${call.id} rechazada`);
    } else if (call.event === 'terminate') {
      this.log.log(`llamada ${call.id} terminada: ${call.status ?? 'sin estado'}${call.duration ? `, ${call.duration} s` : ''}`);
    }
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
