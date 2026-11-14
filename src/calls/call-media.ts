import { Logger } from '@nestjs/common';
import OpusScript from 'opusscript';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from 'werift';

export interface MediaConfig { publicIp: string; portMin: number; portMax: number; }
export interface CallStats { packets: number; seconds: number; voiceSeconds: number; peak: number; ice: string; }

const RATE = 48000, CH = 2, FRAME = 960; // 20 ms de Opus a 48 kHz estereo (lo que anuncia la oferta de WhatsApp: opus/48000/2)

/**
 * Extremo WebRTC del servidor para una llamada de WhatsApp (etapa 2: contestar y comprobar el audio en ambos sentidos).
 * La oferta SDP llega en el webhook; aqui se arma la respuesta. Los candidatos ICE usan la IP publica del VPS y un rango
 * fijo de puertos UDP, que debe estar publicado en el contenedor y abierto en el firewall.
 */
export class CallMedia {
  private readonly log = new Logger(CallMedia.name);
  private readonly pc: RTCPeerConnection;
  private readonly out = new MediaStreamTrack({ kind: 'audio' });
  private readonly decoder = new OpusScript(RATE, CH, OpusScript.Application.VOIP);
  private readonly encoder = new OpusScript(RATE, CH, OpusScript.Application.VOIP);
  private seq = Math.floor(Math.random() * 65535); private ts = Math.floor(Math.random() * 2 ** 31); private ssrc = Math.floor(Math.random() * 2 ** 31);
  private sender?: NodeJS.Timeout;
  readonly stats: CallStats = { packets: 0, seconds: 0, voiceSeconds: 0, peak: 0, ice: 'new' };
  /** Audio recibido de la persona, ya convertido a PCM 16 bits mono 16 kHz (lo que espera el reconocimiento de voz). */
  onPcm16k?: (pcm: Buffer) => void;
  /** Cola de audio del avatar (PCM 16 bits estereo 48 kHz) que se envia en tramas de 20 ms. */
  private queue: Buffer[] = []; private queued = 0;
  onPlaying?: (playing: boolean) => void; private playing = false;

  constructor(cfg: MediaConfig) {
    this.pc = new RTCPeerConnection({
      codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: RATE, channels: CH, payloadType: 111 })], video: [] },
      icePortRange: [cfg.portMin, cfg.portMax],
      iceAdditionalHostAddresses: cfg.publicIp ? [cfg.publicIp] : undefined,
      iceUseIpv6: false,
    });
    this.pc.iceConnectionStateChange.subscribe((s) => { this.stats.ice = s; this.log.log(`ICE: ${s}`); });
    this.pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((rtp) => this.onAudio(rtp.payload)));
  }

  /** Recibe la oferta de WhatsApp y devuelve la respuesta SDP con los candidatos ya incluidos. */
  async answer(offer: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offer });
    const tr = this.pc.getTransceivers().find((t) => t.kind === 'audio');
    if (!tr) throw new Error('la oferta no trae audio');
    tr.setDirection('sendrecv');
    await tr.sender.replaceTrack(this.out);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    for (let i = 0; i < 40 && this.pc.iceGatheringState !== 'complete'; i++) await new Promise((r) => setTimeout(r, 50)); // sin trickle: todos los candidatos en el SDP
    return this.pc.localDescription!.sdp;
  }

  private onAudio(payload: Buffer) {
    this.stats.packets++;
    try {
      const pcm = this.decoder.decode(payload);
      const n = pcm.length / 2; let sum = 0;
      for (let i = 0; i < pcm.length; i += 2) { const v = pcm.readInt16LE(i); sum += v * v; }
      const rms = Math.sqrt(sum / Math.max(1, n)) / 32768;
      const sec = n / CH / RATE;
      this.stats.seconds += sec; if (rms > 0.02) this.stats.voiceSeconds += sec; if (rms > this.stats.peak) this.stats.peak = rms;
      if (this.onPcm16k) this.onPcm16k(down48sTo16m(pcm));
    } catch { /* paquete que no es Opus (por ejemplo comfort noise): se ignora */ }
  }

  private sendFrame(pcm: Buffer) {
    const payload = this.encoder.encode(pcm, FRAME);
    this.out.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: this.seq, timestamp: this.ts, ssrc: this.ssrc, marker: false }), payload));
    this.seq = (this.seq + 1) & 0xffff; this.ts = (this.ts + FRAME) >>> 0;
  }

  /** Envia un tono corto (para comprobar que el audio sale) y luego silencio, en tramas de 20 ms. */
  startTestAudio() {
    let n = 0;
    this.sender = setInterval(() => {
      const pcm = Buffer.alloc(FRAME * CH * 2);
      const beep = (n >= 25 && n < 50) || (n >= 75 && n < 100); // dos pitidos de medio segundo
      if (beep) for (let i = 0; i < FRAME; i++) { const v = Math.round(Math.sin(2 * Math.PI * 660 * (n * FRAME + i) / RATE) * 9000); pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2); }
      this.sendFrame(pcm); n++;
    }, 20);
  }

  /** Agrega audio del avatar: PCM 16 bits mono a `rate` Hz (24000 para ElevenLabs). */
  pushVoice(pcm: Buffer, rate: number) {
    const st = upToStereo48(pcm, rate);
    this.queue.push(st); this.queued += st.length;
    if (!this.playing) { this.playing = true; this.onPlaying?.(true); }
  }
  /** Corta en seco lo que falta por decir (interrupcion). */
  flushVoice() { this.queue = []; this.queued = 0; }

  /** Envia la cola del avatar cada 20 ms; si esta vacia, silencio (el flujo de audio no se interrumpe). */
  startOutput() {
    const bytes = FRAME * CH * 2;
    this.sender = setInterval(() => {
      let frame: Buffer;
      if (this.queued >= bytes) {
        const parts: Buffer[] = []; let need = bytes;
        while (need > 0) { const h = this.queue[0]; if (h.length <= need) { parts.push(h); need -= h.length; this.queue.shift(); } else { parts.push(h.subarray(0, need)); this.queue[0] = h.subarray(need); need = 0; } }
        this.queued -= bytes; frame = Buffer.concat(parts);
      } else {
        frame = Buffer.alloc(bytes);
        if (this.queued > 0) { Buffer.concat(this.queue).copy(frame); this.queue = []; this.queued = 0; }
        if (this.playing) { this.playing = false; this.onPlaying?.(false); }
      }
      this.sendFrame(frame);
    }, 20);
  }

  async close() {
    clearInterval(this.sender);
    try { await this.pc.close(); } catch { /* ya cerrada */ }
    this.decoder.delete?.(); this.encoder.delete?.();
  }
}

/** 48 kHz estereo -> 16 kHz mono (promedio de canales y de cada 3 muestras: filtro simple, suficiente para voz). */
export function down48sTo16m(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4), out = Buffer.alloc(Math.floor(frames / 3) * 2);
  for (let o = 0, i = 0; o < out.length; o += 2, i += 3) {
    let acc = 0;
    for (let k = 0; k < 3; k++) acc += pcm.readInt16LE((i + k) * 4) + pcm.readInt16LE((i + k) * 4 + 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 6))), o);
  }
  return out;
}
/** PCM mono a `rate` Hz -> 48 kHz estereo, por interpolacion lineal. */
export function upToStereo48(pcm: Buffer, rate: number): Buffer {
  const n = Math.floor(pcm.length / 2); if (!n) return Buffer.alloc(0);
  const ratio = RATE / rate, m = Math.floor(n * ratio), out = Buffer.alloc(m * 4);
  for (let j = 0; j < m; j++) {
    const x = j / ratio, i = Math.floor(x), f = x - i;
    const a = pcm.readInt16LE(Math.min(i, n - 1) * 2), b = pcm.readInt16LE(Math.min(i + 1, n - 1) * 2);
    const v = Math.round(a + (b - a) * f);
    out.writeInt16LE(v, j * 4); out.writeInt16LE(v, j * 4 + 2);
  }
  return out;
}
