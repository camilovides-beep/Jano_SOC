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
export interface Decision<Q extends Questions> {
  id: Promise<number | null>;
  /** Lo que debe usar quien llama. En modo sombra son los valores por defecto. */
  answers: Answers<Q>;
  /** Lo que se decidio de verdad (en sombra difiere de `answers`). Solo para medir y mostrar, no para actuar. */
  decided: Answers<Q>;
  shadow: boolean; ms: number;
}

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

  /** Una decision de un solo tipo. */
  async decide<Q extends Questions>(kind: string, state: unknown, questions: Q, opts: DecideOptions = {}): Promise<Decision<Q>> {
    return (await this.decideMany(state, { [kind]: questions } as Record<string, Q>, opts))[kind];
  }

  /**
   * Varios tipos de decision sobre el MISMO estado en una sola peticion al proveedor (por ejemplo la ruta del turno y la
   * señal de inyeccion). Cada tipo conserva su umbral, su modo sombra, su presupuesto de tiempo y su fila en el registro.
   */
  async decideMany<S extends Record<string, Questions>>(state: unknown, sets: S, opts: DecideOptions = {}): Promise<{ [K in keyof S]: Decision<S[K]> }> {
    const t0 = Date.now(), kinds = Object.keys(sets), SEP = '__';
    const budgetOf = (kind: string) => opts.budgetMs ?? this.kinds.get(kind)?.budgetMs ?? 800;
    const flat: Questions = {};
    for (const kind of kinds) for (const [id, q] of Object.entries(sets[kind])) flat[kind + SEP + id] = q;
    const deadline = AbortSignal.timeout(Math.max(...kinds.map(budgetOf)));
    let primaryError = '', primaryTokens = 0, primaryAnswers: Record<string, RawAnswer> = {};
    try {
      const r = await within(this.primary.ask(state, flat, deadline), deadline);
      primaryTokens = r.tokens; primaryAnswers = r.answers;
    } catch (e) { primaryError = this.note(this.primary.name, e); }

    const one = async (kind: string): Promise<Decision<Questions>> => {
      const questions = sets[kind], ids = Object.keys(questions), def = this.kinds.get(kind), shadow = this.inShadow(kind);
      const mine: Record<string, RawAnswer> = {}, raw: Record<string, RawAnswer & { by: Provider; backup: boolean }> = {};
      for (const id of ids) { const a = primaryAnswers[kind + SEP + id]; if (a) { mine[id] = a; raw[id] = { ...a, by: this.primary.name, backup: false }; } }
      let error = primaryError, tokens = Math.round(primaryTokens / kinds.length), usedBackup = false;

      // Respaldo: lo que el principal no respondio o respondio con confianza baja. En modo sombra se consulta aparte, sin prisa.
      const weak = !this.backup ? [] : ids.filter((id) => !raw[id] || (raw[id].confidence !== null && raw[id].confidence! < this.threshold(kind)));
      if (weak.length && this.backup && !shadow) {
        const left = AbortSignal.timeout(Math.max(1, budgetOf(kind) - (Date.now() - t0)));
        try {
          const r = await within(this.backup.ask(state, Object.fromEntries(weak.map((id) => [id, questions[id]])), left), left);
          tokens += r.tokens;
          for (const id of weak) {
            if (!r.answers[id]) continue;
            const q = questions[id], first = raw[id];
            // Conservadora: el "si" de cualquiera de los dos gana; el dudoso del principal no se pierde por un "no" del respaldo.
            if (q.type === 'yesno' && q.conservative && first?.value === true) raw[id] = { ...first, backup: true };
            else raw[id] = { ...r.answers[id], by: this.backup.name, backup: true };
            usedBackup = true;
          }
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
      // En sombra se compara con el respaldo: siempre que el principal se aparte del valor por defecto (lo interesante) y, del
      // resto, solo una muestra, para no duplicar el costo de lo que se evalua en cada turno.
      const flagged = ids.some((i) => mine[i] && mine[i].value !== questions[i].fallback);
      const rate = def?.compareRate ?? 1; // 0 = nunca: ese tipo se mide de otra forma (la ruta, contra lo que hizo el modelo)
      const compare = shadow && !!this.backup && rate > 0 && (flagged || Math.random() < rate);
      const id = compare ? this.shadowCompare(row, questions, mine) : this.save(row, null);
      return { id, answers: effective as Answers<Questions>, decided: decided as Answers<Questions>, shadow, ms };
    };
    const out = await Promise.all(kinds.map(one));
    return Object.fromEntries(kinds.map((k, i) => [k, out[i]])) as { [K in keyof S]: Decision<S[K]> };
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

  /**
   * Aciertos de la ruta contra lo que de verdad paso en cada turno (ultimos dias). `missed` es el error que importa: la
   * ruta dijo que no hacia falta herramienta y el modelo si uso una. `extra`: pidio herramientas que no se usaron (inofensivo).
   */
  async routeStats(days = 14) {
    const rows = await this.db.query<{ detail: string; outcome: string }>(`SELECT detail, outcome FROM decisions WHERE business = $1 AND kind = 'ruta' AND outcome <> '' AND at >= $2`, [this.cfg.businessId, new Date(Date.now() - days * 86_400_000).toISOString()]);
    const out = { days, n: 0, right: 0, missed: 0, extra: 0, jobs: 0, jobsRight: 0, examples: [] as string[] };
    for (const r of rows) {
      let d: any; try { d = JSON.parse(r.detail); } catch { continue; }
      const a = d.turno ?? d.turno_dueno; if (!a || a.by === 'defecto') continue;
      const said = String(a.value), real = r.outcome.split(':')[0], needsTool = real !== 'charla', saidTool = said === 'herramienta' || said === 'encargo';
      out.n++;
      if (needsTool && !saidTool) { out.missed++; if (out.examples.length < 5) out.examples.push(`dijo "${said}" y se usó ${r.outcome}`); }
      else if (!needsTool && saidTool) out.extra++;
      else out.right++;
      if (real === 'encargo') { out.jobs++; if (said === 'encargo') out.jobsRight++; }
    }
    return out;
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
