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
    this.elevenApiKey = required('ELEVENLABS_API_KEY');
    this.elevenVoiceId = required('ELEVENLABS_VOICE_ID');
    this.elevenModelId = str('ELEVENLABS_MODEL_ID', 'eleven_v4_turbo');
    this.deepgramApiKey = required('DEEPGRAM_API_KEY');
    this.deepgramModel = str('DEEPGRAM_MODEL', 'nova-3');
    this.deepgramLanguage = str('DEEPGRAM_LANGUAGE', 'es');
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
    const ownerFile = str('OWNER_PROMPT_FILE', 'prompts/owner.md');
    this.ownerPrompt = existsSync(ownerFile) ? readFileSync(ownerFile, 'utf8').trim() : '';
    const file = str('SYSTEM_PROMPT_FILE', 'prompts/system.md');
    this.systemPrompt = str('SYSTEM_PROMPT') || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
    if (!this.systemPrompt) throw new Error('No hay system prompt: define SYSTEM_PROMPT o SYSTEM_PROMPT_FILE');
  }
}
