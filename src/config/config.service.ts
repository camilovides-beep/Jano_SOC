import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';

/** Configuracion leida de variables de entorno y validada al arrancar. Las claves nunca salen del backend. */
@Injectable()
export class ConfigService {
  readonly port: number;
  /** Vacio = sin codigo de acceso. */
  readonly accessCode: string;
  readonly elevenApiKey: string;
  readonly elevenVoiceId: string;
  /** Voz: 'elevenlabs' (audio desde el servidor) o 'browser' (la voz del navegador). Sin clave de ElevenLabs es 'browser'. */
  readonly ttsProvider: 'elevenlabs' | 'browser';
  readonly browserVoice: string;
  readonly browserVoiceRate: number;
  readonly elevenModelId: string;
  readonly deepgramApiKey: string;
  readonly deepgramModel: string;
  readonly deepgramLanguage: string;
  readonly deepseekApiKey: string;
  readonly deepseekModel: string;
  readonly systemPrompt: string;
  readonly greeting: string;
  readonly timezone: string;
  readonly defaultCity: string;
  /** Clave para registrar dispositivos del dueño. Vacia = modo dueño desactivado. */
  readonly ownerSecret: string;
  readonly ownerDays: number;
  readonly ownerPrompt: string;
  readonly dataDir: string;
  readonly planeMcpUrl: string;
  readonly planeApiKey: string;
  /** URL opcional a la que se avisa cada interesado nuevo (por ejemplo un webhook de n8n). */
  readonly leadsWebhookUrl: string;
  /** Bot de Telegram que avisa cada interesado nuevo. Ambos vacios = sin aviso. */
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  /** Direccion del QR de contacto (por ejemplo un enlace de WhatsApp). Vacia = sin QR. */
  /** WhatsApp Cloud API: plantilla que se envia a cada interesado. Sin token = desactivado. */
  readonly whatsappToken: string;
  readonly whatsappPhoneNumberId: string;
  readonly whatsappTemplate: string;
  readonly whatsappTemplateLang: string;
  readonly whatsappHeaderImageUrl: string;
  readonly whatsappApiVersion: string;
  readonly whatsappDefaultCountry: string;
  /** Webhook de llamadas: token de verificacion, secreto de la app (firma de Meta) y secreto para eventos reenviados. */
  readonly whatsappVerifyToken: string;
  readonly whatsappAppSecret: string;
  readonly whatsappForwardSecret: string;
  /** Llamadas: modo (rechazar | prueba), IP publica del VPS, rango de puertos UDP del audio y limites. */
  /** n8n: webhook al que se reenvian los mensajes de WhatsApp y secreto compartido (cabecera X-Forward-Secret). */
  readonly n8nWebhookUrl: string;
  readonly n8nSecret: string;
  /** Taller de programacion (solo modo dueño): Claude Code con la suscripcion de Javier. Sin token = desactivado. */
  readonly claudeToken: string;
  readonly claudeBin: string;
  readonly claudeModel: string;
  /** Usuario del sistema con el que corre Claude Code (via sudo). Vacio = el mismo usuario del avatar (solo para local). */
  readonly tallerUser: string;
  readonly tallerMaxMinutes: number;
  readonly tallerMaxTurns: number;
  readonly tallerMaxProjects: number;
  readonly tallerNice: number;
  /** Cada cuantos segundos el avatar cuenta en voz como va el encargo (0 = no lo cuenta solo). */
  readonly tallerStatusSeconds: number;
  /** Musica de YouTube en modo dueño. Sin clave = sin musica. */
  readonly youtubeApiKey: string;
  readonly musicDefaultQuery: string;
  readonly musicVolume: number;
  readonly musicDailySearches: number;
  readonly musicMaxMinutes: number;
  readonly suspendMaxMinutes: number;
  /** Umbral de volumen (0..1) de la compuerta del microfono en esperas largas; 0 = sin compuerta. */
  readonly micGateRms: number;
  /** PostgreSQL (postgres://usuario:clave@host:5432/base). Vacio = SQLite en DATA_DIR. */
  readonly databaseUrl: string;
  /** Guardar tambien las conversaciones del sitio (no solo las llamadas). Apagado por defecto: implica avisar a los visitantes. */
  readonly saveConversations: boolean;
  /** Si la revision del sitio encuentra fallos, devolverselos una vez a Claude Code antes de avisar. */
  readonly tallerAutoFix: boolean;
  /** Encargos por sesion de Claude Code antes de empezar una nueva (que arranca leyendo ESTADO.md). */
  readonly tallerSessionJobs: number;
  /** Fotos de Pexels (vacia = sin busqueda de imagenes). Topes: busquedas por conversacion de un visitante y por dia. */
  readonly pexelsApiKey: string;
  readonly imagesPerSession: number;
  readonly imagesDailySearches: number;
  /** Precio en dolares por unidad de cada medida de consumo (opcional): USAGE_PRICES='{"deepgram_s":0.0001}'. */
  readonly usagePrices: Record<string, number>;
  readonly wakeWords: string[];
  /** Direccion publica del avatar (para enlaces y QR). Vacia = se toma de la conexion. */
  readonly publicUrl: string;
  readonly callMode: string;
  readonly callPublicIp: string;
  readonly callPortMin: number;
  readonly callPortMax: number;
  readonly callMax: number;
  readonly callTestSeconds: number;
  /** Base de conocimiento: embeddings de NVIDIA + Qdrant. Sin clave o sin direccion = desactivada. */
  readonly nvidiaApiKey: string;
  readonly embedModel: string;
  readonly qdrantUrl: string;
  readonly qdrantApiKey: string;
  readonly qdrantCollection: string;
  readonly knowledgeDir: string;
  readonly knowledgeTopK: number;
  readonly knowledgeMinScore: number;
  readonly contactUrl: string;
  readonly contactTitle: string;
  readonly contactCaption: string;
  readonly cardsFile: string;
  /** Tarjetas en pantalla (servicios y QR). Apagadas por defecto. */
  readonly cardsEnabled: boolean;
  /** Dias que se recuerda a un visitante (0 = sin memoria). */
  readonly visitorMemoryDays: number;
  readonly maxSessions: number;
  readonly sessionMaxSeconds: number;
  readonly idleSeconds: number;
  readonly bargeInWords: number;

  constructor() {
    const env = process.env;
    const str = (name: string, def = '') => (env[name] ?? def).trim();
    const required = (name: string): string => {
      const v = str(name);
      if (!v) throw new Error(`Falta la variable de entorno ${name}`);
      return v;
    };
    const int = (name: string, def: number, min = 0): number => {
      const v = Number(str(name, String(def)));
      if (!Number.isInteger(v) || v < min) throw new Error(`${name} debe ser un entero >= ${min}`);
      return v;
    };
    this.port = int('PORT', 3000, 1);
    this.accessCode = str('ACCESS_CODE');
    this.elevenApiKey = str('ELEVENLABS_API_KEY');
    this.elevenVoiceId = str('ELEVENLABS_VOICE_ID');
    // Sin clave (o sin voz) de ElevenLabs habla el navegador; TTS_PROVIDER=browser lo fuerza aunque haya clave.
    const wanted = str('TTS_PROVIDER').toLowerCase();
    if (wanted && wanted !== 'browser' && wanted !== 'elevenlabs') throw new Error('TTS_PROVIDER debe ser elevenlabs o browser');
    if (wanted === 'elevenlabs' && !(this.elevenApiKey && this.elevenVoiceId)) throw new Error('TTS_PROVIDER=elevenlabs necesita ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ID');
    this.ttsProvider = wanted === 'browser' || !(this.elevenApiKey && this.elevenVoiceId) ? 'browser' : 'elevenlabs';
    this.browserVoice = str('BROWSER_VOICE');
    this.browserVoiceRate = Number(str('BROWSER_VOICE_RATE', '1')) || 1;
    this.elevenModelId = str('ELEVENLABS_MODEL_ID', 'eleven_v4_turbo');
    this.deepgramApiKey = required('DEEPGRAM_API_KEY');
    this.deepgramModel = str('DEEPGRAM_MODEL', 'nova-3');
    this.deepgramLanguage = str('DEEPGRAM_LANGUAGE', 'multi');
    this.deepseekApiKey = required('DEEPSEEK_API_KEY');
    this.deepseekModel = str('DEEPSEEK_MODEL', 'deepseek-flash');
    this.timezone = str('TIMEZONE', 'America/Bogota');
    this.defaultCity = str('DEFAULT_CITY', 'Sincelejo');
    this.greeting = str('GREETING', '¡Hola! Soy Javier. ¿De qué quieres hablar?');
    this.maxSessions = int('MAX_SESSIONS', 2, 1);
    this.sessionMaxSeconds = int('SESSION_MAX_SECONDS', 600, 10);
    this.idleSeconds = int('IDLE_SECONDS', 120, 10);
    this.bargeInWords = int('BARGE_IN_WORDS', 3, 1);

    this.ownerSecret = str('OWNER_SECRET');
    this.ownerDays = int('OWNER_DAYS', 90, 1);
    this.dataDir = str('DATA_DIR', 'data');
    this.planeMcpUrl = str('PLANE_MCP_URL');
    this.planeApiKey = str('PLANE_API_KEY');
    this.leadsWebhookUrl = str('LEADS_WEBHOOK_URL');
    this.telegramBotToken = str('TELEGRAM_BOT_TOKEN');
    this.telegramChatId = str('TELEGRAM_CHAT_ID');
    this.whatsappToken = str('WHATSAPP_TOKEN');
    this.whatsappPhoneNumberId = str('WHATSAPP_PHONE_NUMBER_ID');
    this.whatsappTemplate = str('WHATSAPP_TEMPLATE');
    this.whatsappTemplateLang = str('WHATSAPP_TEMPLATE_LANG', 'es_MX');
    this.whatsappHeaderImageUrl = str('WHATSAPP_HEADER_IMAGE_URL');
    this.whatsappApiVersion = str('WHATSAPP_API_VERSION', 'v27.0');
    this.whatsappDefaultCountry = str('WHATSAPP_DEFAULT_COUNTRY', '57');
    this.whatsappVerifyToken = str('WHATSAPP_VERIFY_TOKEN');
    this.whatsappAppSecret = str('WHATSAPP_APP_SECRET');
    this.whatsappForwardSecret = str('WHATSAPP_FORWARD_SECRET');
    this.n8nWebhookUrl = str('N8N_WEBHOOK_URL');
    this.n8nSecret = str('N8N_SECRET');
    this.claudeToken = str('CLAUDE_CODE_OAUTH_TOKEN');
    this.claudeBin = str('CLAUDE_BIN', 'claude');
    this.claudeModel = str('CLAUDE_MODEL', 'claude-opus-5-5');
    this.tallerUser = str('TALLER_USER');
    this.tallerMaxMinutes = int('TALLER_MAX_MINUTES', 30, 1);
    this.tallerStatusSeconds = int('TALLER_STATUS_SECONDS', 90, 0);
    this.tallerMaxTurns = int('TALLER_MAX_TURNS', 200, 1);
    this.tallerMaxProjects = int('TALLER_MAX_PROJECTS', 50, 1);
    this.tallerNice = int('TALLER_NICE', 10, 0);
    this.youtubeApiKey = str('YOUTUBE_API_KEY');
    this.musicDefaultQuery = str('MUSIC_DEFAULT_QUERY', 'lofi para programar');
    this.musicVolume = Math.min(100, int('MUSIC_VOLUME', 15, 0));
    this.musicDailySearches = int('MUSIC_DAILY_SEARCHES', 80, 1);
    this.musicMaxMinutes = int('MUSIC_MAX_MINUTES', 90, 1);
    this.suspendMaxMinutes = int('SUSPEND_MAX_MINUTES', 120, 1);
    this.micGateRms = process.env.MIC_GATE === '0' ? 0 : Math.min(0.2, Math.max(0.002, Number(process.env.MIC_GATE_RMS) || 0.012));
    this.tallerAutoFix = process.env.TALLER_AUTO_FIX !== '0';
    this.tallerSessionJobs = int('TALLER_SESSION_JOBS', 4, 1);
    this.pexelsApiKey = (process.env.PEXELS_API_KEY ?? '').trim();
    this.imagesPerSession = int('IMAGES_PER_SESSION', 4, 0);
    this.imagesDailySearches = int('IMAGES_DAILY_SEARCHES', 150, 1);
    this.databaseUrl = (process.env.DATABASE_URL ?? '').trim();
    if (this.databaseUrl && !/^postgres(ql)?:\/\//.test(this.databaseUrl)) throw new Error('DATABASE_URL debe empezar por postgres://');
    this.saveConversations = process.env.SAVE_CONVERSATIONS === '1';
    this.usagePrices = {};
    try { for (const [k, v] of Object.entries(JSON.parse(process.env.USAGE_PRICES || '{}'))) if (Number(v) > 0) this.usagePrices[k] = Number(v); }
    catch { throw new Error('USAGE_PRICES debe ser un JSON como {"deepgram_s":0.0001}'); }
    // Palabra para despertar y las formas en que el reconocedor suele escribirla. La primera es la que se muestra.
    this.wakeWords = (process.env.WAKE_WORDS || 'javi,javier,xavi,havi,habi,jabi,jabe,javy,jaby,yavi,yabi').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(',').map((w) => w.trim()).filter(Boolean);
    this.publicUrl = str('PUBLIC_URL').replace(/\/+$/, '');
    this.callMode = str('CALL_MODE', 'rechazar').toLowerCase();
    // Una llamada de WhatsApp no tiene navegador: sin voz del servidor no se puede atender.
    if (this.ttsProvider === 'browser' && this.callMode === 'conversar') this.callMode = 'rechazar';
    this.callPublicIp = str('CALL_PUBLIC_IP');
    this.callPortMin = int('CALL_UDP_PORT_MIN', 40000, 1024);
    this.callPortMax = int('CALL_UDP_PORT_MAX', 40009, 1024);
    this.callMax = int('CALL_MAX', 2, 1);
    this.callTestSeconds = int('CALL_TEST_SECONDS', 20, 5);
    this.nvidiaApiKey = str('NVIDIA_API_KEY');
    this.embedModel = str('EMBED_MODEL', 'nvidia/nemotron-3.5-embed-8b');
    this.qdrantUrl = str('QDRANT_URL').replace(/\/+$/, '');
    this.qdrantApiKey = str('QDRANT_API_KEY') || str('QDRANT__SERVICE__API_KEY');
    this.qdrantCollection = str('QDRANT_COLLECTION', 'minijavi');
    this.knowledgeDir = str('KNOWLEDGE_DIR', 'conocimiento');
    this.knowledgeTopK = int('KNOWLEDGE_TOP_K', 3, 1);
    this.knowledgeMinScore = Number(str('KNOWLEDGE_MIN_SCORE', '0.25'));
    this.contactUrl = str('CONTACT_URL');
    this.contactTitle = str('CONTACT_TITLE', 'Hablemos por WhatsApp');
    this.contactCaption = str('CONTACT_CAPTION', 'Escanea para escribirle a Javier');
    this.cardsFile = str('CARDS_FILE', 'content/tarjetas.json');
    this.cardsEnabled = ['true', '1', 'si', 'sí'].includes(str('CARDS_ENABLED', 'false').toLowerCase());
    this.visitorMemoryDays = int('VISITOR_MEMORY_DAYS', 90, 0);
    const ownerFile = str('OWNER_PROMPT_FILE', 'prompts/owner.md');
    this.ownerPrompt = existsSync(ownerFile) ? readFileSync(ownerFile, 'utf8').trim() : '';
    const file = str('SYSTEM_PROMPT_FILE', 'prompts/system.md');
    this.systemPrompt = str('SYSTEM_PROMPT') || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
    if (!this.systemPrompt) throw new Error('No hay system prompt: define SYSTEM_PROMPT o SYSTEM_PROMPT_FILE');
  }
}
