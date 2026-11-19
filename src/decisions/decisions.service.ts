import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { DeepSeekService } from '../llm/deepseek.service';
import { AlertsService } from '../ops/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { UsageService } from '../usage/usage.service';
import { Answer, Answers, DecisionProvider, KindDef, Provider, ProviderResult, Questions, RawAnswer } from './decisions.types';
import { DeepSeekProvider, JevProvider } from './providers';
import { KINDS } from './questions';

export interface DecideOptions { /** A quien o a que se refiere (una sesion, un contacto ya anonimizado). Solo para el registro. */ subject?: string; budgetMs?: number }
export interface Decision<Q extends Questions> { id: Promise<number | null>; answers: Answers<Q>; shadow: boolean; ms: number }

/**
 * Capa de decisiones (etapa 1a, pedida por Javier el 2026-11-18): el unico lugar por donde pasan las decisiones. Quien
 * llama hace preguntas tipadas sobre un estado y recibe respuestas tipadas; nunca sabe quien decidio.
 *  - Con JEV_API_KEY decide Jev y DeepSeek es el respaldo; sin ella decide DeepSeek y no hay respaldo, umbrales ni sombra.
 *  - Umbral por tipo de decision (solo con Jev): si la confianza de una respuesta queda por debajo, esa pregunta se le
 *    repite al respaldo. Lo que nadie responda dentro del presupuesto de tiempo recibe su valor por defecto seguro.
 *  - Modo sombra por tipo (solo con Jev): se decide y se registra, pero quien llama recibe los valores por defecto (el
 *    comportamiento de antes) y el respaldo se consulta aparte, sin prisa, para medir cuanto coinciden.
 *  - `decide` no lanza errores ni espera mas que el presupuesto: una decision nunca bloquea una conversacion.
 * Cada decision queda en la tabla `decisions`. El estado es texto de terceros: aqui solo se evalua, nunca se obedece.
 */
@Injectable()
export class DecisionsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DecisionsService.name);
  private readonly kinds = new Map<string, KindDef>();
  private primary!: DecisionProvider;
  private backup?: DecisionProvider;
  private timer?: NodeJS.Timeout;

  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly llm: DeepSeekService, private readonly usage: UsageService,
    private readonly settings: SettingsService, private readonly alerts: AlertsService) {
    this.useProviders(cfg.jevApiKey ? new JevProvider(cfg, usage) : new DeepSeekProvider(llm), cfg.jevApiKey ? new DeepSeekProvider(llm) : undefined);
    for (const [kind, def] of Object.entries(KINDS)) this.register(kind, def);
  }
  onModuleInit() {
    this.log.log(`decisiones: decide ${this.primary.name === 'jev' ? `Jev (${this.cfg.jevModel}) con respaldo de DeepSeek` : 'DeepSeek (no hay JEV_API_KEY)'}`);
    this.timer = setInterval(() => void this.prune(), 6 * 3_600_000); this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }

  /** Cambia los proveedores (para las pruebas de verificacion). */
  useProviders(primary: DecisionProvider, backup?: DecisionProvider) { this.primary = primary; this.backup = backup; }
  get provider(): Provider { return this.primary.name; }
  /** Umbrales, respaldo y modo sombra solo existen cuando decide Jev. */
  get graded() { return this.primary.name === 'jev'; }

  /** Da de alta un tipo de decision con sus ajustes de fabrica (umbral y sombra se cambian en el panel). */
  register(kind: string, def: KindDef) {
    this.kinds.set(kind, def);
    this.settings.define(`decisiones.umbral.${kind}`, { type: 'number', def: def.threshold, min: 0, max: 1, label: `Confianza mínima: ${def.label}`, group: 'decisiones' });
    this.settings.define(`decisiones.sombra.${kind}`, { type: 'boolean', def: def.shadow, label: `Modo sombra: ${def.label}`, group: 'decisiones' });
  }
  threshold(kind: string) { return this.settings.number(`decisiones.umbral.${kind}`); }
  inShadow(kind: string) { return this.graded && this.settings.boolean(`decisiones.sombra.${kind}`); }

  async decide<Q extends Questions>(kind: string, state: unknown, questions: Q, opts: DecideOptions = {}): Promise<Decision<Q>> {
    const t0 = Date.now(), def = this.kinds.get(kind), budget = opts.budgetMs ?? def?.budgetMs ?? 800, shadow = this.inShadow(kind);
    const ids = Object.keys(questions), raw: Record<string, RawAnswer & { by: Provider; backup: boolean }> = {};
    const deadline = AbortSignal.timeout(budget);
    let error = '', tokens = 0, usedBackup = false, primaryAnswers: Record<string, RawAnswer> = {};
    try {
      const r = await within(this.primary.ask(state, questions, deadline), deadline);
      tokens += r.tokens; primaryAnswers = r.answers;
      for (const id of ids) if (r.answers[id]) raw[id] = { ...r.answers[id], by: this.primary.name, backup: false };
    } catch (e) { error = this.note(this.primary.name, e); }

    // Respaldo: lo que el principal no respondio o respondio con confianza baja. En modo sombra se consulta aparte, sin prisa.
    const weak = !this.backup ? [] : ids.filter((id) => !raw[id] || (raw[id].confidence !== null && raw[id].confidence! < this.threshold(kind)));
    if (weak.length && this.backup && !shadow) {
      try {
        const r = await within(this.backup.ask(state, Object.fromEntries(weak.map((id) => [id, questions[id]])), deadline), deadline);
        tokens += r.tokens;
        for (const id of weak) if (r.answers[id]) { raw[id] = { ...r.answers[id], by: this.backup.name, backup: true }; usedBackup = true; }
      } catch (e) { error ||= this.note(this.backup.name, e); }
    }

    const decided = {} as Record<string, Answer>, effective = {} as Record<string, Answer>;
    let defaulted = false;
    for (const id of ids) {
      decided[id] = raw[id] ?? { value: questions[id].fallback, confidence: null, by: 'defecto', backup: false };
      if (!raw[id]) defaulted = true;
      // En sombra nada cambia para quien llama: recibe el valor por defecto, que es el comportamiento que ya tenia.
      effective[id] = shadow ? { value: questions[id].fallback, confidence: null, by: 'defecto', backup: false } : decided[id];
    }
    const ms = Date.now() - t0;
    this.usage.add('decisiones'); if (defaulted) this.usage.add('decisiones_defecto');
    const row = { kind, subject: opts.subject ?? '', state, decided, usedBackup, defaulted, shadow, ms, tokens, error };
    const id = shadow && this.backup ? this.shadowCompare(row, questions, primaryAnswers) : this.save(row, null);
    return { id, answers: effective as Answers<Q>, shadow, ms };
  }

  /** Modo sombra: el respaldo responde lo mismo, sin limite corto de tiempo, y se anota si coincidieron. */
  private async shadowCompare(row: Row, questions: Questions, primary: Record<string, RawAnswer>): Promise<number | null> {
    let agree: number | null = null, ref: ProviderResult | undefined;
    try { ref = await this.backup!.ask(row.state, questions, AbortSignal.timeout(15_000)); } catch (e) { this.note(this.backup!.name, e); }
    if (ref) {
      const both = Object.keys(questions).filter((id) => primary[id] && ref!.answers[id]);
      if (both.length) agree = both.every((id) => same(questions[id], primary[id].value, ref!.answers[id].value)) ? 1 : 0;
      for (const id of both) (row.decided[id] as any).reference = ref.answers[id].value;
      row.tokens += ref.tokens;
    }
    return this.save(row, agree);
  }

  private note(provider: Provider, e: unknown): string {
    const err = e as Error, msg = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'se pasó del tiempo' : err.message.slice(0, 160);
    if (provider === 'jev') this.alerts.report('Jev (decisiones)', msg); // el aviso sale si falla varias veces seguidas
    return `${provider}: ${msg}`;
  }

  private async save(r: Row, agree: number | null): Promise<number | null> {
    try {
      const state = (typeof r.state === 'string' ? r.state : JSON.stringify(r.state)).replace(/\s+/g, ' ').slice(0, 400);
      const out = await this.db.query<{ id: number }>('INSERT INTO decisions (business, at, kind, subject, state, provider, backup, defaulted, shadow, agree, ms, tokens, detail, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
        [this.cfg.businessId, new Date().toISOString(), r.kind, r.subject.slice(0, 80), state, this.primary.name, r.usedBackup ? 1 : 0, r.defaulted ? 1 : 0, r.shadow ? 1 : 0, agree, r.ms, r.tokens, JSON.stringify(r.decided), r.error]);
      return out[0]?.id ?? null;
    } catch (e) { this.log.warn(`no se pudo registrar una decisión: ${(e as Error).message}`); return null; }
  }

  /** Lo que de verdad paso despues de una decision (por ejemplo que herramienta uso el modelo), para medir aciertos. */
  async outcome(id: Promise<number | null> | number | null, outcome: string) {
    const n = await id; if (!n) return;
    await this.db.query('UPDATE decisions SET outcome = $1 WHERE id = $2 AND business = $3', [outcome.slice(0, 200), n, this.cfg.businessId]).catch(() => undefined);
  }
  /** Revision de Javier: la decision fue correcta ('ok'), incorrecta ('mal') o sin revisar (''). */
  async mark(id: number, mark: string): Promise<boolean> {
    if (!['', 'ok', 'mal'].includes(mark)) return false;
    return (await this.db.query('UPDATE decisions SET mark = $1 WHERE id = $2 AND business = $3 RETURNING id', [mark, id, this.cfg.businessId])).length > 0;
  }

  list(limit = 100, kind = '') {
    const n = Math.min(500, Math.max(1, limit));
    return kind ? this.db.query('SELECT * FROM decisions WHERE business = $1 AND kind = $2 ORDER BY id DESC LIMIT $3', [this.cfg.businessId, kind, n])
      : this.db.query('SELECT * FROM decisions WHERE business = $1 ORDER BY id DESC LIMIT $2', [this.cfg.businessId, n]);
  }

  /** Quien decide y como le ha ido en los ultimos dias, por tipo de decision. Para el panel. */
  async status(days = 7) {
    const rows = await this.db.query<{ kind: string; provider: string; backup: number; defaulted: number; shadow: number; agree: number | null; ms: number; mark: string }>(
      'SELECT kind, provider, backup, defaulted, shadow, agree, ms, mark FROM decisions WHERE business = $1 AND at >= $2', [this.cfg.businessId, new Date(Date.now() - days * 86_400_000).toISOString()]);
    const kinds = [...this.kinds.entries()].map(([kind, def]) => {
      const mine = rows.filter((r) => r.kind === kind), compared = mine.filter((r) => r.agree !== null), ms = mine.map((r) => Number(r.ms)).sort((a, b) => a - b);
      return { kind, label: def.label, budgetMs: def.budgetMs, threshold: this.threshold(kind), shadow: this.inShadow(kind), shadowSetting: this.settings.boolean(`decisiones.sombra.${kind}`),
        n: mine.length, backup: mine.filter((r) => Number(r.backup)).length, defaulted: mine.filter((r) => Number(r.defaulted)).length,
        compared: compared.length, agreed: compared.filter((r) => Number(r.agree) === 1).length, msMedian: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null,
        ok: mine.filter((r) => r.mark === 'ok').length, bad: mine.filter((r) => r.mark === 'mal').length };
    });
    return { provider: this.primary.name, model: this.primary.name === 'jev' ? this.cfg.jevModel : this.cfg.deepseekModel, backup: this.backup?.name ?? null, graded: this.graded, days, kinds };
  }

  private async prune() {
    await this.db.query('DELETE FROM decisions WHERE at < $1', [new Date(Date.now() - this.cfg.decisionsKeepDays * 86_400_000).toISOString()]).catch(() => undefined);
  }
}

interface Row { kind: string; subject: string; state: unknown; decided: Record<string, Answer>; usedBackup: boolean; defaulted: boolean; shadow: boolean; ms: number; tokens: number; error: string }
/** El presupuesto de tiempo se cumple aunque un proveedor no atienda la señal de corte: la espera termina con la señal. */
function within<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const late = () => Object.assign(new Error('tiempo agotado'), { name: 'TimeoutError' });
  if (signal.aborted) { p.catch(() => undefined); return Promise.reject(late()); }
  return new Promise<T>((res, rej) => { signal.addEventListener('abort', () => rej(late()), { once: true }); p.then(res, rej); });
}
/** Dos respuestas coinciden: misma opcion, mismo si/no, o niveles a menos de un punto. */
const same = (q: Questions[string], a: unknown, b: unknown) => (q.type === 'score' ? Math.abs(Number(a) - Number(b)) < 1 : a === b);
