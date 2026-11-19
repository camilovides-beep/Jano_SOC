/**
 * Preguntas y respuestas de la capa de decisiones. Cada pregunta pide UNA cosa concreta; lo que tenga varios factores se
 * descompone en varias preguntas y se combina en codigo. `fallback` es el valor seguro que se usa si nadie responde a tiempo.
 */
export type Question =
  | { type: 'choice'; ask: string; options: Record<string, string>; fallback: string }
  | { type: 'score'; ask: string; levels: string[]; fallback: number }
  | { type: 'yesno'; ask: string; yes?: string; no?: string; fallback: boolean };
export type Questions = Record<string, Question>;
export type Provider = 'jev' | 'deepseek';

/** Lo que devuelve un proveedor para una pregunta, antes de aplicar umbrales. */
export interface RawAnswer {
  /** choice: la opcion; score: el nivel (puede ser fraccionario); yesno: true/false. */
  value: string | number | boolean;
  /** Probabilidad de cada opcion o nivel; en yesno, {si, no}. Solo con Jev. */
  probabilities?: Record<string, number>;
  /** De 0 a 1. null si el proveedor no la da (DeepSeek). */
  confidence: number | null;
}

/** La respuesta que recibe el resto del codigo. Nunca falta: si nadie respondio, trae el valor por defecto. */
export interface Answer<V extends string | number | boolean = string | number | boolean> extends RawAnswer {
  value: V;
  /** Quien dio el valor final: un proveedor, o 'defecto' si se aplico el valor seguro. */
  by: Provider | 'defecto';
  /** Se uso el respaldo (el proveedor principal respondio con confianza baja o no respondio esta pregunta). */
  backup: boolean;
}
export type Answers<Q extends Questions> = { [K in keyof Q]: Answer<Q[K] extends { type: 'choice' } ? string : Q[K] extends { type: 'score' } ? number : boolean> };

/** Un tipo de decision: sus ajustes de fabrica. El umbral y el modo sombra se cambian en el panel y solo aplican con Jev. */
export interface KindDef {
  label: string;
  /** Confianza minima para usar la respuesta de Jev sin pedir respaldo. */
  threshold: number;
  /** Con Jev activo arranca en modo sombra: decide sin efecto y se compara con el respaldo. */
  shadow: boolean;
  /** Tiempo maximo de toda la decision, con respaldo incluido. Pasado ese tiempo se aplica el valor por defecto. */
  budgetMs: number;
}

export interface ProviderResult { answers: Record<string, RawAnswer>; tokens: number }
export interface DecisionProvider { readonly name: Provider; ask(state: unknown, questions: Questions, signal: AbortSignal): Promise<ProviderResult> }
