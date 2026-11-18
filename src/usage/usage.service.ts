import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigService } from '../config/config.service';

/** Lo que se mide. La unidad va en el nombre: _s segundos, _in/_out/_cache tokens, _chars caracteres, _usd dolares. */
export const USAGE_KEYS = [
  'sesiones', 'sesiones_dueno',
  'deepgram_s', 'deepgram_susp_s', 'deepgram_pre_s',
  'deepseek_calls', 'deepseek_in', 'deepseek_cache', 'deepseek_out', 'deepseek_sin_dato',
  'eleven_calls', 'eleven_chars',
  'nvidia_calls', 'youtube_searches',
  'claude_jobs', 'claude_s', 'claude_turns', 'claude_usd',
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];
export type UsageDay = { day: string } & Partial<Record<UsageKey, number>> & { estimado_usd?: number };

/**
 * Consumo por dia de cada proveedor (pedido por Javier el 2026-11-18: saber adonde se va el gasto antes de optimizar).
 * Se acumula en memoria y se guarda cada 20 s en DATA_DIR/uso.db; asi contar cada trama de audio no escribe en disco.
 * Son medidas propias, no la factura: sirven para comparar dias y ver que pesa mas.
 */
@Injectable()
export class UsageService implements OnModuleDestroy {
  private readonly log = new Logger(UsageService.name);
  private readonly db: DatabaseSync;
  private readonly pending = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private readonly dayFmt: Intl.DateTimeFormat;

  constructor(private readonly cfg: ConfigService) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(cfg.dataDir, 'uso.db'));
    this.db.exec('CREATE TABLE IF NOT EXISTS uso (day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, key))');
    this.dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone });
    this.timer = setInterval(() => this.flush(), 20_000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); this.flush(); }

  add(key: UsageKey, n = 1) {
    if (!Number.isFinite(n) || n <= 0) return;
    const k = `${this.dayFmt.format(new Date())}|${key}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + n);
  }

  flush() {
    if (!this.pending.size) return;
    try {
      const stmt = this.db.prepare('INSERT INTO uso (day, key, value) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET value = value + excluded.value');
      for (const [k, v] of this.pending) { const [day, key] = k.split('|'); stmt.run(day, key, v); }
      this.pending.clear();
    } catch (e) { this.log.warn(`no se pudo guardar el consumo: ${(e as Error).message}`); }
  }

  /** Ultimos `days` dias con datos, del mas reciente al mas antiguo. */
  days(days = 14): UsageDay[] {
    this.flush();
    const since = this.dayFmt.format(new Date(Date.now() - (Math.min(90, Math.max(1, days)) - 1) * 86_400_000));
    const rows = this.db.prepare('SELECT day, key, value FROM uso WHERE day >= ? ORDER BY day DESC').all(since) as { day: string; key: UsageKey; value: number }[];
    const out = new Map<string, UsageDay>();
    for (const r of rows) { const d = out.get(r.day) ?? { day: r.day }; d[r.key] = Math.round(r.value * 100) / 100; out.set(r.day, d); }
    const prices = this.cfg.usagePrices;
    for (const d of out.values()) {
      let usd = 0, any = false;
      for (const [key, price] of Object.entries(prices)) { const v = d[key as UsageKey]; if (v) { usd += v * price; any = true; } }
      if (any) d.estimado_usd = Math.round(usd * 1000) / 1000;
    }
    return [...out.values()];
  }

  /** Un dia contado en una frase, para que el avatar lo diga. */
  describe(d: UsageDay): string {
    const n = (v?: number) => Math.round(v ?? 0).toLocaleString('es-CO'), min = (v?: number) => ((v ?? 0) < 90 ? `${Math.round(v ?? 0)} segundos` : `${Math.round((v ?? 0) / 60)} min`);
    const parts = [`${d.day}: ${n(d.sesiones)} conversaciones`];
    if (d.deepgram_s) parts.push(`escucha (Deepgram) ${min(d.deepgram_s)}${d.deepgram_susp_s ? `, de ellos ${min(d.deepgram_susp_s)} suspendido` : ''}`);
    if (d.deepseek_calls || d.deepseek_sin_dato) {
      const cache = d.deepseek_in ? Math.round(((d.deepseek_cache ?? 0) / d.deepseek_in) * 100) : 0;
      parts.push(`modelo (DeepSeek) ${n((d.deepseek_calls ?? 0) + (d.deepseek_sin_dato ?? 0))} llamadas, ${n(d.deepseek_in)} tokens leídos (${cache} % en caché) y ${n(d.deepseek_out)} escritos` +
        (d.deepseek_sin_dato ? `; ${n(d.deepseek_sin_dato)} llamadas se cortaron sin dato de tokens` : ''));
    }
    if (d.eleven_chars) parts.push(`voz (ElevenLabs) ${n(d.eleven_chars)} caracteres`);
    if (d.nvidia_calls) parts.push(`búsquedas en la base de conocimiento ${n(d.nvidia_calls)}`);
    if (d.youtube_searches) parts.push(`búsquedas de YouTube ${n(d.youtube_searches)}`);
    if (d.claude_jobs) parts.push(`Claude Code ${n(d.claude_jobs)} encargos, ${min(d.claude_s)}${d.claude_usd ? `, equivalente a ${d.claude_usd.toFixed(2)} dólares de API (va por la suscripción)` : ''}`);
    if (d.estimado_usd !== undefined) parts.push(`costo estimado con tus precios ${d.estimado_usd.toFixed(2)} dólares`);
    return parts.join('; ') + '.';
  }
}
