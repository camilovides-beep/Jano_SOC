// Lip sync para espanol a partir de los caracteres con tiempo que entrega ElevenLabs.
export const VISEMES = ['viseme_PP', 'viseme_FF', 'viseme_DD', 'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'];
const STRENGTH = { viseme_aa: 0.85, viseme_E: 0.7, viseme_I: 0.6, viseme_O: 0.75, viseme_U: 0.7, viseme_PP: 0.9, viseme_FF: 0.8, viseme_DD: 0.45 };
const PLAIN = { 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'ü', 'ñ': 'ñ' };
const VOWEL = { a: 'viseme_aa', e: 'viseme_E', i: 'viseme_I', y: 'viseme_I', o: 'viseme_O', u: 'viseme_U', 'ü': 'viseme_U' };
const norm = (c) => { c = (c || '').toLowerCase(); return PLAIN[c] ?? c; };
const isLetter = (c) => /[a-zñü0-9]/.test(c);

/** Visema de chars[i]: nombre, 'rest' (boca en reposo) o null (letra muda: se mantiene la forma anterior). */
export function visemeFor(chars, i) {
  const c = norm(chars[i]), prev = norm(chars[i - 1]), next = norm(chars[i + 1]);
  if (!isLetter(c)) return 'rest';
  if (c === 'h') return null;                                                  // la h es muda
  if (c === 'u' && (prev === 'q' || (prev === 'g' && (next === 'e' || next === 'i')))) return null; // que, qui, gue, gui
  if (VOWEL[c]) return VOWEL[c];
  if ('pbmv'.includes(c)) return 'viseme_PP';
  if (c === 'f') return 'viseme_FF';
  return 'viseme_DD';
}

export class LipSync {
  constructor() { this.events = []; this.cursor = 0; this.weights = Object.fromEntries(VISEMES.map((v) => [v, 0])); }
  reset() { this.events = []; this.cursor = 0; }
  /** Agrega un tramo de caracteres con tiempos (segundos desde el inicio de la locucion). */
  add(chars, starts, ends) {
    for (let i = 0; i < chars.length; i++) {
      const v = visemeFor(chars, i);
      if (v === null) continue;
      this.events.push({ t0: starts[i], t1: ends[i], v });
    }
  }
  /** Avanza la boca: t = tiempo real de reproduccion; dt = segundos desde el cuadro anterior. Devuelve los pesos. */
  update(t, dt) {
    let target = 'rest';
    if (t >= 0) {
      const look = t + 0.03; // la boca se adelanta un poco al sonido, como al hablar
      while (this.cursor < this.events.length - 1 && this.events[this.cursor].t1 <= look) this.cursor++;
      const e = this.events[this.cursor];
      if (e && look >= e.t0 && look < e.t1 + 0.04) target = e.v;
    }
    const k = 1 - Math.exp(-dt / 0.06); // suavizado ~60 ms
    for (const v of VISEMES) {
      const goal = v === target ? STRENGTH[v] : 0;
      this.weights[v] += (goal - this.weights[v]) * k;
    }
    return this.weights;
  }
}
