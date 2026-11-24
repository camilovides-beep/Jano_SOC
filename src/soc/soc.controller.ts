import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { LogsService } from '../logs/logs.service';
import { LogWatchService } from '../logs/log-watch.service';
import { LogDbService } from '../logs/log-db.service';
import { safe, Sev } from '../logs/log-analysis';
import { SiemService, siemSeverity } from '../logs/siem.service';
import { AlertsService } from '../ops/alerts.service';
import { OwnerService } from '../owner/owner.service';
import { ACTION_KINDS, ActionsService } from '../policy/actions.service';
import { ApprovalsService } from '../policy/approvals.service';
import { ALERT_SOURCES, SecurityAlert, SecurityAlertsService, SEVERITIES } from '../security/security-alerts.service';
import { SOC_COOKIE, SocAuthService, SocSession } from './soc-auth.service';

// Detras del proxy, la ultima direccion de X-Forwarded-For la puso el proxy (las anteriores las puede inventar el cliente).
const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const isHttps = (req: Request) => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
const DAY = 86_400_000;
const RANK: Record<string, number> = { baja: 0, media: 1, alta: 2, critica: 3 };
const zero = () => ({ baja: 0, media: 0, alta: 0, critica: 0 }) as Record<Sev, number>;
const get = (o: any, path: string): unknown => o?.[path] ?? path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
const first = (o: any, ...paths: string[]) => { for (const p of paths) { const v = get(o, p); if (v !== undefined && v !== null && v !== '') return Array.isArray(v) ? v[0] : v; } return undefined; };
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
/** Un contacto de la bitacora (telefono o correo) no se muestra completo en la consola. */
const mask = (c: string) => (c.includes('@') ? c.replace(/^(.).*(@.*)$/, '$1•••$2') : c.length > 4 ? `•••${c.slice(-4)}` : c);

/**
 * Consola SOC (public/soc.html): monitoreo de alertas, logs, SIEM, integridad de la bitacora, servicios y accesos.
 * Todo exige la sesion de SocAuthService (usuario y contraseña provisionales; no hay registro). Lo que cambia datos exige
 * ademas la cabecera `X-Requested-With: jano-soc`, que un formulario de otro sitio no puede enviar (CSRF), y la cookie va
 * con SameSite=Strict. Titulos, detalles, lineas de log y nombres de reglas son texto de terceros: salen como datos y la
 * pagina los pinta siempre como texto, nunca como HTML.
 */
@Controller('soc')
export class SocController {
  private chain?: { at: number; value: { ok: boolean; rows: number; brokenAt: number | null } };
  constructor(private readonly cfg: ConfigService, private readonly auth: SocAuthService, private readonly security: SecurityAlertsService, private readonly logs: LogsService,
    private readonly siem: SiemService, private readonly actions: ActionsService, private readonly approvals: ApprovalsService, private readonly services: AlertsService,
    private readonly owner: OwnerService, private readonly db: DbService, private readonly watch: LogWatchService, private readonly logDb: LogDbService) {}

  private cookie(req: Request, value: string, maxAge: number) {
    return `${SOC_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }
  private need(req: Request, touch = true): SocSession {
    const s = this.auth.verify(req.headers.cookie, touch);
    if (!s) throw new HttpException({ error: 'no_autorizado' }, 401);
    return s;
  }
  private csrf(req: Request) { if (req.headers['x-requested-with'] !== 'jano-soc') throw new HttpException({ error: 'peticion_no_permitida' }, 403); }
  private day(d: Date | number) { return new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(d); }
  private async chainState() {
    if (!this.chain || Date.now() - this.chain.at > 60_000) this.chain = { at: Date.now(), value: await this.actions.verify() };
    return this.chain.value;
  }
  private alertOut(a: SecurityAlert) { return { ...a, count: Number(a.count), sourceLabel: ALERT_SOURCES[a.source] ?? a.source }; }

  @Get()
  root(@Res() res: Response) { res.redirect(302, './soc.html'); }

  // ---------- sesion ----------
  @Get('session')
  session(@Req() req: Request) {
    const s = this.auth.verify(req.headers.cookie, false);
    return { enabled: this.auth.enabled, user: s?.user ?? null, expiresAt: s ? new Date(this.auth.expiresAt(s)).toISOString() : null, idleMinutes: this.cfg.socIdleMinutes };
  }

  @Post('login')
  @HttpCode(200)
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { user?: unknown; password?: unknown }) {
    this.csrf(req);
    if (!this.auth.enabled) throw new HttpException({ error: 'desactivado' }, 404);
    if (typeof body?.user !== 'string' || typeof body?.password !== 'string' || body.user.length > 80 || body.password.length > 256) throw new HttpException({ error: 'credenciales' }, 401);
    const out = this.auth.login(body.user, body.password, ipOf(req));
    if ('error' in out) throw new HttpException(out, out.error === 'bloqueado' ? 429 : 401);
    res.setHeader('Set-Cookie', this.cookie(req, out.token, this.auth.maxAgeSeconds));
    return { ok: true, user: out.session.user };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.csrf(req);
    this.auth.logout(req.headers.cookie);
    res.setHeader('Set-Cookie', this.cookie(req, '', 0));
    return { ok: true };
  }

  // ---------- resumen: lo que la pantalla consulta cada pocos segundos ----------
  @Get('overview')
  async overview(@Req() req: Request, @Query('auto') auto?: string) {
    const me = this.need(req, auto !== '1');
    const all = await this.security.list(500), now = Date.now();
    const open = all.filter((a) => a.status === 'abierta');
    const bySeverity = zero(); for (const a of open) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    // Alertas abiertas por dia (hora local del negocio), 14 dias, por gravedad.
    const days = Array.from({ length: 14 }, (_, i) => ({ day: this.day(now - (13 - i) * DAY), ...zero() }));
    const byDay = new Map(days.map((d) => [d.day, d]));
    const bySource = new Map<string, number>(); let resolved30 = 0; const minutes: number[] = [];
    for (const a of all) {
      const t = Date.parse(a.created_at); if (!Number.isFinite(t)) continue;
      const d = byDay.get(this.day(t)); if (d) d[a.severity] = (d[a.severity] ?? 0) + 1;
      if (now - t > 30 * DAY) continue;
      bySource.set(a.source, (bySource.get(a.source) ?? 0) + 1);
      if (a.status === 'resuelta' && a.resolved_at) { resolved30++; minutes.push(Math.max(0, (Date.parse(a.resolved_at) - t) / 60_000)); }
    }
    minutes.sort((x, y) => x - y);
    const [sources, chain, pending] = await Promise.all([this.logs.sources().catch(() => []), this.chainState(), this.approvals.pending().catch(() => [])]);
    const worst = open.reduce((w, a) => (RANK[a.severity] > RANK[w] ? a.severity : w), 'baja' as string);
    return {
      now: new Date(now).toISOString(), timezone: this.cfg.timezone, user: me.user, expiresAt: new Date(this.auth.expiresAt(me)).toISOString(),
      alerts: {
        active: open.length, worst: open.length ? worst : null, bySeverity, open: open.slice(0, 8).map((a) => this.alertOut(a)), days,
        bySource: Object.entries(ALERT_SOURCES).map(([key, label]) => ({ key, label, count: bySource.get(key) ?? 0 })),
        last30: [...bySource.values()].reduce((x, y) => x + y, 0), resolved30, medianMinutes: minutes.length ? Math.round(minutes[Math.floor((minutes.length - 1) / 2)]) : null,
      },
      channels: [
        { label: 'Webhook de alertas', on: !!this.cfg.alertsWebhookSecret, detail: 'POST /alertas · cámaras, sensores, alarmas, IDS' },
        { label: 'Carpeta de logs', on: !!this.cfg.logsDir, detail: this.cfg.logsDir ? 'montada en solo lectura' : 'LOGS_DIR sin definir' },
        { label: 'Base de datos de logs', on: this.logDb.enabled && !this.logDb.error, detail: !this.logDb.enabled ? 'LOGS_DB_HOST sin definir' : this.logDb.error ? `no responde: ${safe(this.logDb.error, 120)}` : this.logDb.label },
        { label: 'Vigilante de logs', on: this.watch.enabled, detail: this.watch.enabled ? `cada ${this.cfg.logsWatchMinutes} min · alerta desde gravedad ${this.cfg.logsWatchSeverity}` : this.cfg.logsWatchMinutes > 0 ? 'no hay de dónde leer logs' : 'LOGS_WATCH_MINUTES en 0' },
        { label: 'Logs por HTTP', on: !!this.cfg.logsIngestSecret, detail: 'POST /logs/<fuente> · SIEM, Fluent Bit, Vector, n8n' },
        { label: 'Syslog', on: this.cfg.syslogPort > 0, detail: this.cfg.syslogPort > 0 ? `puerto ${this.cfg.syslogPort} UDP y TCP` : 'LOGS_SYSLOG_PORT en 0' },
        { label: 'Consulta al SIEM', on: this.siem.enabled, detail: this.siem.enabled ? this.cfg.siemIndex : 'SIEM_URL sin definir' },
        { label: 'Avisos por Telegram', on: this.services.enabled, detail: 'cada alerta nueva llega al dueño' },
      ],
      services: Object.entries(this.services.status()).map(([name, s]) => ({ name, ok: s.ok, detail: safe(s.detail, 160), since: s.since })),
      integrity: { ...chain, approvals: pending.length },
      watch: this.watch.status(),
      logs: { sources: sources.length, latest: sources[0] ? { name: sources[0].name, mtime: sources[0].mtime.toISOString() } : null },
      access: { devices: this.owner.list().length, sessions: this.auth.active().length, failed24h: this.auth.failedSince(DAY) },
      system: { uptime: Math.round(process.uptime()), db: this.db.kind, voice: this.cfg.ttsProvider },
    };
  }

  // ---------- alertas ----------
  @Get('alerts')
  async alertList(@Req() req: Request) {
    this.need(req);
    return { active: this.security.active, alerts: (await this.security.list(300)).map((a) => this.alertOut(a)), severities: SEVERITIES };
  }
  @Post('alerts')
  async alertAdd(@Req() req: Request, @Body() body: { title?: string; detail?: string; severity?: string; origin?: string }) {
    this.csrf(req); const me = this.need(req);
    const out = await this.security.open({ source: 'manual', title: String(body?.title ?? ''), detail: String(body?.detail ?? ''), severity: String(body?.severity ?? 'media'), origin: String(body?.origin ?? '') || `Consola SOC (${me.user})` });
    if (typeof out === 'string') throw new HttpException({ error: out }, out.includes('tope') ? 429 : 400);
    return { ok: true, alert: this.alertOut(out) };
  }
  @Post('alerts/:id/resolve')
  @HttpCode(200)
  async alertResolve(@Req() req: Request, @Param('id') id: string, @Body() body: { note?: string }) {
    this.csrf(req); const me = this.need(req);
    if (!/^\d{1,9}$/.test(id)) throw new HttpException({ error: 'no existe esa alerta' }, 404);
    const out = await this.security.resolve(Number(id), `soc:${me.user}`, String(body?.note ?? ''));
    if (typeof out === 'string') throw new HttpException({ error: out }, out.startsWith('no existe') ? 404 : 409);
    return { ok: true, alert: this.alertOut(out) };
  }

  // ---------- logs: fuentes, analisis y busqueda (solo lectura) ----------
  /** La fuente se busca por nombre exacto en la lista de archivos reales: lo que llega en la peticion nunca se usa como ruta. */
  private async source(name: unknown) {
    const src = (await this.logs.sources()).find((s) => s.name === String(name ?? ''));
    if (!src) throw new HttpException({ error: 'no existe esa fuente de logs' }, 404);
    return src;
  }
  @Get('logs')
  async logSources(@Req() req: Request) {
    this.need(req);
    return { enabled: this.logs.enabled, receiving: this.logs.receiving, maxMb: this.cfg.logsMaxMb, watch: this.watch.status(), dbError: this.logDb.enabled ? safe(this.logDb.error, 160) : '', sources: (await this.logs.sources()).map((s) => ({ name: s.name, size: s.size, rows: s.db?.rows ?? null, mtime: s.mtime.toISOString() })) };
  }
  /** Pasada del vigilante a pedido (la misma que corre sola cada LOGS_WATCH_MINUTES). */
  @Post('logs/watch')
  async logWatch(@Req() req: Request) {
    this.csrf(req); this.need(req);
    if (!this.watch.enabled) throw new HttpException({ error: 'el vigilante de logs está apagado' }, 409);
    return { pass: await this.watch.run() };
  }
  @Get('logs/analyze')
  async logAnalyze(@Req() req: Request, @Query('name') name?: string) {
    this.need(req);
    const src = await this.source(name);
    try { const a = await this.logs.analyze(src); return { name: src.name, ...a, findings: [...a.findings].sort((x, y) => RANK[y.severity] - RANK[x.severity]) }; }
    catch (e) { throw new HttpException({ error: (e as Error).message.slice(0, 200) }, 422); }
  }
  @Get('logs/search')
  async logSearch(@Req() req: Request, @Query('name') name?: string, @Query('q') q?: string) {
    this.need(req);
    const text = String(q ?? '').trim().slice(0, 80);
    if (text.length < 2) throw new HttpException({ error: 'escribe al menos 2 caracteres' }, 400);
    const src = await this.source(name);
    try { return { name: src.name, q: text, ...(await this.logs.search(src, text, 60)) }; }
    catch (e) { throw new HttpException({ error: (e as Error).message.slice(0, 200) }, 422); }
  }

  // ---------- SIEM: resumen de los eventos recientes ----------
  @Get('siem')
  async siemView(@Req() req: Request, @Query('hours') hours?: string, @Query('q') q?: string) {
    this.need(req);
    const h = Math.min(168, Math.max(1, Math.round(Number(hours)) || 24));
    if (!this.siem.enabled) return { enabled: false, hours: h };
    try {
      const { total, docs } = await this.siem.search(h, String(q ?? '').slice(0, 200));
      const bySeverity = zero(), hosts = new Map<string, number>(), srcs = new Map<string, number>(), rules = new Map<string, { count: number; severity: Sev }>();
      for (const d of docs) {
        const s = siemSeverity(d), name = safe(first(d, 'rule.description', 'rule.name', 'alert.signature', 'kibana.alert.rule.name', 'signal.rule.name', 'event.action', 'message', 'full_log') ?? 'evento sin nombre', 90);
        const host = safe(first(d, 'agent.name', 'host.name', 'host.hostname', 'observer.name', 'host') ?? '', 40), src = safe(first(d, 'data.srcip', 'source.ip', 'src_ip', 'data.src_ip', 'client.ip') ?? '', 45);
        bySeverity[s]++;
        if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
        if (src) srcs.set(src, (srcs.get(src) ?? 0) + 1);
        const r = rules.get(name) ?? { count: 0, severity: s }; r.count++; if (RANK[s] > RANK[r.severity]) r.severity = s; rules.set(name, r);
      }
      return { enabled: true, hours: h, total, sampled: docs.length, bySeverity, hosts: top(hosts, 8), origins: top(srcs, 8),
        rules: [...rules.entries()].map(([name, r]) => ({ name, ...r })).sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.count - a.count).slice(0, 15) };
    } catch (e) { return { enabled: true, hours: h, error: safe((e as Error).message, 200) }; }
  }

  // ---------- integridad: bitacora encadenada de lo que Jano hizo por su cuenta ----------
  @Get('actions')
  async actionLog(@Req() req: Request) {
    this.need(req);
    const rows = await this.actions.list({ days: 30, limit: 100 });
    return { chain: await this.actions.verify(), approvals: (await this.approvals.pending()).length,
      actions: rows.map((r) => ({ id: r.id, at: r.at, kind: (ACTION_KINDS as Record<string, { label: string }>)[r.kind]?.label ?? r.kind, channel: r.channel, contact: mask(String(r.contact ?? '')), status: r.status, reason: r.reason, simulated: !!Number(r.simulated) })) };
  }

  // ---------- accesos: dispositivos del dueño, sesiones de la consola e intentos de ingreso ----------
  @Get('access')
  access(@Req() req: Request) {
    const me = this.need(req);
    return {
      devices: this.owner.list().map((d) => ({ name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen })),
      sessions: this.auth.active().map((s) => ({ user: s.user, ip: s.ip, createdAt: new Date(s.createdAt).toISOString(), lastSeen: new Date(s.lastSeen).toISOString(), expiresAt: new Date(this.auth.expiresAt(s)).toISOString(), current: s.id === me.id })),
      events: this.auth.recent(),
    };
  }
}
