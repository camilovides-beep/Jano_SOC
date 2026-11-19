import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { DecisionsService } from '../decisions/decisions.service';
import { QUESTIONS } from '../decisions/questions';
import { AlertsService } from '../ops/alerts.service';

export interface OptOut { id: number; contact: string; at: string; source: string; evidence: string; marked_by: string; decision_id: number | null; lifted_at: string }

/** Palabras de rechazo. Sin Jev, solo un texto que traiga alguna se le pregunta al modelo (para no duplicar cada mensaje). */
const HINTS = /\bno me (escrib|llam|contact|busqu|mand|envi|molest|vuelv)|\bno (quiero|deseo) (que me|recibir|mas|más)|\bdej[ae]n? de (escrib|llam|mand|envi|molest)|\bd[eé]j[ae](n|me|nme)? (en paz|tranquil)|\bno me interesa|\bb[oó]rr[ae](n|me|nme)?\b|\bdar(me)? de baja|\bno (más|mas) (mensajes|llamadas)|\bbasta\b|\bstop\b|\bunsubscribe|\bspam\b/i;

/** Identidad de un contacto para comparar: telefono en digitos con indicativo, o correo en minusculas. '' si no sirve. */
export function contactKey(contact: string, defaultCountry: string): string {
  const c = String(contact ?? '').trim().toLowerCase();
  if (c.includes('@')) return c.replace(/\s+/g, '').slice(0, 120);
  const digits = c.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return digits.length === 10 && digits.startsWith('3') ? defaultCountry + digits : digits; // celular colombiano sin indicativo
}

/**
 * "No me contacten" (etapa 1b, pedida por Javier el 2026-11-18). Quien pide no ser contactado queda marcado y el avatar
 * no vuelve a escribirle ni a llamarlo por iniciativa propia, sin excepcion. La marca se COMPRUEBA EN CODIGO con
 * `blocked()` antes de cualquier envio por iniciativa propia; no depende de un prompt ni de la decision de un modelo.
 *  - Detectar: la capa de decisiones, pregunta conservadora (con duda responden los dos proveedores y basta un "si").
 *  - Si esa persona vuelve a escribir, se le responde; lo que no se hace es buscarla.
 *  - La marca solo la quita Javier desde el panel. Nada dicho en una conversacion la quita.
 * Las marcas vigentes se tienen en memoria: `blocked()` es inmediato y no falla si la base tarda.
 */
@Injectable()
export class OptOutService implements OnModuleInit {
  private readonly log = new Logger(OptOutService.name);
  private readonly active = new Set<string>();
  private loaded = false;
  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly decisions: DecisionsService, private readonly alerts: AlertsService) {}

  async onModuleInit() {
    try {
      for (const r of await this.db.query<{ contact: string }>(`SELECT contact FROM optouts WHERE business = $1 AND lifted_at = ''`, [this.cfg.businessId])) this.active.add(r.contact);
      this.loaded = true;
      if (this.active.size) this.log.log(`no contactar: ${this.active.size} contactos marcados`);
    } catch (e) { this.log.error(`no se pudo leer la lista de no contactar: ${(e as Error).message}`); }
  }

  key(contact: string) { return contactKey(contact, this.cfg.whatsappDefaultCountry); }
  /**
   * ¿Esta prohibido buscar a este contacto? Si la lista no se pudo leer al arrancar, la respuesta es SI para todos:
   * ante la duda no se le escribe a nadie por iniciativa propia.
   */
  blocked(contact: string): boolean { const k = this.key(contact); return !this.loaded || (!!k && this.active.has(k)); }

  /** Marca un contacto. Devuelve true si quedo marcado ahora (false si ya lo estaba o el contacto no sirve). */
  async mark(contact: string, source: string, evidence: string, by: 'avatar' | 'javier' = 'avatar', decisionId: number | null = null): Promise<boolean> {
    const k = this.key(contact);
    if (!k || this.active.has(k)) return false;
    this.active.add(k); // primero en memoria: desde ya no se le escribe, aunque la base falle
    try {
      await this.db.query('INSERT INTO optouts (business, contact, at, source, evidence, marked_by, decision_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [this.cfg.businessId, k, new Date().toISOString(), source.slice(0, 40), evidence.replace(/\s+/g, ' ').slice(0, 300), by, decisionId]);
    } catch (e) { this.log.error(`no se pudo guardar la marca de no contactar: ${(e as Error).message}`); }
    this.log.log(`no contactar: contacto marcado (${source}, por ${by})`);
    if (by === 'avatar') void Promise.resolve().then(() => this.alerts.send(`🚫 ${k.includes('@') ? k : '+' + k} pidió no ser contactado (${source}). Ya no le escribiré ni lo llamaré por mi cuenta.\nLo que dijo: «${evidence.replace(/\s+/g, ' ').slice(0, 200)}»\nSi fue un error, quita la marca en el panel, pestaña Interesados.`)).catch(() => undefined); // el aviso no puede impedir la marca
    return true;
  }

  /** Quita una marca (solo desde el panel). */
  async lift(id: number): Promise<boolean> {
    const row = (await this.db.query<{ contact: string }>(`UPDATE optouts SET lifted_at = $1 WHERE id = $2 AND business = $3 AND lifted_at = '' RETURNING contact`, [new Date().toISOString(), id, this.cfg.businessId]))[0];
    if (!row) return false;
    this.active.delete(row.contact);
    return true;
  }
  list(): Promise<OptOut[]> { return this.db.query<OptOut>(`SELECT * FROM optouts WHERE business = $1 AND lifted_at = '' ORDER BY at DESC LIMIT 500`, [this.cfg.businessId]); }

  /**
   * Revisa lo que dijo o escribio una persona y, si pidio no ser contactada, la marca. Corre en segundo plano: no lanza
   * errores y no frena ninguna conversacion. `always` = revisar aunque no haya palabras de rechazo (cierre de la conversacion).
   */
  async check(text: string, contact: string, source: string, always = false): Promise<boolean> {
    try {
      const k = this.key(contact), said = text.trim();
      if (!k || this.active.has(k) || said.length < 2) return false;
      // Con Jev cada mensaje se evalua (es rapido y barato). Sin Jev, solo si trae palabras de rechazo o es el cierre.
      if (!this.decisions.graded && !always && !HINTS.test(said)) return false;
      const d = await this.decisions.decide('no_contactar', said.slice(-3000), QUESTIONS.no_contactar, { subject: source });
      if (d.answers.pidio.value !== true) return false;
      return await this.mark(k, source, said.slice(-300), 'avatar', await d.id);
    } catch (e) { this.log.warn(`no se pudo revisar un posible "no me contacten": ${(e as Error).message}`); return false; }
  }
}
