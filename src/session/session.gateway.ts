import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { ConfigService } from '../config/config.service';
import { DeepSeekService } from '../llm/deepseek.service';
import { DeepgramService, SttStream } from '../stt/deepgram.service';
import { ToolsService } from '../tools/tools.service';
import { ElevenLabsService, TTS_SAMPLE_RATE, TtsChunk } from '../tts/elevenlabs.service';

interface Turn {
  id: number;
  ctrl: AbortController;
  t0: number;            // momento en que se detecto el fin de frase del usuario
  tLlm?: number;         // primer token del LLM
  tAudio?: number;       // primer audio enviado al navegador
  samples: number;       // muestras de audio ya enviadas en este turno (para encadenar los tiempos de cada frase)
  chain: Promise<void>;  // emision en orden de las frases
  spoken: string;
  tags: string;         // etiquetas de reaccion que uso el modelo (se guardan en el historial para que las siga usando)
}
interface Session {
  n: number;
  ready: boolean;
  stt?: SttStream;
  history: any[];
  finals: string[];      // tramos finales de la frase que el usuario esta diciendo
  turn?: Turn;
  turnId: number;
  clientPlaying: boolean; // el navegador sigue reproduciendo la respuesta
  lastActivity: number;
  timers: NodeJS.Timeout[];
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Reacciones y fondos que el navegador sabe mostrar. El modelo los pide con etiquetas al inicio de su respuesta. */
const REACTIONS = new Set(['sorpresa', 'alegria', 'risa', 'pena', 'pensativo', 'celebracion', 'despedida']);
const SCENES = new Set(['matrix', 'estrellas', 'atardecer']);
const TAG_HEAD = /^\s*\[(r|f):([a-zñ_]+)\]\s*/i;
const TAG_ANY = /\[(r|f):[^\]]*\]/gi;
/** Se agrega al system prompt: el protocolo de etiquetas depende del codigo, no de la personalidad. */
const TAG_RULES = `

Reacciones (obligatorio): empieza SIEMPRE tu respuesta con una etiqueta entre corchetes que indique tu reacción a lo que acaba de decir la persona:
[r:sorpresa] si dijo una grosería, un insulto o algo subido de tono.
[r:alegria] si te felicita, te agradece o te dice algo lindo.
[r:risa] si cuenta un chiste o algo gracioso.
[r:pena] si cuenta algo triste o una mala noticia.
[r:pensativo] si la pregunta es difícil o te hace dudar.
[r:celebracion] si cuenta una buena noticia o un logro que merece celebrarse.
[r:despedida] si se está despidiendo.
[r:neutral] en cualquier otro caso.
Además, según el tema de TU respuesta, puedes agregar después UNA etiqueta de fondo:
[f:matrix] si hablas de programación, software, tecnología o inteligencia artificial.
[f:estrellas] si hablas del espacio, la ciencia, el futuro o los sueños.
[f:atardecer] si hablas de Sucre, la costa, Colombia, viajes, familia o temas personales y tranquilos.
Las etiquetas no se leen en voz alta. No uses corchetes para nada más. Ejemplo: "[r:alegria] ¡Gracias, qué amable!"`;

/**
 * WebSocket del navegador.
 *  cliente -> JSON { type: 'hello', code? } | { type: 'playback', playing } ; binario: PCM16 mono 16 kHz del microfono
 *  servidor -> { type: 'ready' } | { type: 'error', reason }
 *              { type: 'user_partial', text } | { type: 'user_final', text }
 *              { type: 'speech_start', id, sampleRate } , { type: 'audio', id, audio, align? } ... , { type: 'speech_end', id }
 *              { type: 'reaction', name } | { type: 'scene', name }  (gesto y emojis / fondo, segun lo que pidio el modelo)
 *              { type: 'interrupt' }  (el usuario hablo encima: cortar el audio)
 */
@WebSocketGateway({ path: '/ws' })
export class SessionGateway implements OnGatewayConnection {
  private readonly log = new Logger(SessionGateway.name);
  private active = 0;
  private counter = 0;
  constructor(
    private readonly cfg: ConfigService, private readonly tts: ElevenLabsService,
    private readonly stt: DeepgramService, private readonly llm: DeepSeekService, private readonly tools: ToolsService,
  ) {}

  handleConnection(client: WebSocket) {
    const s: Session = { n: ++this.counter, ready: false, history: [], finals: [], turnId: 0, clientPlaying: false, lastActivity: Date.now(), timers: [] };
    const authTimer = setTimeout(() => { if (!s.ready) client.close(4401, 'sin saludo'); }, 10_000);
    client.on('message', (raw, isBinary) => {
      if (isBinary) { if (s.ready) s.stt?.send(raw as Buffer); return; }
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!s.ready) {
        if (msg?.type !== 'hello') return;
        if (!this.codeOk(String(msg.code ?? ''))) { this.send(client, { type: 'error', reason: 'codigo' }); client.close(4401, 'codigo'); return; }
        if (this.active >= this.cfg.maxSessions) { this.send(client, { type: 'error', reason: 'ocupado' }); client.close(4429, 'ocupado'); return; }
        clearTimeout(authTimer); this.start(client, s);
        return;
      }
      if (msg?.type === 'playback' && !(s.turn && !msg.playing)) s.clientPlaying = !!msg.playing; // mientras el turno sigue generando, se considera hablando
    });
    client.on('close', () => { clearTimeout(authTimer); this.end(s); });
    client.on('error', () => this.end(s));
  }

  private start(client: WebSocket, s: Session) {
    s.ready = true; this.active++;
    this.log.log(`sesion #${s.n} abierta (${this.active}/${this.cfg.maxSessions})`);
    s.history.push({ role: 'system', content: this.cfg.systemPrompt + TAG_RULES });
    s.stt = this.stt.open({
      onTranscript: (text, isFinal, speechFinal) => this.onTranscript(client, s, text, isFinal, speechFinal),
      onUtteranceEnd: () => this.commit(client, s),
      onClose: (reason) => { if (s.ready) { this.log.warn(`sesion #${s.n}: Deepgram se cerro (${reason})`); this.send(client, { type: 'error', reason: 'escucha' }); client.close(1011, 'stt'); } },
    });
    // Limites: duracion maxima de la sesion e inactividad.
    s.timers.push(setTimeout(() => { this.send(client, { type: 'error', reason: 'tiempo' }); client.close(4408, 'duracion'); }, this.cfg.sessionMaxSeconds * 1000));
    s.timers.push(setInterval(() => {
      if (Date.now() - s.lastActivity > this.cfg.idleSeconds * 1000) { this.send(client, { type: 'error', reason: 'inactividad' }); client.close(4408, 'inactividad'); }
    }, 5000));
    this.send(client, { type: 'ready' });
    if (this.cfg.greeting) {
      const turn = this.newTurn(s);
      this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
      this.say(client, s, turn, this.cfg.greeting);
      void this.finish(client, s, turn, 'saludo');
    }
  }

  private end(s: Session) {
    if (!s.ready) return;
    s.ready = false; this.active--;
    s.turn?.ctrl.abort(); s.stt?.close();
    for (const t of s.timers) { clearTimeout(t); clearInterval(t); }
    this.log.log(`sesion #${s.n} cerrada (${this.active}/${this.cfg.maxSessions})`);
  }

  // ---------- escucha ----------
  private onTranscript(client: WebSocket, s: Session, text: string, isFinal: boolean, speechFinal: boolean) {
    if (text) {
      s.lastActivity = Date.now();
      if (isFinal) s.finals.push(text);
      const current = [...s.finals, isFinal ? '' : text].join(' ').trim();
      const busy = !!s.turn || s.clientPlaying;
      if (busy) {
        // El avatar esta respondiendo. Solo se interrumpe si se reconocen varias palabras (evita cortes por eco o ruido).
        if (words(current) >= this.cfg.bargeInWords) this.interrupt(client, s);
      }
      if (!(s.turn || s.clientPlaying)) this.send(client, { type: 'user_partial', text: current });
    }
    if (speechFinal) this.commit(client, s);
  }

  private commit(client: WebSocket, s: Session) {
    const text = s.finals.join(' ').trim();
    s.finals = [];
    if (!text) return;
    if (s.turn || s.clientPlaying) return; // palabras sueltas mientras el avatar habla: se descartan
    void this.respond(client, s, text);
  }

  private interrupt(client: WebSocket, s: Session) {
    this.log.log(`sesion #${s.n}: interrupcion del usuario`);
    s.turn?.ctrl.abort(); s.turn = undefined; s.clientPlaying = false;
    this.send(client, { type: 'interrupt' });
  }

  // ---------- respuesta ----------
  private newTurn(s: Session): Turn {
    s.turn?.ctrl.abort();
    const turn: Turn = { id: ++s.turnId, ctrl: new AbortController(), t0: Date.now(), samples: 0, chain: Promise.resolve(), spoken: '', tags: '' };
    s.turn = turn; s.clientPlaying = true;
    return turn;
  }

  private async respond(client: WebSocket, s: Session, userText: string) {
    const turn = this.newTurn(s);
    this.send(client, { type: 'user_final', text: userText });
    this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
    s.history.push({ role: 'user', content: userText });
    if (s.history.length > 41) s.history.splice(1, s.history.length - 41); // system + ultimos 40 mensajes
    try {
      let buffer = '';
      for (let round = 0; round < 4; round++) {
        let toolCalls: { id: string; name: string; arguments: string }[] = [];
        let text = '';
        for await (const ev of this.llm.chat(s.history, this.tools.definitions(), turn.ctrl.signal)) {
          if (ev.type === 'tool_calls') { toolCalls = ev.calls; continue; }
          turn.tLlm ??= Date.now();
          text += ev.delta; buffer += ev.delta;
          buffer = this.takeTags(client, turn, buffer);
          const head = buffer.trimStart();
          if (head.startsWith('[') && !head.includes(']') && head.length < 24) continue; // etiqueta a medio llegar
          let cut: number;
          while ((cut = this.sentenceEnd(buffer)) > 0) { this.say(client, s, turn, buffer.slice(0, cut)); buffer = buffer.slice(cut); }
        }
        if (buffer.trim()) { this.say(client, s, turn, buffer); buffer = ''; } // fin de la ronda: lo pendiente sale ya
        if (!toolCalls.length) break;
        s.history.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) });
        for (const c of toolCalls) {
          const result = await this.tools.run(c.name, c.arguments);
          this.log.log(`sesion #${s.n}: herramienta ${c.name} -> ${result.slice(0, 80)}`);
          s.history.push({ role: 'tool', tool_call_id: c.id, content: result });
        }
      }
      if (buffer.trim()) this.say(client, s, turn, buffer);
    } catch (e) {
      if (!turn.ctrl.signal.aborted) {
        this.log.error(`sesion #${s.n} turno #${turn.id}: ${(e as Error).message}`);
        this.say(client, s, turn, 'Perdón, tuve un problema para responder. ¿Me lo repites?');
      }
    }
    await this.finish(client, s, turn, 'turno');
  }

  /** Saca las etiquetas [r:...] y [f:...] del inicio del texto y avisa al navegador. */
  private takeTags(client: WebSocket, turn: Turn, buffer: string): string {
    let m: RegExpMatchArray | null;
    while ((m = buffer.match(TAG_HEAD))) {
      const kind = m[1].toLowerCase(), name = m[2].toLowerCase();
      turn.tags += `[${kind}:${name}]`;
      if (kind === 'r' && REACTIONS.has(name)) this.send(client, { type: 'reaction', name });
      if (kind === 'f' && SCENES.has(name)) this.send(client, { type: 'scene', name });
      buffer = buffer.slice(m[0].length);
    }
    return buffer;
  }

  /** Fin de la primera frase completa del texto acumulado (0 si aun no hay una). */
  private sentenceEnd(buf: string): number {
    const re = /[.!?…]+["')\]]*\s|\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf))) { const end = m.index + m[0].length; if (buf.slice(0, end).trim().length >= 12) return end; }
    return 0;
  }

  /** Manda una frase a voz. La peticion a ElevenLabs sale de inmediato; el audio se entrega al navegador en orden. */
  private say(client: WebSocket, s: Session, turn: Turn, sentence: string) {
    const text = sentence.replace(TAG_ANY, ' ').replace(/\s+/g, ' ').trim(); // por si el modelo pone una etiqueta fuera de lugar
    if (!text || turn.ctrl.signal.aborted) return;
    const first = !turn.spoken;
    turn.spoken += (turn.spoken ? ' ' : '') + text;
    const buf: TtsChunk[] = [];
    let spaced = first; // entre frases se agrega un espacio para los subtitulos
    let done = false, wake: (() => void) | undefined;
    (async () => { for await (const c of this.tts.stream(text, turn.ctrl.signal)) { buf.push(c); wake?.(); } })()
      .catch((e) => { if (!turn.ctrl.signal.aborted) this.log.error(`sesion #${s.n}: voz fallo: ${(e as Error).message}`); })
      .finally(() => { done = true; wake?.(); });
    turn.chain = turn.chain.then(async () => {
      const offset = turn.samples / TTS_SAMPLE_RATE; // los tiempos de ElevenLabs son relativos a cada frase
      for (;;) {
        while (buf.length) {
          const c = buf.shift()!;
          if (turn.ctrl.signal.aborted) return;
          turn.tAudio ??= Date.now();
          turn.samples += Buffer.byteLength(c.audio, 'base64') / 2;
          const align = c.align && { chars: [...c.align.chars], starts: c.align.starts.map((t) => t + offset), ends: c.align.ends.map((t) => t + offset) };
          if (align && align.chars.length && !spaced) { spaced = true; align.chars.unshift(' '); align.starts.unshift(align.starts[0]); align.ends.unshift(align.starts[0]); }
          this.send(client, { type: 'audio', id: turn.id, audio: c.audio, align });
        }
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    });
  }

  private async finish(client: WebSocket, s: Session, turn: Turn, kind: string) {
    await turn.chain;
    const aborted = turn.ctrl.signal.aborted;
    if (!aborted) this.send(client, { type: 'speech_end', id: turn.id });
    if (turn.spoken) s.history.push({ role: 'assistant', content: (turn.tags ? turn.tags + ' ' : '') + turn.spoken });
    if (s.turn === turn) s.turn = undefined;
    const ms = (t?: number) => (t ? `${t - turn.t0} ms` : 'n/d');
    this.log.log(`sesion #${s.n} ${kind} #${turn.id}${aborted ? ' (interrumpido)' : ''}: primer token LLM ${ms(turn.tLlm)}, primer audio ${ms(turn.tAudio)}, audio ${(turn.samples / TTS_SAMPLE_RATE).toFixed(1)} s`);
  }

  private codeOk(code: string): boolean {
    if (!this.cfg.accessCode) return true; // sin codigo configurado: acceso libre
    const a = Buffer.from(code), b = Buffer.from(this.cfg.accessCode);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private send(client: WebSocket, msg: unknown) {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(msg));
  }
}
