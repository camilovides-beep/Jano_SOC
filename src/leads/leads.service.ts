import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigService } from '../config/config.service';

export const INTERESTS = ['chatbots', 'agentes_de_voz', 'bots_de_whatsapp', 'automatizacion', 'dashboards', 'despliegue_y_servidores', 'desarrollo_de_software', 'otro'] as const;
export const STATUSES = ['nuevo', 'contactado', 'en_conversacion', 'cliente', 'descartado'] as const;

export interface Lead {
  id: number; created_at: string; name: string; contact: string; company: string;
  interest: string; detail: string; status: string; notes: string;
}
export interface NewLead { name: string; contact: string; company?: string; interest: string; detail?: string; }

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Base de datos de personas interesadas en los servicios de Javier (SQLite integrado en Node, sin dependencias).
 * El archivo vive en DATA_DIR (el mismo volumen que los dispositivos), asi sobrevive a los despliegues.
 */
@Injectable()
export class LeadsService {
  private readonly log = new Logger(LeadsService.name);
  private readonly db: DatabaseSync;

  constructor(private readonly cfg: ConfigService) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(cfg.dataDir, 'leads.db'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      interest TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'nuevo',
      notes TEXT NOT NULL DEFAULT ''
    )`);
  }

  add(input: NewLead): Lead {
    const lead = {
      created_at: new Date().toISOString(), name: clip(input.name, 120), contact: clip(input.contact, 160),
      company: clip(input.company, 120), interest: INTERESTS.includes(input.interest as any) ? input.interest : 'otro', detail: clip(input.detail, 800),
    };
    const r = this.db.prepare('INSERT INTO leads (created_at, name, contact, company, interest, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(lead.created_at, lead.name, lead.contact, lead.company, lead.interest, lead.detail);
    const saved = this.get(Number(r.lastInsertRowid))!;
    this.log.log(`interesado #${saved.id} registrado (${saved.interest})`);
    void this.notify(saved);
    return saved;
  }

  get(id: number): Lead | undefined { return this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as Lead | undefined; }
  list(limit = 200): Lead[] { return this.db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT ?').all(limit) as unknown as Lead[]; }
  update(id: number, patch: { status?: string; notes?: string }): boolean {
    const cur = this.get(id); if (!cur) return false;
    const status = STATUSES.includes(patch.status as any) ? patch.status! : cur.status;
    const notes = patch.notes === undefined ? cur.notes : clip(patch.notes, 1000);
    this.db.prepare('UPDATE leads SET status = ?, notes = ? WHERE id = ?').run(status, notes, id);
    return true;
  }
  remove(id: number): boolean { return this.db.prepare('DELETE FROM leads WHERE id = ?').run(id).changes > 0; }

  csv(): string {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cols: (keyof Lead)[] = ['id', 'created_at', 'name', 'contact', 'company', 'interest', 'detail', 'status', 'notes'];
    return [cols.join(','), ...this.list(10_000).map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n');
  }

  /** Aviso opcional (por ejemplo a un flujo de n8n que escriba por WhatsApp o correo). */
  private async notify(lead: Lead) {
    if (!this.cfg.leadsWebhookUrl) return;
    try {
      const res = await fetch(this.cfg.leadsWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'nuevo_interesado', lead }), signal: AbortSignal.timeout(8000) });
      if (!res.ok) this.log.warn(`el aviso de interesado respondió ${res.status}`);
    } catch (e) { this.log.warn(`no se pudo enviar el aviso de interesado: ${(e as Error).message}`); }
  }
}
