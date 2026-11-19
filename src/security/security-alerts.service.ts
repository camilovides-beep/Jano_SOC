import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { LeadsService } from '../leads/leads.service';

/** De donde vino la alerta. */
export const ALERT_SOURCES = { sistema: 'Sistema externo', conversacion: 'Reporte en conversación', manipulacion: 'Intento de manipulación', manual: 'Creada por el dueño' } as const;
export type AlertSource = keyof typeof ALERT_SOURCES;
export const SEVERITIES = ['baja', 'media', 'alta', 'critica'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface SecurityAlert {
  id: number; created_at: string; updated_at: string; source: AlertSource; origin: string; severity: Severity; title: string; detail: string;
  count: number; status: 'abierta' | 'resuelta'; resolved_at: string; resolved_by: string; resolution: string;
}
export interface NewAlert { source: AlertSource; origin?: string; severity?: string; title: string; detail?: string; }
/** Lo que se avisa a quien escucha (las pantallas y el modo dueño) cada vez que algo cambia. */
export interface AlertChange { kind: 'abierta' | 'repetida' | 'resuelta'; alert: SecurityAlert; active: number; }

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const HOUR = 3600_000;

/**
 * Alertas de seguridad (pedido por Camilo el 2026-11-19). Mientras haya alguna abierta, el avatar se pone rojo en todas
 * las pantallas (ojos, llama y cresta) y vuelve al azul cuando se marcan todas como resueltas.
 * Se abren desde cuatro lugares: un sistema externo (camaras, sensores, un detector de intrusos) por el webhook con clave,
 * un incidente real que alguien le cuenta al avatar, un intento de darle ordenes ocultas a la IA, o el dueño a mano.
 * Solo el dueño las resuelve (panel o voz en modo dueño). Lo que traen titulo y detalle lo escribio alguien de fuera: es
 * informacion, nunca instrucciones, y al modelo le llega envuelto como datos de terceros.
 *  - Una alerta igual (mismo origen, misma fuente y mismo titulo) que siga abierta no se duplica: suma una repeticion.
 *  - Tope de alertas nuevas por hora y por fuente, para que nadie pueda inundar el panel ni Telegram.
 */
@Injectable()
export class SecurityAlertsService implements OnApplicationBootstrap {
  private readonly log = new Logger(SecurityAlertsService.name);
  private readonly listeners: ((c: AlertChange) => void)[] = [];
  private readonly recent = new Map<string, number[]>(); // fuente -> momentos en que se abrio una alerta nueva
  private activeCache = 0;
  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly leads: LeadsService) {}
  async onApplicationBootstrap() { await this.refresh().catch((e) => this.log.warn(`no se pudieron contar las alertas abiertas: ${(e as Error).message}`)); }

  /** Avisa de cada cambio (las pantallas cambian de color; el dueño lo oye). */
  onChange(fn: (c: AlertChange) => void) { this.listeners.push(fn); }
  /** Cuantas hay abiertas (en memoria: lo consulta cada pantalla cada pocos segundos). */
  get active() { return this.activeCache; }
  private async refresh() { this.activeCache = Number((await this.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM security_alerts WHERE business = $1 AND status = 'abierta'", [this.cfg.businessId]))[0]?.n ?? 0); return this.activeCache; }
  private emit(kind: AlertChange['kind'], alert: SecurityAlert) {
    for (const fn of this.listeners) try { fn({ kind, alert, active: this.activeCache }); } catch (e) { this.log.warn(`aviso de alerta: ${(e as Error).message}`); }
  }
  private allowed(source: AlertSource): boolean {
    const max = { sistema: 60, conversacion: 6, manipulacion: 6, manual: 30 }[source], now = Date.now();
    const list = (this.recent.get(source) ?? []).filter((t) => now - t < HOUR);
    if (list.length >= max) { this.recent.set(source, list); return false; }
    list.push(now); this.recent.set(source, list); return true;
  }

  /** Abre una alerta (o suma una repeticion a una igual que siga abierta). Devuelve la alerta, o un texto si no se abrio. */
  async open(input: NewAlert): Promise<SecurityAlert | string> {
    const source = input.source in ALERT_SOURCES ? input.source : 'manual';
    const title = clip(input.title, 140), detail = clip(input.detail, 1500), origin = clip(input.origin, 120);
    const severity: Severity = (SEVERITIES as readonly string[]).includes(String(input.severity)) ? (input.severity as Severity) : 'media';
    if (title.length < 3) return 'falta un título para la alerta';
    const now = new Date().toISOString();
    const same = (await this.db.query<SecurityAlert>("SELECT * FROM security_alerts WHERE business = $1 AND status = 'abierta' AND source = $2 AND origin = $3 AND title = $4 ORDER BY id DESC LIMIT 1",
      [this.cfg.businessId, source, origin, title]))[0];
    if (same) {
      const rank = (s: string) => SEVERITIES.indexOf(s as Severity), sev = rank(severity) > rank(same.severity) ? severity : same.severity;
      await this.db.query('UPDATE security_alerts SET count = $1, updated_at = $2, severity = $3, detail = $4 WHERE id = $5', [Number(same.count) + 1, now, sev, detail || same.detail, same.id]);
      const a = { ...same, count: Number(same.count) + 1, updated_at: now, severity: sev, detail: detail || same.detail };
      this.emit('repetida', a);
      return a;
    }
    if (!this.allowed(source)) { this.log.warn(`alerta descartada por el tope de ${source}: ${title}`); return 'se alcanzó el tope de alertas nuevas de esta fuente por hora'; }
    const [row] = await this.db.query<SecurityAlert>(
      "INSERT INTO security_alerts (business, created_at, updated_at, source, origin, severity, title, detail, count, status, resolved_at, resolved_by, resolution) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'abierta', '', '', '') RETURNING *",
      [this.cfg.businessId, now, now, source, origin, severity, title, detail]);
    await this.refresh();
    this.log.warn(`alerta #${row.id} abierta (${source}, ${severity}): ${title}`);
    this.emit('abierta', row);
    const icon = { baja: '🟡', media: '🟠', alta: '🔴', critica: '🚨' }[severity];
    void this.leads.telegram(`${icon} Alerta de seguridad #${row.id} (${severity}) · ${ALERT_SOURCES[source]}${origin ? ` · ${origin}` : ''}\n${title}${detail ? `\n${detail.slice(0, 600)}` : ''}\nSe resuelve desde el panel, pestaña Alertas.`)
      .catch(() => undefined);
    return row;
  }

  /** Marca una alerta como resuelta. `by`: panel | voz. Devuelve la alerta o un texto si no se pudo. */
  async resolve(id: number, by: string, note = ''): Promise<SecurityAlert | string> {
    const a = await this.get(id);
    if (!a) return 'no existe esa alerta';
    if (a.status === 'resuelta') return 'esa alerta ya estaba resuelta';
    const now = new Date().toISOString(), resolution = clip(note, 600);
    await this.db.query("UPDATE security_alerts SET status = 'resuelta', resolved_at = $1, resolved_by = $2, resolution = $3, updated_at = $4 WHERE id = $5", [now, clip(by, 20), resolution, now, id]);
    await this.refresh();
    const done = { ...a, status: 'resuelta' as const, resolved_at: now, resolved_by: by, resolution };
    this.log.log(`alerta #${id} resuelta (${by})`);
    this.emit('resuelta', done);
    return done;
  }

  async get(id: number): Promise<SecurityAlert | undefined> {
    return (await this.db.query<SecurityAlert>('SELECT * FROM security_alerts WHERE business = $1 AND id = $2', [this.cfg.businessId, id]))[0];
  }
  /** Las abiertas primero y luego las mas recientes. */
  list(limit = 100, status = ''): Promise<SecurityAlert[]> {
    const where = status === 'abierta' || status === 'resuelta' ? ` AND status = '${status}'` : '';
    return this.db.query<SecurityAlert>(`SELECT * FROM security_alerts WHERE business = $1${where} ORDER BY CASE WHEN status = 'abierta' THEN 0 ELSE 1 END, id DESC LIMIT $2`,
      [this.cfg.businessId, Math.min(500, Math.max(1, limit))]);
  }
  /** Una frase para el modelo con las alertas abiertas (resumen del dia, "¿hay alertas?"). */
  async brief(): Promise<string> {
    const open = await this.list(10, 'abierta');
    if (!open.length) return 'Alertas de seguridad: ninguna abierta.';
    return `Alertas de seguridad abiertas (${open.length}): ` + open.map((a) => `#${a.id} ${a.severity}, ${ALERT_SOURCES[a.source] ?? a.source}${a.origin ? ` (${a.origin})` : ''}: ${a.title}${Number(a.count) > 1 ? ` (se repitió ${a.count} veces)` : ''}`).join(' | ');
  }
}
