// Captura el microfono y lo entrega como PCM de 16 bits, mono, 16 kHz, en tramas de ~40 ms.
class MicProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.out = new Int16Array(640); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Remuestreo por interpolacion lineal (suficiente para voz).
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = ch[i], b = i + 1 < ch.length ? ch[i + 1] : a;
      const v = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.out.length) { this.port.postMessage(this.out.buffer.slice(0)); this.n = 0; }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
