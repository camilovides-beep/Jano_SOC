// Compuerta del microfono: en modos de espera larga (suspendido, musica, encargo en curso) el audio solo se envia al
// servidor cuando hay voz. Asi no se paga la escucha de horas de silencio. Si el ruido del lugar supera el umbral, la
// compuerta queda abierta: se pierde el ahorro, pero nunca se deja de oir.
export function levelOf(buffer) {
  const pcm = new Int16Array(buffer); let sum = 0, n = 0;
  for (let i = 0; i < pcm.length; i += 4) { sum += pcm[i] * pcm[i]; n++; }
  return n ? Math.sqrt(sum / n) / 32768 : 0;
}

/**
 * rms: volumen (0..1) a partir del cual se considera voz. pre: tramas guardadas para no cortar el inicio de la frase.
 * hang: tramas de silencio que se siguen enviando al final, para que el reconocedor detecte el fin de frase.
 */
export function createGate({ rms = 0.012, pre = 30, hang = 60 } = {}) {
  const held = []; let open = false, quiet = 0, hot = 0;
  return {
    /** Devuelve las tramas que hay que enviar ahora (puede ser ninguna). `eco`: si la compuerta debe actuar. */
    push(buffer, eco) {
      if (!eco) { open = false; held.length = 0; hot = 0; return [buffer]; }
      const loud = levelOf(buffer) > rms;
      if (open) { quiet = loud ? 0 : quiet + 1; if (quiet > hang) open = false; return [buffer]; }
      held.push(buffer); if (held.length > pre) held.shift();
      hot = loud ? hot + 1 : 0;
      if (hot < 2) return [];
      open = true; quiet = 0; hot = 0;
      return held.splice(0);
    },
    get open() { return open; },
  };
}
