import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { OwnerService } from '../owner/owner.service';
import { INTERNAL } from '../calls/call-socket';
import { ConfigService } from '../config/config.service';
import { CardsService } from '../cards/cards.service';
import { DeepSeekService, LlmEvent } from '../llm/deepseek.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MODELS, WorkshopService } from '../workshop/workshop.service';
import { MusicService, MusicState } from '../music/music.service';
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
  callerPhone?: string;  // llamada de WhatsApp: numero de quien llama (lo pone el servidor, nunca el navegador)
  userTurns: number;
  langs: string[];       // idiomas detectados en la frase en curso
  lastLang: string;      // idioma del ultimo texto reconocido (tambien en resultados parciales)
  spec?: Spec;
  ctxCache?: { key: string; ctx: Promise<string> }; // contexto de la base de conocimiento para la frase en curso
  specTimer?: NodeJS.Timeout;
  leads: number;         // interesados guardados en esta sesion (tope contra abuso)
  timers: NodeJS.Timeout[];
  origin: string;        // direccion publica por la que entro (para enlaces y QR)
  notes: { text: string; card?: unknown; slug?: string }[]; // avisos del taller pendientes de contar
  noteTimer?: NodeJS.Timeout;
  startedAt: number;
  music?: MusicState;    // musica de fondo (solo dueño)
  browserTts: boolean;   // habla el navegador (sin clave de ElevenLabs): se envia el texto, no el audio
  lastPlayEnd: number;   // cuando el navegador termino de reproducir la ultima respuesta
  lastSpoken: string;    // lo ultimo que dijo el avatar (para reconocer su propio eco con la voz del navegador)
  lastTurnEnd: number;   // cuando termino el ultimo turno (para no interrumpir con el estado del taller)
  lastStatus: number;    // ultima vez que se conto en voz como va el taller
  suspended: boolean;    // modo suspension: oye pero no responde hasta que digan la palabra para despertar
  suspendedAt: number;
  waking: boolean;       // acaba de despertar: la frase en curso empieza por la palabra para despertar
  canSuspend: boolean;   // las llamadas de WhatsApp no se suspenden
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const plainWords = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9ñ]+/).filter(Boolean);

/**
 * Modo suspension (pedido por Javier el 2026-11-17): si la frase ENTERA es una orden de callarse, el avatar deja de
 * responder. Se compara la frase completa (sin muletillas) para que "para" dentro de otra frase no lo suspenda.
 */
const SUSPEND_FILLERS = new Set(['javi', 'javier', 'por', 'favor', 'ya', 'oye', 'un', 'momento', 'rato', 'ahora', 'porfa']);
const SUSPEND_ORDERS = new Set(['silenciate', 'silencio', 'hazsilencio', 'guardasilencio', 'callate', 'para', 'parale', 'detente', 'suspendete', 'suspension',
  'modosuspension', 'entraensuspension', 'ponteensuspension', 'duermete', 'aduermete', 'adormir', 'descansa', 'pausa', 'ponteenpausa', 'dejadeescuchar', 'noescuches', 'nomeescuches']);
const isSuspendOrder = (text: string, names: string[]) => { const w = plainWords(text); return w.length <= 6 && SUSPEND_ORDERS.has(w.filter((x) => !SUSPEND_FILLERS.has(x) && !names.includes(x)).join('')); };

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
  programar: 'Listo, se lo paso a Claude Code.',
  estado_taller: 'Déjame ver cómo va el taller.',
  cancelar_encargo: 'Ya lo detengo.',
  mostrar_proyecto: 'Ya te lo muestro.',
  musica: 'Va.',
  resumen_del_dia: 'Déjame revisar qué hay de nuevo.',
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

/** Como usar el taller de programacion. Va solo en sesiones del dueño y si hay token de Claude Code. */
const TALLER_RULES = (def: string) => `

TALLER DE PROGRAMACIÓN: puedes encargarle trabajos de programación a Claude Code con la herramienta programar. Tú no programas: conversas con Javier, entiendes lo que quiere y le pasas el encargo completo.
- Antes de llamar a programar asegúrate de tener lo esencial (qué es, para quién y qué debe lograr). Si falta algo importante, pregúntalo en una sola frase; si Javier dice que decidas tú, decide.
- Modelo: la primera vez que Javier pida programar algo en esta conversación, ANTES de llamar a programar dile: "Por defecto uso ${def}. ¿Lo dejo así o prefieres otro? Tengo ${MODELS.map((m) => m.label).join(', ')}." Usa su respuesta en el parámetro modelo (si dice que lo dejes, omítelo) y no vuelvas a preguntarlo en esta conversación, salvo que él pida cambiarlo.
- Si el encargo es grande, Claude Code lo reparte solo entre varios agentes; no tienes que pedírselo.
- Mientras trabaja, el sistema le va contando a Javier cómo va; si él pregunta, usa estado_taller.
- En "encargo" escribe todo lo que Javier dijo, con sus detalles: Claude Code no oye esta conversación.
- El trabajo tarda minutos y corre en segundo plano: dile que ya empezó y sigue conversando. No digas que terminó hasta que llegue el aviso del taller.
- Un mensaje que empieza por "(Aviso del taller" lo escribió el sistema, no Javier: cuéntale el resultado en dos o tres frases, sin leer nombres de archivos ni código; si Claude Code dejó una pregunta, hazla. Si hay sitio publicado, dile que el código QR está en pantalla.
- Para cambios ("ponle otro color", "agrega precios") vuelve a llamar a programar con el mismo proyecto.
- Solo hay un encargo a la vez. Usa estado_taller si pregunta cómo va, cancelar_encargo si pide detenerlo y mostrar_proyecto para volver a mostrar un código QR.`;

/** Musica de fondo. Va solo en sesiones del dueño y si hay clave de YouTube. */
const MUSIC_RULES = (def: string, taller: boolean) => `

MÚSICA: con la herramienta musica puedes poner música de YouTube de fondo en la pantalla de Javier (suena bajito y baja sola cuando alguien habla).
${taller ? '- Cuando acabes de iniciar un encargo de programación (y no haya música sonando), pregúntale en la misma respuesta: "¿Quieres escuchar alguna canción mientras tanto?".\n' : ''}- Si dice una canción, artista o género, ponla. Si dice "lo que sea", "pon algo" o algo parecido, pon "${def}". Si dice que no, no insistas.
- También puede pedir música en cualquier momento, aunque no esté programando. Obedece sus órdenes de volumen, pausa, siguiente, cambio de canción y "qué suena".
- Al confirmar, una frase corta; no leas títulos largos ni enlaces.`;

/**
 * WebSocket del navegador.
 *  cliente -> JSON { type: 'hello', code? } | { type: 'playback', playing } ; binario: PCM16 mono 16 kHz del microfono
 *  servidor -> { type: 'ready' } | { type: 'error', reason }
 *              { type: 'user_partial', text } | { type: 'user_final', text }
 *              { type: 'speech_start', id, sampleRate } , { type: 'audio', id, audio, align? } ... , { type: 'speech_end', id }
 *              { type: 'card', title, lines, qr?, caption? }  (tarjeta en pantalla)
 *              { type: 'reaction', name } | { type: 'scene', name }  (gesto y emojis / fondo, segun lo que pidio el modelo)
 *              { type: 'interrupt' }  (el usuario hablo encima: cortar el audio)
 *              { type: 'suspend', on, notice? }  (modo suspension; el cliente despierta con { type: 'wake' } al tocar la pantalla)
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
    private readonly knowledge: KnowledgeService, private readonly workshop: WorkshopService, private readonly music: MusicService,
  ) {
    // Cuando Claude Code termina un encargo, se le cuenta a Javier en las sesiones de dueño abiertas.
    this.workshop.onDone((d) => { for (const [s, client] of this.owners) void this.workshopNote(client, s, d.project.slug); });
    // Progreso del encargo: la pantalla del dueño muestra el fondo de trabajo, el estado y el codigo en las gafas.
    this.workshop.onProgress((w) => { for (const [, client] of this.owners) this.send(client, { type: 'work', ...w, spoken: undefined }); });
  }
  private readonly owners = new Map<Session, WebSocket>();

  /** Prepara el aviso de un proyecto terminado (texto para el modelo + tarjeta con QR) y lo pone en cola. */
  private async workshopNote(client: WebSocket, s: Session, slug: string) {
    const p = this.workshop.list().find((x) => x.slug === slug);
    if (!p || !s.ready) return;
    const card = await this.workshop.card(slug, s.origin).catch(() => null);
    const text = `(Aviso del taller, escrito por el sistema: Claude Code ${p.status === 'error' ? 'NO pudo terminar' : 'terminó'} el encargo del proyecto "${p.name}". ` +
      `${card ? 'El sitio está publicado y su código QR se muestra en pantalla. ' : 'No hay sitio publicado para este proyecto. '}Informe de Claude Code: ${(p.lastSummary ?? 'sin informe').slice(0, 1500)})`;
    s.notes.push({ text, card: card ?? undefined, slug });
    if (s.suspended) this.send(client, { type: 'suspend', on: true, notice: this.suspendNotice(s) }); // suspendido: aviso en pantalla, sin voz
    this.pumpNotes(client, s);
  }

  /** Mientras Claude Code trabaja, el avatar cuenta cada cierto tiempo como va (sin pasar por el modelo). */
  private workshopStatus(client: WebSocket, s: Session) {
    const w = this.workshop.state();
    if (!w.active) return;
    s.lastActivity = Date.now(); // la sesion no se cierra por inactividad mientras hay un encargo en curso
    const every = this.cfg.tallerStatusSeconds * 1000, now = Date.now();
    if (!every || s.suspended || s.turn || s.clientPlaying || s.finals.length || s.notes.length) return;
    if (now - Math.max(s.lastStatus, now - (w.seconds ?? 0) * 1000) < every || now - s.lastTurnEnd < 15_000) return;
    s.lastStatus = now;
    const min = Math.floor((w.seconds ?? 0) / 60), time = min < 1 ? 'menos de un minuto' : min === 1 ? 'un minuto' : `${min} minutos`;
    const agents = w.agentsTotal ? ` Ha repartido el trabajo en ${w.agentsTotal === 1 ? 'un agente' : `${w.agentsTotal} agentes`}.` : ''; // los agentes corren en segundo plano: solo se sabe cuantos lanzo
    const turn = this.newTurn(s);
    this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
    this.say(client, s, turn, `Sigo con ${w.project}: van ${time} y ${w.steps} pasos.${agents} Ahora ${w.spoken}.`);
    void this.finish(client, s, turn, 'estado del taller');
  }

  /** Cuenta el siguiente aviso cuando nadie esta hablando (ni Javier ni el avatar). */
  private pumpNotes(client: WebSocket, s: Session) {
    clearTimeout(s.noteTimer);
    if (!s.ready || !s.notes.length || s.suspended) return; // suspendido: se cuentan al despertar
    if (s.turn || s.clientPlaying || s.finals.length) { s.noteTimer = setTimeout(() => this.pumpNotes(client, s), 1000); return; }
    const note = s.notes.shift()!;
    if (note.card) this.send(client, { type: 'card', ...(note.card as object) });
    if (note.slug) this.workshop.markSeen(note.slug);
    s.lastActivity = Date.now();
    void this.respond(client, s, note.text, 'es', true).then(() => this.pumpNotes(client, s));
  }

  handleConnection(client: WebSocket, req?: IncomingMessage) {
    const internal = !!(client as any)[INTERNAL]; // llamada de WhatsApp creada por el propio servidor
    // El modo dueño se decide aqui, con la cookie del dispositivo; nada de lo que se diga en la conversacion lo cambia.
    const owner = !!this.ownerAuth.verify(req?.headers?.cookie);
    const s: Session = { n: ++this.counter, ready: false, owner, history: [], finals: [], turnId: 0, clientPlaying: false, lastActivity: Date.now(), leads: 0, userTurns: 0, langs: [], lastLang: 'es', timers: [], notes: [], startedAt: Date.now(), lastTurnEnd: Date.now(), lastStatus: 0, suspended: false, suspendedAt: 0, waking: false, canSuspend: !internal, browserTts: this.cfg.ttsProvider === 'browser' && !internal, lastSpoken: '', lastPlayEnd: 0,
      origin: req?.headers?.host ? `${String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim()}://${req.headers.host}` : '' };
    const authTimer = setTimeout(() => { if (!s.ready) client.close(4401, 'sin saludo'); }, 10_000);
    client.on('message', (raw, isBinary) => {
      if (isBinary) { if (s.ready) s.stt?.send(raw as Buffer); return; }
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!s.ready) {
        if (msg?.type !== 'hello') return;
        if (!s.owner && !internal && !this.codeOk(String(msg.code ?? ''))) { this.send(client, { type: 'error', reason: 'codigo' }); client.close(4401, 'codigo'); return; }
        if (this.active >= this.cfg.maxSessions) { this.send(client, { type: 'error', reason: 'ocupado' }); client.close(4429, 'ocupado'); return; }
        if (!s.owner && this.memory.valid(msg.visitor)) s.visitor = msg.visitor;
        if (internal && typeof msg.phone === 'string' && /^\+?\d{8,15}$/.test(msg.phone)) s.callerPhone = msg.phone;
        clearTimeout(authTimer); this.start(client, s);
        return;
      }
      // El navegador avisa cuando la musica cambia sola de cancion o se detiene (fin de la cola, error del reproductor).
      if (msg?.type === 'music' && s.music) { if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < s.music.queue.length) s.music.index = msg.index; if (typeof msg.playing === 'boolean') s.music.playing = msg.playing; return; }
      if (msg?.type === 'wake') { if (s.suspended) { this.wake(client, s); this.greetAwake(client, s); } return; } // toque en la pantalla
      if (msg?.type === 'playback' && !msg.playing) s.lastPlayEnd = Date.now();
      if (msg?.type === 'playback' && !(s.turn && !msg.playing)) s.clientPlaying = !!msg.playing; // mientras el turno sigue generando, se considera hablando
    });
    client.on('close', () => { clearTimeout(authTimer); this.end(s); });
    client.on('error', () => this.end(s));
  }

  private start(client: WebSocket, s: Session) {
    s.ready = true; this.active++;
    if (s.owner && !s.callerPhone && this.music.enabled) s.music = this.music.newState();
    this.log.log(`sesion #${s.n} abierta${s.owner ? ' [DUEÑO]' : ''} (${this.active}/${this.cfg.maxSessions})`);
    const known = s.visitor ? this.memory.get(s.visitor) : null;
    const cardIds = this.cards.ids();
    const cardRules = cardIds.length
      ? `\nTarjetas en pantalla: si tu respuesta trata de uno de estos temas, agrega UNA etiqueta [c:tema] para mostrar su tarjeta: ${cardIds.filter((c) => c !== 'contacto').join(', ')}.` +
        (cardIds.includes('contacto') ? ' Si la persona quiere contactar a Javier, seguir por WhatsApp o prefiere no dictar sus datos, agrega [c:contacto] para mostrarle un código QR y dile que lo escanee.' : '')
      : '';
    const callNote = s.callerPhone
      ? `\n\nEsta conversación es una LLAMADA de WhatsApp: no hay pantalla, solo voz. La persona llama desde el número ${s.callerPhone}. Si quiere que Javier la contacte, NO le pidas el número: usa ese mismo como contacto, confírmale que la contactarán a ese WhatsApp y pídele su autorización. No ofrezcas códigos QR ni nada visual.`
      : '';
    const memoryNote = known
      ? `\n\nYa conoces a esta persona de una visita anterior${known.name ? `: se llama ${known.name}` : ''}. Lo que hablaron: ${known.summary || 'no hay resumen'}. Salúdala como a alguien conocido y no le vuelvas a pedir datos que ya dio.`
      : '';
    s.history.push({ role: 'system', content: this.cfg.systemPrompt + (s.owner && this.cfg.ownerPrompt ? '\n\n' + this.cfg.ownerPrompt : LEAD_RULES) + (s.owner && this.workshop.enabled ? TALLER_RULES(this.workshop.defaultModel.label) : '') + (s.music ? MUSIC_RULES(this.cfg.musicDefaultQuery, this.workshop.enabled) : '') + TAG_RULES + (s.callerPhone ? '' : cardRules) + callNote + memoryNote });
    s.stt = this.stt.open({
      onTranscript: (text, isFinal, speechFinal, lang) => this.onTranscript(client, s, text, isFinal, speechFinal, lang),
      onUtteranceEnd: () => this.commit(client, s),
      onClose: (reason) => { if (s.ready) { this.log.warn(`sesion #${s.n}: Deepgram se cerro (${reason})`); this.send(client, { type: 'error', reason: 'escucha' }); client.close(1011, 'stt'); } },
    });
    // Limites: duracion maxima de la sesion e inactividad.
    s.startedAt = Date.now();
    s.timers.push(setInterval(() => {
      const job = s.owner && !!this.workshop.busy(); // con un encargo en curso la sesion del dueño sigue abierta para ir contandole
      if (job) this.workshopStatus(client, s);
      // Con musica sonando la sesion tambien sigue abierta (para obedecer "subele" o "quitala"), hasta MUSIC_MAX_MINUTES.
      const listening = !!s.music?.playing && Date.now() - s.music.since < this.cfg.musicMaxMinutes * 60_000;
      if (listening) s.lastActivity = Date.now();
      // Suspendido: la sesion sigue abierta para oir la palabra que lo despierta, hasta SUSPEND_MAX_MINUTES.
      if (s.suspended) {
        if (Date.now() - s.suspendedAt > this.cfg.suspendMaxMinutes * 60_000) { this.send(client, { type: 'error', reason: 'suspension' }); client.close(4408, 'suspension'); return; }
        s.lastActivity = Date.now();
      }
      const working = job || listening || s.suspended;
      if (!working && Date.now() - s.startedAt > this.cfg.sessionMaxSeconds * 1000) { this.send(client, { type: 'error', reason: 'tiempo' }); client.close(4408, 'duracion'); return; }
      if (Date.now() - s.lastActivity > this.cfg.idleSeconds * 1000) { this.send(client, { type: 'error', reason: 'inactividad' }); client.close(4408, 'inactividad'); }
    }, 5000));
    this.send(client, { type: 'ready', owner: s.owner, wake: this.cfg.wakeWords[0], tts: s.browserTts ? 'browser' : 'server', voice: this.cfg.browserVoice, rate: this.cfg.browserVoiceRate });
    const greeting = s.owner ? this.ownerGreeting() : known?.name ? `¡Hola de nuevo, ${known.name}! ¿En qué te ayudo hoy?` : this.cfg.greeting;
    if (greeting) {
      const turn = this.newTurn(s);
      this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
      this.say(client, s, turn, greeting);
      void this.finish(client, s, turn, 'saludo');
    }
    if (s.owner) {
      this.owners.set(s, client);
      if (this.workshop.busy()) this.send(client, { type: 'work', ...this.workshop.state(), spoken: undefined });
      // Encargos que terminaron cuando no habia una sesion abierta: se cuentan despues del saludo.
      for (const p of this.workshop.unseen()) void this.workshopNote(client, s, p.slug);
    }
  }

  /** Saludo del dueño segun la hora; en la primera sesion de cada dia ofrece el resumen. */
  private lastOwnerDay = '';
  private ownerGreeting(): string {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.cfg.timezone, hour: '2-digit', hour12: false }).format(now));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(now);
    const hello = hour >= 5 && hour < 12 ? 'Buenos días' : hour >= 12 && hour < 19 ? 'Buenas tardes' : 'Buenas noches';
    if (day !== this.lastOwnerDay) { this.lastOwnerDay = day; return `${hello}, Javier. ¿Te cuento el resumen de hoy?`; }
    return `${hello}, Javier, aquí estoy. ¿Qué revisamos?`;
  }

  private end(s: Session) {
    if (!s.ready) return;
    s.ready = false; this.active--; this.owners.delete(s); clearTimeout(s.noteTimer);
    s.turn?.ctrl.abort(); s.stt?.close(); s.spec?.ctrl.abort(); clearTimeout(s.specTimer);
    if (s.visitor && s.userTurns > 0) void this.remember(s);
    for (const t of s.timers) { clearTimeout(t); clearInterval(t); }
    this.log.log(`sesion #${s.n} cerrada (${this.active}/${this.cfg.maxSessions})`);
  }

  // ---------- escucha ----------
  private onTranscript(client: WebSocket, s: Session, text: string, isFinal: boolean, speechFinal: boolean, lang?: string) {
    if (s.suspended) {
      // Suspendido: lo que se oye se descarta (no va al modelo, ni a la pantalla, ni se guarda). Solo cuenta la palabra
      // para despertar; mientras suena la despedida no se atiende, para que no lo despierte su propia voz.
      s.finals = []; s.langs = [];
      if (!text || s.turn || s.clientPlaying || Date.now() - s.suspendedAt < 2500 || !this.hasWakeWord(text)) return;
      this.wake(client, s);
    }
    if (text) {
      s.lastActivity = Date.now();
      if (lang) s.lastLang = lang;
      if (isFinal) { s.finals.push(text); if (lang) s.langs.push(lang); }
      const current = [...s.finals, isFinal ? '' : text].join(' ').trim();
      const busy = !!s.turn || s.clientPlaying;
      if (busy) {
        // El avatar esta respondiendo. Solo se interrumpe si se reconocen varias palabras (evita cortes por eco o ruido).
        if (isFinal && s.canSuspend && isSuspendOrder(current, this.cfg.wakeWords) && !this.isEcho(s, current)) { this.suspend(client, s); return; } // "para", "silénciate"
        if (words(current) >= this.cfg.bargeInWords && !this.isEcho(s, current)) this.interrupt(client, s);
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
    if (!text || s.suspended) return;
    if (s.waking) { // acaba de despertar: si solo dijeron su nombre, responde que ya esta; si siguio una pregunta, la contesta
      s.waking = false;
      const rest = plainWords(text).filter((w) => !this.cfg.wakeWords.includes(w));
      if (rest.length < 2) { this.greetAwake(client, s); return; }
    }
    if (s.turn || s.clientPlaying) return; // palabras sueltas mientras el avatar habla: se descartan
    if (s.canSuspend && isSuspendOrder(text, this.cfg.wakeWords)) { this.suspend(client, s); return; }
    if (this.isEcho(s, text) && Date.now() - Math.max(s.lastTurnEnd, s.lastPlayEnd) < 6000) return; // el microfono oyo la cola de la voz del navegador
    void this.respond(client, s, text, lang).then(() => this.pumpNotes(client, s));
  }

  /**
   * Con la voz del navegador el cancelador de eco no siempre quita lo que dice el avatar: si casi todas las palabras
   * reconocidas estan en lo que el avatar esta diciendo (o acaba de decir), es su propio eco y no una interrupcion.
   */
  private isEcho(s: Session, heard: string): boolean {
    if (!s.browserTts) return false;
    const wordsOf = (t: string) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9ñ]+/).filter(Boolean);
    const spoken = new Set(wordsOf(`${s.turn?.spoken ?? ''} ${s.lastSpoken}`));
    const list = wordsOf(heard);
    if (!list.length || !spoken.size) return false;
    return list.filter((w) => spoken.has(w)).length / list.length >= 0.7;
  }

  // ---------- suspension ----------
  private hasWakeWord(text: string) { return plainWords(text).some((w) => this.cfg.wakeWords.includes(w)); }
  private suspendNotice(s: Session) { return s.notes.length ? (s.notes.length === 1 ? 'El taller terminó un encargo' : `El taller terminó ${s.notes.length} encargos`) : ''; }

  /** Deja de responder: se despide en una frase y queda oyendo solo la palabra para despertar. */
  private suspend(client: WebSocket, s: Session) {
    if (s.suspended) return;
    this.log.log(`sesion #${s.n}: suspendida`);
    if (s.turn || s.clientPlaying) this.interrupt(client, s);
    s.spec?.ctrl.abort(); s.spec = undefined; clearTimeout(s.specTimer); clearTimeout(s.noteTimer); s.finals = []; s.langs = [];
    s.suspended = true; s.suspendedAt = Date.now(); s.waking = false;
    this.send(client, { type: 'suspend', on: true, notice: this.suspendNotice(s) });
    const turn = this.newTurn(s);
    this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
    this.say(client, s, turn, 'Listo, me quedo callado. Llámame por mi nombre cuando me necesites.'); // sin decir la palabra: se despertaria solo
    void this.finish(client, s, turn, 'suspension');
  }

  private wake(client: WebSocket, s: Session) {
    if (!s.suspended) return;
    this.log.log(`sesion #${s.n}: despierta tras ${Math.round((Date.now() - s.suspendedAt) / 1000)} s`);
    s.suspended = false; s.waking = true; s.lastActivity = Date.now(); s.finals = []; s.langs = [];
    this.send(client, { type: 'suspend', on: false });
    // Si despues del nombre no llega nada mas (ni fin de frase), igual contesta.
    s.timers.push(setTimeout(() => { if (s.ready && s.waking && !s.suspended && !s.finals.length) this.greetAwake(client, s); }, 2500));
  }

  /** "Aquí estoy" y, si hay avisos del taller guardados, los cuenta enseguida. */
  private greetAwake(client: WebSocket, s: Session) {
    s.waking = false;
    if (s.turn || s.clientPlaying) return;
    const turn = this.newTurn(s);
    this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
    this.say(client, s, turn, s.notes.length ? 'Aquí estoy. Tengo novedades del taller.' : 'Aquí estoy. ¿En qué te ayudo?');
    void this.finish(client, s, turn, 'despertar').then(() => this.pumpNotes(client, s));
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

  /**
   * Fragmentos de la base de conocimiento que tienen que ver con lo que dijo la persona, listos para pegar al mensaje.
   * Se guarda por texto: el arranque anticipado y la respuesta definitiva comparten la misma consulta.
   */
  private context(s: Session, text: string): Promise<string> {
    if (!this.knowledge.enabled || words(text) < 3) return Promise.resolve('');
    const key = norm(text);
    if (s.ctxCache?.key === key) return s.ctxCache.ctx;
    const t0 = Date.now();
    const ctx = this.knowledge.search(text, s.owner, AbortSignal.timeout(900)) // si tarda, se responde sin contexto en vez de hacer esperar
      .then((hits) => {
        if (!hits.length) return '';
        this.log.debug?.(`sesion #${s.n}: conocimiento ${hits.length} fragmentos en ${Date.now() - t0} ms`);
        return '\n\n(Información de referencia sobre Javier, tomada de su base de conocimiento. Úsala solo si sirve para responder; no la leas literal ni menciones que existe:\n' +
          hits.map((h) => `- ${h.text.replace(/\s+/g, ' ')}`).join('\n') + ')';
      })
      .catch((e) => { this.log.warn(`sesion #${s.n}: base de conocimiento no disponible (${(e as Error).message})`); return ''; });
    s.ctxCache = { key, ctx };
    return ctx;
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
      const [tools, ctx] = await Promise.all([this.tools.definitions(s.owner), this.context(s, text)]);
      for await (const ev of this.llm.chat([...s.history, { role: 'user', content: userMsg(text, lang) + ctx }], tools, spec.ctrl.signal, s.owner ? 2000 : 400)) {
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

  private async respond(client: WebSocket, s: Session, userText: string, lang = 'es', auto = false) {
    const turn = this.newTurn(s);
    turn.lang = lang; if (!auto) s.userTurns++;
    // Respuesta adelantada: sirve solo si se pidio con el mismo texto que quedo como definitivo.
    const spec = s.spec && norm(s.spec.text) === norm(userText) && s.spec.lang === lang && !s.spec.err ? s.spec : undefined;
    if (!spec) s.spec?.ctrl.abort();
    s.spec = undefined;
    if (spec) turn.ctrl.signal.addEventListener('abort', () => spec.ctrl.abort());
    let hit = !!spec;
    if (!auto) this.send(client, { type: 'user_final', text: userText }); // un aviso del sistema no se muestra como dicho por la persona
    this.send(client, { type: 'speech_start', id: turn.id, sampleRate: TTS_SAMPLE_RATE });
    const userEntry = { role: 'user', content: auto ? userText : userMsg(userText, lang) };
    s.history.push(userEntry);
    if (s.history.length > 41) s.history.splice(1, s.history.length - 41); // system + ultimos 40 mensajes
    try {
      let buffer = '';
      for (let round = 0; round < (s.owner ? 6 : 4); round++) {
        let toolCalls: { id: string; name: string; arguments: string }[] = [];
        let text = '';
        let source: AsyncGenerator<LlmEvent>;
        if (round === 0 && spec) source = this.drain(spec);
        else {
          // El contexto de conocimiento acompana al mensaje solo en este turno; en el historial queda el mensaje limpio.
          const ctx = auto ? '' : await this.context(s, userText);
          const view = ctx ? s.history.map((m) => (m === userEntry ? { ...m, content: m.content + ctx } : m)) : s.history;
          // En modo dueño el encargo para el taller va completo en los argumentos de la herramienta: necesita mas espacio.
          source = this.llm.chat(view, await this.tools.definitions(s.owner), turn.ctrl.signal, s.owner ? 2000 : 400);
        }
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
            const out = await this.tools.run(c.name, c.arguments, s.owner, { origin: s.origin, music: s.music });
            result = out.text;
            if (c.name === 'registrar_interesado' && result.startsWith('Guardado')) s.leads++;
            // Efectos que dependen del dato consultado: fondo del clima, billetes del dolar.
            if (out.scene && !turn.ctrl.signal.aborted) { turn.sceneLocked = true; this.send(client, { type: 'scene', name: out.scene }); }
            if (out.reaction && !turn.ctrl.signal.aborted) this.send(client, { type: 'reaction', name: out.reaction });
            if (out.card && !turn.ctrl.signal.aborted) this.send(client, { type: 'card', ...out.card });
            if (out.music) this.send(client, { type: 'music', ...out.music });
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
    if (s.browserTts) { // habla el navegador: va el texto y el lo dice con su propia voz
      turn.chain = turn.chain.then(() => { if (turn.ctrl.signal.aborted) return; turn.tAudio ??= Date.now(); this.send(client, { type: 'say', id: turn.id, text, lang: turn.lang }); });
      return;
    }
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
    s.lastTurnEnd = Date.now(); if (turn.spoken) s.lastSpoken = turn.spoken;
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
