import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';

/** Un ajuste que se cambia desde el panel: su tipo, su valor de fabrica y, si es numero, sus limites. */
export type SettingDef = { label: string; group: string; hint?: string } & ({ type: 'number'; def: number; min: number; max: number } | { type: 'boolean'; def: boolean }
  /** Texto corto con formato fijo (un horario, una lista de telefonos): solo se guarda si cumple `pattern`. */
  | { type: 'text'; def: string; pattern: RegExp; max: number; example: string });

/**
 * Ajustes editables desde el panel (pesos, umbrales, interruptores), guardados por negocio en la tabla `settings`.
 * Solo existen los ajustes que un modulo registra con `define()`: el panel no puede crear claves nuevas ni salirse de los
 * limites de cada una. Se leen en memoria (un ajuste se consulta en cada decision) y cada cambio va a la base.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly log = new Logger(SettingsService.name);
  private readonly defs = new Map<string, SettingDef>();
  private readonly values = new Map<string, string>();
  constructor(private readonly cfg: ConfigService, private readonly db: DbService) {}

  async onModuleInit() {
    try { for (const r of await this.db.query<{ key: string; value: string }>('SELECT key, value FROM settings WHERE business = $1', [this.cfg.businessId])) this.values.set(r.key, r.value); }
    catch (e) { this.log.warn(`no se pudieron leer los ajustes: ${(e as Error).message}`); }
  }

  define(key: string, def: SettingDef) { this.defs.set(key, def); }
  number(key: string): number { const d = this.defs.get(key), v = Number(this.values.get(key)); return d?.type === 'number' ? (this.values.has(key) && Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.def) : 0; }
  boolean(key: string): boolean { const d = this.defs.get(key); return d?.type === 'boolean' ? (this.values.has(key) ? this.values.get(key) === '1' : d.def) : false; }

  text(key: string): string { const d = this.defs.get(key); return d?.type === 'text' ? (this.values.has(key) && d.pattern.test(this.values.get(key)!) ? this.values.get(key)! : d.def) : ''; }

  /** Todos los ajustes con su valor actual, para el panel. */
  list() { return [...this.defs.entries()].map(([key, d]) => ({ key, ...d, pattern: undefined, value: d.type === 'number' ? this.number(key) : d.type === 'boolean' ? this.boolean(key) : this.text(key), changed: this.values.has(key) })); }

  /** Cambia un ajuste. Devuelve '' o por que no se cambio. */
  async set(key: string, value: unknown): Promise<string> {
    const d = this.defs.get(key);
    if (!d) return 'ese ajuste no existe';
    let stored: string;
    if (d.type === 'boolean') { if (typeof value !== 'boolean') return 'debe ser verdadero o falso'; stored = value ? '1' : '0'; }
    else if (d.type === 'text') { const v = typeof value === 'string' ? value.trim() : null; if (v === null || v.length > d.max || !d.pattern.test(v)) return `formato no válido; ejemplo: ${d.example}`; stored = v; }
    else { const v = Number(value); if (typeof value !== 'number' || !Number.isFinite(v) || v < d.min || v > d.max) return `debe ser un número entre ${d.min} y ${d.max}`; stored = String(v); }
    await this.db.query('INSERT INTO settings (business, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (business, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [this.cfg.businessId, key, stored, new Date().toISOString()]);
    this.values.set(key, stored);
    return '';
  }
}
