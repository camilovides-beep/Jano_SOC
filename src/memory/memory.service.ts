import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';

export interface VisitorMemory { name: string; summary: string; visits: number; updated_at: string; }
const ID = /^[a-f0-9-]{16,40}$/;

/**
 * Memoria de visitantes: el navegador guarda un identificador al azar y el servidor recuerda el nombre y un resumen de
 * la ultima conversacion, para reconocer a quien vuelve. Se olvida a los VISITOR_MEMORY_DAYS dias.
 * No usar en un kiosco compartido (alli todas las personas comparten navegador): la pagina lo desactiva con ?kiosco=1.
 */
@Injectable()
export class MemoryService {
  private readonly log = new Logger(MemoryService.name);
  constructor(private readonly cfg: ConfigService, private readonly db: DbService) {}
  get enabled() { return this.cfg.visitorMemoryDays > 0; }
  valid(id: unknown): id is string { return typeof id === 'string' && ID.test(id); }

  async get(id: string): Promise<VisitorMemory | null> {
    if (!this.enabled) return null;
    try {
      const limit = new Date(Date.now() - this.cfg.visitorMemoryDays * 86_400_000).toISOString();
      await this.db.query('DELETE FROM visitors WHERE updated_at < $1', [limit]);
      return (await this.db.query<VisitorMemory>('SELECT name, summary, visits, updated_at FROM visitors WHERE id = $1', [id]))[0] ?? null;
    } catch (e) { this.log.warn(`memoria no disponible: ${(e as Error).message}`); return null; } // sin base, la conversacion sigue sin memoria
  }

  async save(id: string, name: string, summary: string) {
    if (!this.enabled) return;
    const prev = await this.get(id);
    await this.db.query(`INSERT INTO visitors (id, name, summary, visits, updated_at) VALUES ($1, $2, $3, 1, $4)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, summary = excluded.summary, visits = visitors.visits + 1, updated_at = excluded.updated_at`,
      [id, (name || prev?.name || '').slice(0, 80), summary.slice(0, 600), new Date().toISOString()]);
    this.log.log(`visitante recordado (${name ? 'con nombre' : 'sin nombre'})`);
  }
}
