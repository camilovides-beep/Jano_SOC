import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigService } from '../config/config.service';

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
  private readonly db: DatabaseSync;
  constructor(private readonly cfg: ConfigService) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(cfg.dataDir, 'leads.db'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', visits INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )`);
  }
  get enabled() { return this.cfg.visitorMemoryDays > 0; }
  valid(id: unknown): id is string { return typeof id === 'string' && ID.test(id); }

  get(id: string): VisitorMemory | null {
    if (!this.enabled) return null;
    const limit = new Date(Date.now() - this.cfg.visitorMemoryDays * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM visitors WHERE updated_at < ?').run(limit);
    return (this.db.prepare('SELECT name, summary, visits, updated_at FROM visitors WHERE id = ?').get(id) as unknown as VisitorMemory) ?? null;
  }

  save(id: string, name: string, summary: string) {
    if (!this.enabled) return;
    const prev = this.get(id);
    this.db.prepare(`INSERT INTO visitors (id, name, summary, visits, updated_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, summary = excluded.summary, visits = visits + 1, updated_at = excluded.updated_at`)
      .run(id, (name || prev?.name || '').slice(0, 80), summary.slice(0, 600), new Date().toISOString());
    this.log.log(`visitante recordado (${name ? 'con nombre' : 'sin nombre'})`);
  }
}
