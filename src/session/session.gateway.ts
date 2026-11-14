import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { OwnerService } from '../owner/owner.service';
import { ConfigService } from '../config/config.service';
import { CardsService } from '../cards/cards.service';
import { DeepSeekService, LlmEvent } from '../llm/deepseek.service';
import { MemoryService } from '../memory/memory.service';
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
  ttsActive: number; ttsWaiters: (() => void)[]; // control de peticiones de voz simultaneas
  lang: string;          // idioma de la respuesta (el de la ultima frase del usuario)
  sceneLocked?: boolean; // una herramienta ya puso el fondo de este turno (el del clima manda sobre el del modelo)
  tags: string;         // etiquetas de reaccion que uso el modelo (se guardan en el historial para que las siga usando)
}
/** Respuesta del modelo pedida por adelantado, antes de confirmar el fin de frase (baja la latencia). */
interface Spec { text: string; lang: string; ctrl: AbortController; events: LlmEvent[]; done: boolean; err?: Error; wake?: () => void; tFirst?: number; }
interface Session {
  n: number;
  ready: boolean;
  owner: boolean;        // dispositivo registrado del dueño: habilita las herramientas privadas
  stt?: SttStream;
  history: any[];
  finals: string[];      // tramos finales de la frase que el usuario esta diciendo
  turn?: Turn;
  turnId: number;
  clientPlaying: boolean; // el navegador sigue reproduciendo la respuesta
  lastActivity: number;
  visitor?: string;      // identificador del navegador, para recordar a quien vuelve
  userTurns: number;
  langs: string[];       // idiomas detectados en la frase en curso
  lastLang: string;      // idioma del ultimo texto reconocido (tambien en resultados parciales)
  spec?: Spec;
  specTimer?: NodeJS.Timeout;
  leads: number;         // interesados guardados en esta sesion (tope contra abuso)
  timers: NodeJS.Timeout[];
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Como captar interesados. Va en sesiones publicas: el avatar existe para conseguirle clientes a Javier. */
const LEAD_RULES = `

Captación de clientes: si la persona muestra interés en algo que Javier hace (chatbots, agentes de voz, bots de WhatsApp, automatización, dashboards, despliegue de sistemas, desarrollo de software) o pregunta cómo contratarlo:
1. Cuéntale en una o dos frases cómo Javier puede ayudarle y pregúntale qué necesita.
2. Pídele su nombre y un dato de contacto (WhatsApp, teléfono o correo), de a uno por vez, sin sonar a formulario.
3. Repítele el contacto para confirmar que lo entendiste bien; si es un número, dilo dígito por dígito.
4. Pregúntale si autoriza guardar esos datos para que Javier lo contacte.
5. Solo si dijo que sí, usa la herramienta registrar_interesado. Después dile que Javier le escribirá pronto.
No insistas si no quiere dejar sus datos, y no prometas precios, plazos ni resultados.`;

/** Frase que se dice mientras una herramienta consulta su dato (evita el silencio de la espera). */
const FILLERS: Record<string, string> = {
  plane_: 'Déjame revisar en Plane.',
  clima: 'Déjame mirar cómo está el clima.',
  precio_dolar: 'Ya te digo a cómo está.',
  registrar_interesado: 'Listo, ya lo anoto.',
  ver_interesados: 'Déjame mirar la lista.',
};

/** Reacciones y fondos que el navegador sabe mostrar. El modelo los pide con etiquetas al inicio de su respuesta. */
const REACTIONS = new Set(['sorpresa', 'alegria', 'risa', 'pena', 'pensativo', 'celebracion', 'despedida']);
const SCENES = new Set(['matrix', 'estrellas', 'atardecer']);   // los que puede pedir el modelo; los del clima los pone la herramienta
const TAG_HEAD = /^\s*\[(r|f|c):([a-zñ_]+)\]\s*/i;
const TAG_ANY = /\[(r|f|c):[^\]]*\]/gi;
const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[^a-z0-9ñ]+/g, '');
const LANG_NAMES: Record<string, string> = { en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán' };
/** Mensaje del usuario tal como lo ve el modelo: si hablo en otro idioma, se le recuerda responder en ese idioma. */
const userMsg = (text: string, lang: string) => (LANG_NAMES[lang] ? `${text}\n\n(Nota del sistema: la persona habló en ${LANG_NAMES[lang]}. Responde en ${LANG_NAMES[lang]}.)` : text);
/** Mientras consulta una herramienta, en otros idiomas. */
const FILLER_OTHER: Record<string, string> = { en: 'One moment.', pt: 'Um momento.', fr: 'Un instant.', it: 'Un momento.', de: 'Einen Moment.' };
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
Idioma: responde siempre en el idioma en que la persona te habló en su último mensaje (español si no está claro). Las etiquetas van siempre igual, en español.
Las etiquetas no se leen en voz alta. No uses corchetes para nada más. Ejemplo: "[r:alegria] ¡Gracias, qué amable!"`;

/**
 * WebSocket del navegador.
 *  cliente -> JSON { type: 'hello', code? } | { type: 'playback', playing } ; binario: PCM16 mono 16 kHz del microfono
 *  servidor -> { type: 'ready' } | { type: 'error', reason }
 *              { type: 'user_partial', text } | { type: 'user_final', text }
 *              { type: 'speech_start', id, sampleRate } , { type: 'audio', id, audio, align? } ... , { type: 'speech_end', id }
 *              { type: 'card', title, lines, qr?, caption? }  (tarjeta en pantalla)
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
    private readonly ownerAuth: OwnerService, private readonly cards: CardsService, private readonly memory: MemoryService,
  ) {}

  handleConnection(client: WebSocket, req: IncomingMessage) {
    // El modo dueño se decide aqui, con la cookie del dispositivo; nada de lo que se diga en la conversacion lo cambia.
    const owner = !!this.ownerAuth.verify(req?.headers?.cookie);
    const s: Session = { n: ++this.counter, ready: false, owner, history: [], finals: [], turnId: 0, clientPlaying: false, lastActivity: Date.now(), leads: 0, userTurns: 0, langs: [], lastLang: 'es', timers: [] };
    const authTimer = setTimeout(() => { if (!s.ready) client.close(4401, 'sin saludo'); }, 10_000);
    client.on('message', (raw, isBinary) => {
      if (isBinary) { if (s.ready) s.stt?.send(raw as Buffer); return; }
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!s.ready) {
        if (msg?.type !== 'hello') return;
        if (!s.owner && !this.codeOk(String(msg.code ?? ''))) { this.send(client, { type: 'error', reason: 'codigo' }); client.close(4401, 'codigo'); return; }
        if (this.active >= this.cfg.maxSessions) { this.send(client, { type: 'error', reason: 'ocupado' }); client.close(4429, 'ocupado'); return; }
        if (!s.owner && this.memory.valid(msg.visitor)) s.visitor = msg.visitor;
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
    this.log.log(`sesion #${s.n} abierta${s.owner ? ' [DUEÑO]' : ''} (${this.active}/${this.cfg.maxSessions})`);
    const known = s.visitor ? this.memory.get(s.visitor) : null;
    const cardIds = this.cards.ids();
    const cardRules = cardIds.length
      ? `\nTarjetas en pantalla: si tu respuesta trata de uno de estos temas, agrega UNA etiqueta [c:tema] para mostrar su tarjeta: ${cardIds.filter((c) => c !== 'contacto').join(', ')}.` +
        (cardIds.includes('contacto') ? ' Si la persona quiere contactar a Javier, seguir por WhatsApp o prefiere no dictar sus datos, agrega [c:contacto] para mostrarle un código QR y dile que lo escanee.' : '')
      : '';
    const memoryNote = known
      ? `\n\nYa conoces a esta persona de una visita anterior${known.name ? `: se llama ${known.name}` : ''}. Lo que hablaron: ${known.summary || 'no hay resumen'}. Salúdala como a alguien conocido y no le vuelvas a pedir datos que ya dio.`
      : '';
    s.history.push({ role: 'system', content: this.cfg.systemPrompt + (s.owner && this.cfg.ownerPrompt ? '\n\n' + this.cfg.ownerPrompt : LEAD_RULES) + TAG_RULES + cardRules + memoryNote });
    s.stt = this.stt.open({
      onTranscript: (text, isFinal, speechFinal, lang) => this.onTranscript(client, s, text, isFinal, speechFinal, lang),
      onUtteranceEnd: () => this.commit(client, s),
      onClose: (reason) => { if (s.ready) { this.log.warn(`sesion #${s.n}: Deepgram se cerro (${reason})`); this.send(client, { type: 'error', reason: 'escucha' }); client.close(1011, 'stt'); } },
    });
    // Limites: duracion maxima de la sesion e inactividad.
    s.timers.push(setTimeout(() => { this.send(client, { type: 'error', reason: 'tiempo' }); client.close(4408, 'duracion'); }, this.cfg.sessionMaxSeconds * 1000));
    s.timers.push(setInterval(() => {
      if (Date.now() - s.lastActivity > this.cfg.idleSeconds * 1000) { this.send(client, { type: 'error', reason: 'inactividad' }); client.close(4408, 'inactividad'); }
    }, 5000));
    this.send(client, { type: 'ready', owner: s.owner });
    const greeting = s.owner ? 'Hola Javier, aquí estoy. ¿Qué revisamos?' : known?.name ? `¡Hola de nuevo, ${known.name}! ¿En qué te ayudo hoy?` : this.cfg.greeting;
    if (greeting) {
      const turn = this.newTurn(s);
      this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
      this.say(client, s, turn, greeting);
      void this.finish(client, s, turn, 'saludo');
    }
  }

  private end(s: Session) {
    if (!s.ready) return;
    s.ready = false; this.active--;
    s.turn?.ctrl.abort(); s.stt?.close(); s.spec?.ctrl.abort(); clearTimeout(s.specTimer);
    if (s.visitor && s.userTurns > 0) void this.remember(s);
    for (const t of s.timers) { clearTimeout(t); clearInterval(t); }
    this.log.log(`sesion #${s.n} cerrada (${this.active}/${this.cfg.maxSessions})`);
  }

  // ---------- escucha ----------
  private onTranscript(client: WebSocket, s: Session, text: string, isFinal: boolean, speechFinal: boolean, lang?: string) {
    if (text) {
      s.lastActivity = Date.now();
      if (lang) s.lastLang = lang;
      if (isFinal) { s.finals.push(text); if (lang) s.langs.push(lang); }
      const current = [...s.finals, isFinal ? '' : text].join(' ').trim();
      const busy = !!s.turn || s.clientPlaying;
      if (busy) {
        // El avatar esta respondiendo. Solo se interrumpe si se reconocen varias palabras (evita cortes por eco o ruido).
        if (words(current) >= this.cfg.bargeInWords) this.interrupt(client, s);
      }
      if (!(s.turn || s.clientPlaying)) {
        this.send(client, { type: 'user_partial', text: current });
        // Arranque anticipado: si pasan 150 ms sin texto nuevo, se le pide la respuesta al modelo con lo que hay.
        // Si al confirmarse el fin de frase el texto es el mismo, esa respuesta ya va adelantada; si no, se descarta.
        clearTimeout(s.specTimer);
        if (!speechFinal && words(current) >= 2) s.specTimer = setTimeout(() => this.speculate(s, current), 150);
      }
    }
    if (speechFinal) this.commit(client, s);
  }

  private commit(client: WebSocket, s: Session) {
    const text = s.finals.join(' ').trim();
    const lang = s.langs.sort((a, b) => s.langs.filter((v) => v === b).length - s.langs.filter((v) => v === a).length)[0] ?? 'es';
    s.finals = []; s.langs = []; clearTimeout(s.specTimer);
    if (!text) return;
    if (s.turn || s.clientPlaying) return; // palabras sueltas mientras el avatar habla: se descartan
    void this.respond(client, s, text, lang);
  }

  private interrupt(client: WebSocket, s: Session) {
    this.log.log(`sesion #${s.n}: interrupcion del usuario`);
    s.turn?.ctrl.abort(); s.turn = undefined; s.clientPlaying = false;
    this.send(client, { type: 'interrupt' });
  }

  // ---------- respuesta ----------
  private newTurn(s: Session): Turn {
    s.turn?.ctrl.abort();
    const turn: Turn = { id: ++s.turnId, ctrl: new AbortController(), t0: Date.now(), samples: 0, chain: Promise.resolve(), spoken: '', tags: '', lang: 'es', ttsActive: 0, ttsWaiters: [] };
    s.turn = turn; s.clientPlaying = true;
    return turn;
  }

  /** Pide por adelantado la respuesta a `text` (primera ronda del modelo) y la va guardando. */
  private speculate(s: Session, text: string) {
    if (!s.ready || s.turn || s.clientPlaying) return;
    const lang = s.lastLang;
    if (s.spec && norm(s.spec.text) === norm(text) && s.spec.lang === lang) return;
    s.spec?.ctrl.abort();
    const spec: Spec = { text, lang, ctrl: new AbortController(), events: [], done: false };
    s.spec = spec;
    (async () => {
      const tools = await this.tools.definitions(s.owner);
      for await (const ev of this.llm.chat([...s.history, { role: 'user', content: userMsg(text, lang) }], tools, spec.ctrl.signal)) {
        if (ev.type === 'text') spec.tFirst ??= Date.now();
        spec.events.push(ev); spec.wake?.();
      }
    })().catch((e) => { spec.err = e as Error; }).finally(() => { spec.done = true; spec.wake?.(); });
  }
  private async *drain(spec: Spec): AsyncGenerator<LlmEvent> {
    for (let i = 0; ; ) {
      while (i < spec.events.length) yield spec.events[i++];
      if (spec.done) { if (spec.err) throw spec.err; return; }
      await new Promise<void>((r) => (spec.wake = r));
    }
  }

  private async respond(client: WebSocket, s: Session, userText: string, lang = 'es') {
    const turn = this.newTurn(s);
    turn.lang = lang; s.userTurns++;
    // Respuesta adelantada: sirve solo si se pidio con el mismo texto que quedo como definitivo.
    const spec = s.spec && norm(s.spec.text) === norm(userText) && s.spec.lang === lang && !s.spec.err ? s.spec : undefined;
    if (!spec) s.spec?.ctrl.abort();
    s.spec = undefined;
    if (spec) turn.ctrl.signal.addEventListener('abort', () => spec.ctrl.abort());
    let hit = !!spec;
    this.send(client, { type: 'user_final', text: userText });
    this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
    s.history.push({ role: 'user', content: userMsg(userText, lang) });
    if (s.history.length > 41) s.history.splice(1, s.history.length - 41); // system + ultimos 40 mensajes
    try {
      let buffer = '';
      for (let round = 0; round < (s.owner ? 6 : 4); round++) {
        let toolCalls: { id: string; name: string; arguments: string }[] = [];
        let text = '';
        const source = round === 0 && spec ? this.drain(spec) : this.llm.chat(s.history, await this.tools.definitions(s.owner), turn.ctrl.signal);
        for await (const ev of source) {
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
        // Mientras se consulta la herramienta, el avatar dice una frase corta para no quedarse callado.
        if (!turn.spoken) this.say(client, s, turn, turn.lang !== 'es' ? (FILLER_OTHER[turn.lang] ?? 'One moment.') : FILLERS[toolCalls[0].name] ?? (toolCalls[0].name.startsWith('plane_') ? FILLERS.plane_ : 'Dame un segundo.'));
        for (const c of toolCalls) {
          let result: string;
          if (c.name === 'registrar_interesado' && s.leads >= 3) result = 'No se guardó: ya se registraron varios contactos en esta conversación.';
          else {
            const out = await this.tools.run(c.name, c.arguments, s.owner);
            result = out.text;
            if (c.name === 'registrar_interesado' && result.startsWith('Guardado')) s.leads++;
            // Efectos que dependen del dato consultado: fondo del clima, billetes del dolar.
            if (out.scene && !turn.ctrl.signal.aborted) { turn.sceneLocked = true; this.send(client, { type: 'scene', name: out.scene }); }
            if (out.reaction && !turn.ctrl.signal.aborted) this.send(client, { type: 'reaction', name: out.reaction });
          }
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
    await this.finish(client, s, turn, hit ? 'turno (adelantado)' : 'turno');
  }

  /** Saca las etiquetas [r:...] y [f:...] del inicio del texto y avisa al navegador. */
  private takeTags(client: WebSocket, turn: Turn, buffer: string): string {
    let m: RegExpMatchArray | null;
    while ((m = buffer.match(TAG_HEAD))) {
      const kind = m[1].toLowerCase(), name = m[2].toLowerCase();
      turn.tags += `[${kind}:${name}]`;
      if (kind === 'r' && REACTIONS.has(name)) this.send(client, { type: 'reaction', name });
      if (kind === 'f' && SCENES.has(name) && !turn.sceneLocked) this.send(client, { type: 'scene', name });
      if (kind === 'c') { const card = this.cards.get(name); if (card) this.send(client, { type: 'card', ...card }); }
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
    // ElevenLabs limita las peticiones simultaneas por cuenta: como mucho 2 frases de este turno a la vez, y un reintento
    // si aun asi responde que hay demasiadas.
    (async () => {
      while (turn.ttsActive >= 2) await new Promise<void>((r) => turn.ttsWaiters.push(r));
      turn.ttsActive++;
      try {
        for (let attempt = 0; ; attempt++) {
          try { for await (const c of this.tts.stream(text, turn.ctrl.signal, turn.lang)) { buf.push(c); wake?.(); } break; }
          catch (e) { if (attempt >= 2 || buf.length || !/429/.test((e as Error).message) || turn.ctrl.signal.aborted) throw e; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
        }
      } finally { turn.ttsActive--; turn.ttsWaiters.shift()?.(); }
    })()
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

  /** Al cerrar la conversacion: guarda el nombre y un resumen corto para reconocer a la persona si vuelve. */
  private async remember(s: Session) {
    try {
      const talk = s.history.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => `${m.role === 'user' ? 'Persona' : 'Avatar'}: ${String(m.content).replace(TAG_ANY, '').trim()}`).join('\n').slice(-6000);
      const out = await this.llm.complete([
        { role: 'system', content: 'Devuelve SOLO un JSON con dos campos: "nombre" (el nombre que dijo la persona, o "" si no lo dijo) y "resumen" (una o dos frases en español sobre qué quería y en qué quedaron). Sin datos de contacto.' },
        { role: 'user', content: talk },
      ]);
      const d = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      this.memory.save(s.visitor!, String(d.nombre ?? '').trim(), String(d.resumen ?? '').trim());
    } catch (e) { this.log.warn(`sesion #${s.n}: no se pudo guardar la memoria (${(e as Error).message})`); }
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
