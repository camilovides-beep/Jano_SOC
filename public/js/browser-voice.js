// Voz del navegador (Web Speech API): respaldo cuando el servidor no tiene clave de ElevenLabs.
// Tiene la misma interfaz que SpeechPlayer (begin, end, stop, time, active) para que el resto no cambie.
// No hay tiempos por caracter: la boca se guia por los avisos de palabra del navegador (`boundary`) y, si la voz no los
// da, por una estimacion de caracteres por segundo.
const CPS = 14; // caracteres por segundo aproximados del espanol a velocidad normal

export class BrowserVoice {
  /** onChars(chars, starts, ends): caracteres con tiempo para el lip sync y los subtitulos. onCut(t): descartar lo estimado desde t. */
  constructor(onChars, onCut) {
    this.onChars = onChars; this.onCut = onCut; this.synth = window.speechSynthesis;
    this.prefer = ''; this.rate = 1; this.boundaries = false; this.reset();
    this.synth?.getVoices(); // algunas veces la lista llega despues: se pide desde ya
  }
  get supported() { return !!this.synth && 'SpeechSynthesisUtterance' in window; }
  configure(prefer, rate) { this.prefer = String(prefer || '').toLowerCase(); this.rate = Math.max(0.5, Math.min(2, Number(rate) || 1)); }
  reset() { this.t0 = null; this.pending = 0; this.ended = false; this.gen = (this.gen || 0) + 1; }
  begin() { this.stop(); this.reset(); }

  /** Voz para el idioma: la que pide BROWSER_VOICE si existe; si no, una del idioma (para español, primero las latinas). */
  voiceFor(lang) {
    const all = this.synth.getVoices(), l = String(lang || 'es').toLowerCase();
    const same = all.filter((v) => v.lang.toLowerCase().startsWith(l));
    if (this.prefer) { const p = same.find((v) => v.name.toLowerCase().includes(this.prefer)) ?? all.find((v) => v.name.toLowerCase().includes(this.prefer)); if (p) return p; }
    if (l === 'es') for (const tag of ['es-co', 'es-mx', 'es-us', 'es-419', 'es-ar', 'es-']) { const v = same.find((x) => x.lang.toLowerCase().replace('_', '-').startsWith(tag)); if (v) return v; }
    return same[0] ?? null;
  }

  /** Encola una frase. Las frases salen en orden, una tras otra. */
  speak(text, lang) {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(text), voice = this.voiceFor(lang), gen = this.gen;
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang === 'es' ? 'es-MX' : lang;
    u.rate = this.rate;
    const chars = [...text]; let base = 0, guessed = false;
    const now = () => (performance.now() - this.t0) / 1000;
    u.onstart = () => {
      if (gen !== this.gen) return;
      if (this.t0 === null) this.t0 = performance.now();
      base = now();
      if (!this.boundaries) { // sin avisos de palabra (todavia): toda la frase a ritmo estimado
        guessed = true; const step = 1 / (CPS * this.rate);
        this.onChars([' ', ...chars], [base, ...chars.map((_, i) => base + i * step)], [base, ...chars.map((_, i) => base + (i + 1) * step)]);
      } else this.onChars([' '], [base], [base]);
    };
    u.onboundary = (ev) => {
      if (gen !== this.gen || (ev.name && ev.name !== 'word')) return;
      const t = now();
      if (guessed) { guessed = false; this.onCut(base); }   // llegaron avisos reales: se descarta lo estimado de esta frase
      this.boundaries = true;
      const rest = text.slice(ev.charIndex), len = ev.charLength || (rest.search(/\s/) < 0 ? rest.length : rest.search(/\s/));
      const word = [...rest.slice(0, len), ' '], step = Math.min(0.09, 1 / (CPS * this.rate));
      this.onChars(word, word.map((_, i) => t + i * step), word.map((_, i) => t + (i + 1) * step));
    };
    const done = () => { if (gen === this.gen) this.pending = Math.max(0, this.pending - 1); };
    u.onend = done; u.onerror = done;
    this.pending++;
    this.synth.speak(u);
  }
  end() { this.ended = true; }
  time() { return this.t0 === null ? -1 : (performance.now() - this.t0) / 1000; }
  get active() { return this.pending > 0 || (!this.ended && this.t0 !== null); }
  stop() { this.gen++; this.pending = 0; this.ended = true; this.t0 = null; try { this.synth?.cancel(); } catch { /* sin voz */ } }
}
