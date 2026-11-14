// Reproduce en orden los fragmentos PCM de una locucion y expone el tiempo real de reproduccion,
// que es el reloj del lip sync.
export class SpeechPlayer {
  constructor(ctx) { this.ctx = ctx; this.reset(); }
  reset() { this.t0 = null; this.next = 0; this.sources = new Set(); this.carry = null; this.ended = false; this.rate = 24000; }
  begin(sampleRate) { this.stop(); this.reset(); this.rate = sampleRate; }
  /** bytes: Uint8Array con PCM de 16 bits little-endian, mono. */
  push(bytes) {
    if (this.carry) { const m = new Uint8Array(this.carry.length + bytes.length); m.set(this.carry); m.set(bytes, this.carry.length); bytes = m; this.carry = null; }
    if (bytes.length % 2) { this.carry = bytes.slice(bytes.length - 1); bytes = bytes.subarray(0, bytes.length - 1); }
    const n = bytes.length / 2; if (!n) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buf = this.ctx.createBuffer(1, n, this.rate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const now = this.ctx.currentTime;
    if (this.t0 === null) { this.t0 = now + 0.1; this.next = this.t0; }
    else if (this.next < now + 0.01) { const gap = now + 0.03 - this.next; this.t0 += gap; this.next += gap; } // se quedo sin audio: el reloj se corre igual
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination);
    src.start(this.next); this.next += buf.duration;
    this.sources.add(src); src.onended = () => this.sources.delete(src);
  }
  end() { this.ended = true; }
  /** Segundos transcurridos de la locucion segun lo que realmente esta sonando (negativo antes de empezar). */
  time() { return this.t0 === null ? -1 : this.ctx.currentTime - this.t0; }
  get active() { return this.t0 !== null && !(this.ended && this.ctx.currentTime >= this.next); }
  stop() { for (const s of this.sources) { try { s.stop(); } catch {} } this.sources.clear(); this.t0 = null; this.ended = true; }
}

export function base64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
