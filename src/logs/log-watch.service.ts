import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '../config/config.service';
import { SecurityAlertsService } from '../security/security-alerts.service';
import { Analysis, Finding, Sev } from './log-analysis';
import { LogsService, LogSource } from './logs.service';

/** Lo que se recuerda de un hallazgo: la alerta que abrio y, si ya se resolvio, hasta que byte del archivo quedo atendido. */
interface KeyState { alert: number; severity: Sev; base?: number; }
interface SourceState { size: number; mtime: number; seen: number; keys: Record<string, KeyState>; }
export interface WatchPass { at: string; ms: number; sources: number; checked: number; opened: number; updated: number; errors: string[]; }

const RANK: Record<Sev, number> = { baja: 0, media: 1, alta: 2, critica: 3 };
/** Copias rotadas o comprimidas: ya se vigilaron cuando eran el archivo vivo. */
const ROTATED = /\.gz$|\.\d+$/i;
const FORGET_MS = 7 * 24 * 3600_000, FIRST_PASS_MS = 30_000;
export const findingKey = (f: Finding) => (f.subject ? `${f.rule}:${f.subject}` : f.rule);

/**
 * Vigilante de logs (pedido por Camilo el 2026-11-24): cada LOGS_WATCH_MINUTES analiza las fuentes que cambiaron y abre
 * una alerta de seguridad por cada hallazgo de gravedad LOGS_WATCH_SEVERITY o mas. Sin esto el analisis solo corria
 * cuando alguien lo pedia. Reglas para no repetir alertas:
 *  - Un hallazgo es "el mismo" por fuente + regla (+ direccion, si la regla da uno por direccion); el titulo cambia con los conteos.
 *  - Mientras su alerta siga abierta se actualiza en sitio (titulo, detalle y gravedad si sube); no se abre otra.
 *  - Cuando alguien la resuelve, lo que ya estaba en el archivo queda atendido: solo se vuelve a alertar si la regla salta
 *    otra vez mirando unicamente lo escrito despues. Una captura .pcap que cambia cuenta como nueva entera.
 *  - Un archivo que no cambio desde la pasada anterior no se vuelve a leer.
 * Lo que se recuerda vive en DATA_DIR/log-watch.json para que un reinicio no duplique ni reabra alertas.
 */
@Injectable()
export class LogWatchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(LogWatchService.name);
  private readonly file: string;
  private state: Record<string, SourceState> = {};
  private loaded = false;
  private running?: Promise<WatchPass>;
  private timers: NodeJS.Timeout[] = [];
  private last?: WatchPass;
  private openedTotal = 0;
  constructor(private readonly cfg: ConfigService, private readonly logs: LogsService, private readonly alerts: SecurityAlertsService) { this.file = join(cfg.dataDir, 'log-watch.json'); }

  get enabled() { return this.cfg.logsWatchMinutes > 0 && this.logs.enabled; }
  onApplicationBootstrap() {
    if (!this.enabled) return;
    const tick = () => void this.run().catch((e) => this.log.warn(`pasada del vigilante: ${(e as Error).message}`));
    const first = setTimeout(tick, FIRST_PASS_MS), every = setInterval(tick, this.cfg.logsWatchMinutes * 60_000);
    first.unref(); every.unref(); this.timers = [first, every];
    this.log.log(`vigilante de logs: cada ${this.cfg.logsWatchMinutes} min, alerta desde gravedad ${this.cfg.logsWatchSeverity}`);
  }
  onModuleDestroy() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } }

  status() {
    return { enabled: this.enabled, minutes: this.cfg.logsWatchMinutes, severity: this.cfg.logsWatchSeverity, last: this.last ?? null, openedSinceStart: this.openedTotal,
      watching: Object.values(this.state).reduce((n, s) => n + Object.values(s.keys).filter((k) => k.alert > 0).length, 0) };
  }

  /** Una pasada. Si ya hay una en curso se devuelve esa: nunca corren dos a la vez. */
  run(): Promise<WatchPass> {
    this.running ??= this.pass().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async load() {
    if (this.loaded) return;
    try { const raw = JSON.parse(await readFile(this.file, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.state = raw; } catch { /* primera vez o archivo dañado: se empieza de cero */ }
    this.loaded = true;
  }
  private async save() {
    await mkdir(this.cfg.dataDir, { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.state));
    await rename(`${this.file}.tmp`, this.file);
  }

  private async pass(): Promise<WatchPass> {
    await this.load();
    const started = Date.now(), min = RANK[this.cfg.logsWatchSeverity], errors: string[] = [];
    const sources = (await this.logs.sources()).filter((s) => !ROTATED.test(s.name));
    let checked = 0, opened = 0, updated = 0;
    for (const src of sources) {
      const st = (this.state[src.name] ??= { size: 0, mtime: 0, seen: started, keys: {} });
      st.seen = started;
      if (st.size === src.size && st.mtime === src.mtime.getTime()) continue;
      checked++;
      try {
        const r = await this.review(src, st, min);
        opened += r.opened; updated += r.updated;
        // Si una alerta no se pudo abrir (tope por hora), el archivo queda pendiente para la pasada siguiente.
        if (r.pending) errors.push(`${src.name}: ${r.pending}`); else { st.size = src.size; st.mtime = src.mtime.getTime(); }
      } catch (e) { errors.push(`${src.name}: ${(e as Error).message}`); st.size = src.size; st.mtime = src.mtime.getTime(); }
    }
    for (const [name, st] of Object.entries(this.state)) if (started - st.seen > FORGET_MS) delete this.state[name];
    await this.save().catch((e) => errors.push(`no se pudo guardar el estado: ${(e as Error).message}`));
    this.openedTotal += opened;
    this.last = { at: new Date(started).toISOString(), ms: Date.now() - started, sources: sources.length, checked, opened, updated, errors: errors.slice(0, 5) };
    if (opened || errors.length) this.log.warn(`vigilante de logs: ${checked} fuentes revisadas, ${opened} alertas nuevas, ${updated} actualizadas${errors.length ? `; ${errors[0]}` : ''}`);
    return this.last;
  }

  private async review(src: LogSource, st: SourceState, min: number): Promise<{ opened: number; updated: number; pending: string }> {
    const full = await this.logs.analyze(src), prevSize = st.size, origin = `Logs: ${src.name}`;
    const later = new Map<number, Promise<Analysis>>(); // analisis de lo escrito despues de un punto, uno por punto
    let opened = 0, updated = 0, pending = '';
    for (const f of full.findings) {
      if (RANK[f.severity] < min) continue;
      const key = findingKey(f);
      let k: KeyState | undefined = st.keys[key], found: Finding | undefined = f;
      if (k && k.alert > 0) {
        const a = await this.alerts.get(k.alert);
        if (a?.status === 'abierta') {
          if (await this.alerts.refreshOpen(a.id, f)) updated++;
          if (RANK[f.severity] > RANK[k.severity]) k.severity = f.severity;
          continue;
        }
        // La resolvieron: todo lo que habia en el archivo en la pasada anterior queda atendido.
        k = st.keys[key] = { alert: 0, severity: k.severity, base: prevSize };
      }
      if (k && k.base !== undefined) {
        if (src.size < k.base || /\.(pcap|cap)$/i.test(src.name)) k.base = 0; // el archivo roto o es una captura nueva
        if (k.base > 0) {
          const base = k.base;
          if (!later.has(base)) later.set(base, this.logs.analyze(src, base));
          found = (await later.get(base)!).findings.find((x) => findingKey(x) === key && RANK[x.severity] >= min);
        }
      }
      if (!found) continue;
      const out = await this.alerts.open({ source: 'sistema', origin, severity: found.severity, title: found.title, detail: found.detail });
      if (typeof out === 'string') { pending = out; continue; }
      st.keys[key] = { alert: out.id, severity: found.severity };
      opened++;
    }
    return { opened, updated, pending };
  }
}
