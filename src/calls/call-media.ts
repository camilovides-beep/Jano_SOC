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

  async close() {
    clearInterval(this.sender);
    try { await this.pc.close(); } catch { /* ya cerrada */ }
    this.decoder.delete?.(); this.encoder.delete?.();
  }
}
