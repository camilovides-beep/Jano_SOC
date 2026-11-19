import { Body, Controller, Get, Header, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { SecurityAlertsService } from './security-alerts.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const HOUR = 3600_000;

/**
 * Alertas de seguridad desde afuera.
 *  - GET /alertas/estado: cuantas hay abiertas, sin ningun detalle. Lo consulta cada pantalla para ponerse roja.
 *  - POST /alertas: webhook para camaras, sensores, alarmas o un detector de intrusos. Exige la cabecera
 *    `X-Alert-Secret` igual a ALERTS_WEBHOOK_SECRET (sin esa variable el webhook no existe). Cuerpo JSON:
 *    { "titulo": "...", "detalle": "...", "severidad": "baja|media|alta|critica", "origen": "cámara entrada" }
 *    (tambien acepta title, detail, severity, origin). Lo que trae es texto de terceros: se guarda como dato.
 */
@Controller('alertas')
export class AlertsController {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly cfg: ConfigService, private readonly alerts: SecurityAlertsService) {}

  @Get('estado')
  @Header('Cache-Control', 'no-store')
  state() { return { active: this.alerts.active }; }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async webhook(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const secret = this.cfg.alertsWebhookSecret;
    if (!secret) throw new HttpException({ ok: false, error: 'desactivado' }, 404);
    const given = Buffer.from(String(req.headers['x-alert-secret'] ?? '')), want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpException({ ok: false, error: 'clave' }, 401);
    const now = Date.now(), ip = ipOf(req), list = (this.hits.get(ip) ?? []).filter((t) => now - t < HOUR);
    if (list.length >= 240) throw new HttpException({ ok: false, error: 'limite' }, 429);
    list.push(now); this.hits.set(ip, list);
    const pick = (...keys: string[]) => keys.map((k) => body?.[k]).find((v) => v !== undefined && v !== null && String(v).trim() !== '');
    const out = await this.alerts.open({ source: 'sistema', title: String(pick('titulo', 'title') ?? ''), detail: String(pick('detalle', 'detail', 'description') ?? ''),
      severity: String(pick('severidad', 'severity') ?? 'media').toLowerCase(), origin: String(pick('origen', 'origin', 'source') ?? '') });
    if (typeof out === 'string') throw new HttpException({ ok: false, error: out }, out.includes('tope') ? 429 : 400);
    return { ok: true, id: out.id, repeated: Number(out.count) > 1 };
  }
}
