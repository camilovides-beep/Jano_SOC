import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { INTERESTS, LeadsService } from '../leads/leads.service';

/** Una conversacion publica terminada. Los campos de texto son un resumen: no hay transcripcion ni datos de contacto. */
export interface Visit {
  id: number; at: string; kind: string; seconds: number; turns: number;
  interested: number; demo_offered: number; demo_done: number; lead: number; cases: number;
  interest: string; summary: string; asked: string; objections: string;
}
export interface NewVisit {
  kind: 'sitio' | 'llamada'; seconds: number; turns: number; interested: boolean; demoOffered: boolean; demoDone: boolean;
  leads: number[];   // numeros de los interesados que se registraron en la conversacion
  cases: boolean;    // se le conto algun caso del portafolio con la herramienta
  interest?: string; summary?: string; asked?: string[]; objections?: string[];
}
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v : []).map((x) => clip(x, 160)).filter(Boolean).slice(0, max);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/**
 * Visitas (pedido por Javier el 2026-11-18): al cerrar cada conversacion publica se guarda una fila con lo que paso
 * (¿mostro interes?, ¿se le ofrecio la demostracion?, ¿la hizo?, ¿dejo datos?) y un resumen. De ahi salen el informe que
 * llega por Telegram cuando hubo interes y el embudo del panel. Decision de Javier: solo el resumen, sin transcripcion.
 */
@Injectable()
export class VisitsService {
  private readonly log = new Logger(VisitsService.name);
  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly leads: LeadsService) {}

  /** Guarda la visita y, si mostro interes, le envia el informe a Javier por Telegram. */
  async add(v: NewVisit): Promise<void> {
    try {
      const interest = INTERESTS.includes(v.interest as any) ? v.interest! : '';
      const asked = list(v.asked, 4), objections = list(v.objections, 3), summary = clip(v.summary, 600);
      await this.db.query('INSERT INTO visits (at, kind, seconds, turns, interested, demo_offered, demo_done, lead, cases, interest, summary, asked, objections) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        [new Date().toISOString(), v.kind, Math.round(v.seconds), v.turns, v.interested ? 1 : 0, v.demoOffered ? 1 : 0, v.demoDone ? 1 : 0, v.leads.length ? 1 : 0, v.cases ? 1 : 0, interest, summary, asked.join(' | '), objections.join(' | ')]);
      if (!v.interested || !this.cfg.visitReports) return;
      const err = await this.leads.telegram(this.report({ ...v, interest, summary, asked, objections }));
      if (err && err !== 'Telegram no está configurado') this.log.warn(`informe de visita: ${err}`);
    } catch (e) { this.log.warn(`no se pudo guardar la visita: ${(e as Error).message}`); }
  }

  /** Texto del informe de una visita con interes. */
  report(v: NewVisit): string {
    const time = v.seconds < 90 ? `${Math.round(v.seconds)} s` : `${Math.round(v.seconds / 60)} min`;
    return [
      `🧾 Informe de visita (${v.kind === 'llamada' ? 'llamada de WhatsApp' : 'sitio'} · ${time} · ${v.turns} ${v.turns === 1 ? 'intervención' : 'intervenciones'})`,
      v.summary ? `📝 ${v.summary}` : '',
      v.asked?.length ? `❓ Preguntó: ${v.asked.join('; ')}` : '',
      v.objections?.length ? `🤔 Dudas u objeciones: ${v.objections.join('; ')}` : '',
      v.interest ? `🧩 Interés: ${v.interest.replaceAll('_', ' ')}` : '',
      `🎬 Demostración: ${v.demoDone ? 'la hizo' : v.demoOffered ? 'se le ofreció y no la tomó' : 'no se le ofreció'}${v.cases ? ' · se le contó un caso del portafolio' : ''}`,
      v.leads.length ? `📇 Dejó sus datos: sí (interesado ${v.leads.map((id) => '#' + id).join(', ')})` : '📇 Dejó sus datos: no',
    ].filter(Boolean).join('\n');
  }

  list(limit = 200): Promise<Visit[]> { return this.db.query<Visit>('SELECT * FROM visits ORDER BY at DESC LIMIT $1', [Math.min(500, Math.max(1, limit))]); }
  async remove(id: number): Promise<boolean> { return (await this.db.query('DELETE FROM visits WHERE id = $1 RETURNING id', [id])).length > 0; }

  /**
   * Embudo de los ultimos `days` dias. Los pasos no son estrictamente uno dentro de otro (alguien puede dejar datos sin
   * hacer la demostracion), por eso ademas se compara cuantos dejan datos con y sin demostracion, y con y sin caso contado.
   */
  async funnel(days = 30) {
    const rows = await this.db.query<Visit>('SELECT interested, demo_offered, demo_done, lead, cases, interest, kind FROM visits WHERE at >= $1', [new Date(Date.now() - days * 86_400_000).toISOString()]);
    const on = (v: unknown) => Number(v) > 0, count = (f: (r: Visit) => boolean) => rows.filter(f).length;
    const split = (f: (r: Visit) => boolean) => { const a = rows.filter((r) => on(r.interested) && f(r)), b = rows.filter((r) => on(r.interested) && !f(r)); return { withN: a.length, withLeads: a.filter((r) => on(r.lead)).length, withoutN: b.length, withoutLeads: b.filter((r) => on(r.lead)).length }; };
    const interests: Record<string, { n: number; leads: number }> = {};
    for (const r of rows) if (on(r.interested) && r.interest) { const i = (interests[r.interest] ??= { n: 0, leads: 0 }); i.n++; if (on(r.lead)) i.leads++; }
    return {
      days, conversations: rows.length, calls: count((r) => r.kind === 'llamada'), interested: count((r) => on(r.interested)), demoOffered: count((r) => on(r.demo_offered)), demoDone: count((r) => on(r.demo_done)), leads: count((r) => on(r.lead)),
      demo: split((r) => on(r.demo_done)), cases: split((r) => on(r.cases)),
      byInterest: Object.entries(interests).map(([k, v]) => ({ k, ...v })).sort((a, b) => b.n - a.n),
    };
  }

  /** Una frase con las visitas desde una fecha, para el resumen del dia. */
  async brief(sinceIso: string): Promise<string> {
    const rows = await this.db.query<Visit>('SELECT interested, demo_done, lead FROM visits WHERE at >= $1', [sinceIso]);
    if (!rows.length) return 'Conversaciones con visitantes: ninguna registrada.';
    const n = (f: (r: Visit) => boolean) => rows.filter(f).length, interested = n((r) => Number(r.interested) > 0), leads = n((r) => Number(r.lead) > 0);
    return `Conversaciones con visitantes: ${rows.length}; mostraron interés ${interested} (${pct(interested, rows.length)} por ciento), hicieron la demostración ${n((r) => Number(r.demo_done) > 0)} y dejaron sus datos ${leads}.`;
  }
}
