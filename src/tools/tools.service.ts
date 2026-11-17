import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { INTERESTS, LeadsService } from '../leads/leads.service';
import { PLANE_PREFIX, PlaneMcpService } from '../mcp/plane-mcp.service';
import { MODELS, WorkshopService } from '../workshop/workshop.service';

/** Resultado de una herramienta: el texto para el modelo y, si aplica, un efecto visual para el navegador. */
export interface ToolResult { text: string; scene?: string; reaction?: string; card?: { title: string; lines: string[]; qr?: string; caption?: string }; }
/** Datos de la sesion que algunas herramientas necesitan (la direccion publica, para enlaces y QR). */
export interface ToolContext { origin: string; }
interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolResult> | string | ToolResult;
}

/** Fondo segun el codigo de tiempo (OMM) y si es de dia. */
function weatherScene(code: number, isDay: boolean): string {
  if (code >= 95) return 'tormenta';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'lluvia';
  if (code === 3 || code === 45 || code === 48 || (code >= 71 && code <= 86)) return 'nublado';
  return isDay ? 'soleado' : 'estrellas'; // despejado o pocas nubes
}

/** Codigos de tiempo de la OMM que devuelve Open-Meteo. */
const WMO: Record<number, string> = {
  0: 'cielo despejado', 1: 'mayormente despejado', 2: 'parcialmente nublado', 3: 'nublado', 45: 'niebla', 48: 'niebla',
  51: 'llovizna ligera', 53: 'llovizna', 55: 'llovizna fuerte', 61: 'lluvia ligera', 63: 'lluvia', 65: 'lluvia fuerte',
  66: 'lluvia helada', 67: 'lluvia helada', 71: 'nieve ligera', 73: 'nieve', 75: 'nieve fuerte', 77: 'granizo fino',
  80: 'chubascos ligeros', 81: 'chubascos', 82: 'chubascos fuertes', 85: 'nevadas', 86: 'nevadas fuertes',
  95: 'tormenta eléctrica', 96: 'tormenta con granizo', 99: 'tormenta fuerte con granizo',
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`el servicio respondió ${res.status}`);
  return res.json();
}

/**
 * Registro de herramientas (function calling). Para agregar una: sumarla a `tools` con su esquema y su ejecutor.
 * APIs publicas sin clave, probadas el 2026-11-13: Open-Meteo (clima), datos.gov.co (TRM oficial) y open.er-api.com (otras monedas).
 */
@Injectable()
export class ToolsService {
  private readonly tools: Record<string, Tool>;
  /** Herramientas locales que solo existen en sesiones del dueño. */
  private readonly ownerTools: Record<string, Tool>;
  constructor(cfg: ConfigService, private readonly plane: PlaneMcpService, private readonly leads: LeadsService, private readonly workshop: WorkshopService) {
    this.tools = {
      hora_actual: {
        description: 'Devuelve la fecha y la hora actuales. Usala cuando pregunten que hora es o que dia es hoy.',
        parameters: { type: 'object', properties: {}, required: [] },
        run: () =>
          new Intl.DateTimeFormat('es-CO', { timeZone: cfg.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date()),
      },
      clima: {
        description: 'Devuelve el clima actual y el pronostico de hoy de una ciudad. Usala cuando pregunten por el clima, la temperatura o si va a llover.',
        parameters: {
          type: 'object',
          properties: { ciudad: { type: 'string', description: `Nombre de la ciudad. Si la persona no dice ninguna, usa ${cfg.defaultCity}.` } },
          required: [],
        },
        run: async (args) => {
          const ciudad = String(args.ciudad || cfg.defaultCity).trim();
          const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(ciudad)}&count=1&language=es&format=json`);
          const place = geo.results?.[0];
          if (!place) return `No encontré la ciudad "${ciudad}".`;
          const w = await getJson(
            `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
              '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
              '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto',
          );
          const c = w.current, d = w.daily;
          const lugar = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
          const text =
            `Clima en ${lugar}: ${WMO[c.weather_code] ?? 'condición desconocida'}, ${Math.round(c.temperature_2m)} grados ` +
            `(sensación de ${Math.round(c.apparent_temperature)}), humedad ${c.relative_humidity_2m} por ciento, viento ${Math.round(c.wind_speed_10m)} km/h. ` +
            `Hoy: máxima ${Math.round(d.temperature_2m_max[0])}, mínima ${Math.round(d.temperature_2m_min[0])}, ` +
            `probabilidad de lluvia ${d.precipitation_probability_max[0]} por ciento.`;
          return { text, scene: weatherScene(Number(c.weather_code), c.is_day !== 0) }; // el fondo lo decide el dato, no el modelo
        },
      },
      precio_dolar: {
        description: 'Devuelve el precio del dolar. Por defecto en pesos colombianos (TRM oficial de hoy); tambien convierte el dolar a otra moneda. Usala cuando pregunten por el dolar, la TRM o una tasa de cambio.',
        parameters: {
          type: 'object',
          properties: { moneda: { type: 'string', description: 'Codigo ISO de la moneda destino, por ejemplo COP, EUR o MXN. Por defecto COP.' } },
          required: [],
        },
        run: async (args) => {
          const moneda = String(args.moneda || 'COP').trim().toUpperCase();
          if (moneda === 'COP') {
            // TRM oficial (Superintendencia Financiera, datos.gov.co): la vigente hoy en Colombia.
            const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
            const where = encodeURIComponent(`vigenciadesde <= '${hoy}T00:00:00' AND vigenciahasta >= '${hoy}T00:00:00'`);
            let rows = await getJson(`https://www.datos.gov.co/resource/32sa-8pi3.json?$where=${where}&$limit=1`);
            if (!rows.length) rows = await getJson('https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1');
            const r = rows[0];
            if (!r) return 'No pude consultar la TRM en este momento.';
            return { text: `TRM oficial de Colombia vigente el ${hoy}: ${Number(r.valor).toFixed(2)} pesos por dólar.`, reaction: 'dinero' };
          }
          const fx = await getJson('https://open.er-api.com/v6/latest/USD');
          const rate = fx.rates?.[moneda];
          if (!rate) return `No tengo la tasa de cambio para la moneda ${moneda}.`;
          return { text: `Un dólar equivale a ${Number(rate).toFixed(rate > 100 ? 0 : 2)} ${moneda} (tasa de referencia de mercado, no oficial).`, reaction: 'dinero' };
        },
      },
      registrar_interesado: {
        description:
          'Guarda los datos de una persona interesada en los servicios de Javier para que él la contacte. Úsala SOLO después de ' +
          'tener su nombre, un dato de contacto que ya le repetiste y confirmó, y su autorización para guardar los datos.',
        parameters: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre de la persona.' },
            contacto: { type: 'string', description: 'Teléfono, WhatsApp o correo, tal como lo confirmó. Escríbelo en formato normal (dígitos o correo), no en palabras.' },
            empresa: { type: 'string', description: 'Empresa o negocio, si lo mencionó.' },
            interes: { type: 'string', enum: [...INTERESTS], description: 'Servicio de Javier que más se parece a lo que necesita.' },
            detalle: { type: 'string', description: 'Resumen breve de lo que necesita, en una o dos frases.' },
            autoriza: { type: 'boolean', description: 'true solo si la persona dijo que sí autoriza guardar sus datos para ser contactada.' },
          },
          required: ['nombre', 'contacto', 'interes', 'autoriza'],
        },
        run: async (args) => {
          if (args.autoriza !== true) return 'No se guardó: falta la autorización de la persona. Pregúntale si autoriza guardar sus datos.';
          const nombre = String(args.nombre ?? '').trim(), contacto = String(args.contacto ?? '').trim();
          if (nombre.length < 2 || contacto.length < 5) return 'No se guardó: falta el nombre o el dato de contacto. Pídeselo.';
          const lead = this.leads.add({ name: nombre, contact: contacto, company: String(args.empresa ?? ''), interest: String(args.interes ?? 'otro'), detail: String(args.detalle ?? '') });
          const wa = await this.leads.announce(lead);
          const extra = wa === '' ? ' Además se le acaba de enviar un mensaje de Javier por WhatsApp a ese número: dile que lo revise y que puede responder por ahí.' : '';
          return `Guardado con el número ${lead.id}.${extra} Dile que Javier lo contactará pronto y agradécele.`;
        },
      },
    };
    this.ownerTools = {
      ver_interesados: {
        description: 'Lista las personas interesadas en los servicios de Javier que el avatar ha registrado, de la más reciente a la más antigua.',
        parameters: { type: 'object', properties: { cuantos: { type: 'number', description: 'Cuántos traer (por defecto 10).' } }, required: [] },
        run: (args) => {
          const rows = this.leads.list(Math.min(30, Math.max(1, Number(args.cuantos) || 10)));
          if (!rows.length) return 'Todavía no hay interesados registrados.';
          return rows.map((l) => `#${l.id} ${l.created_at.slice(0, 10)} | ${l.name}${l.company ? ' (' + l.company + ')' : ''} | ${l.contact} | ${l.interest} | ${l.status} | ${l.detail}`).join('\n');
        },
      },
    };
    // Taller de programacion: Claude Code con la suscripcion de Javier. Solo existe en modo dueño y si hay token.
    if (workshop.enabled) Object.assign(this.ownerTools, {
      programar: {
        description:
          'Le pasa un encargo de programación a Claude Code, que trabaja en segundo plano en un proyecto (carpeta propia) y puede tardar varios minutos. ' +
          'Úsala cuando Javier pida crear o cambiar algo de programación: una landing, una página, un script, una app. ' +
          'Para seguir un proyecto que ya existe usa su mismo nombre: Claude Code recuerda lo anterior.',
        parameters: {
          type: 'object',
          properties: {
            proyecto: { type: 'string', description: 'Nombre corto del proyecto, por ejemplo "landing café". Si es uno existente, el mismo nombre.' },
            encargo: { type: 'string', description: 'Qué debe hacer, con TODOS los detalles que dio Javier (producto, público, textos, colores, qué acción debe hacer el visitante). Claude Code no oye la conversación: solo lee esto.' },
            nuevo: { type: 'boolean', description: 'true si es un proyecto nuevo; false u omitido si continúa uno existente.' },
            modelo: { type: 'string', enum: MODELS.map((m) => m.key), description: `Modelo de Claude Code que eligió Javier: ${MODELS.map((m) => `${m.key} = ${m.label}`).join(', ')}. Omítelo para usar el de por defecto (${workshop.defaultModel.label}).` },
          },
          required: ['proyecto', 'encargo'],
        },
        run: (args: Record<string, unknown>, ctx: ToolContext) => {
          const existing = workshop.find(String(args.proyecto ?? ''));
          return workshop.start(String(args.proyecto ?? ''), String(args.encargo ?? ''), `${cfg.publicUrl || ctx.origin}/formulario`, args.nuevo === true || !existing && workshop.list().length === 0, args.modelo ? String(args.modelo) : undefined);
        },
      },
      estado_taller: {
        description: 'Dice en qué va el encargo de programación en curso y lista los proyectos del taller con su último resultado. Úsala cuando Javier pregunte cómo va, qué proyectos hay o qué pasó con uno.',
        parameters: { type: 'object', properties: {}, required: [] },
        run: (_args: Record<string, unknown>, ctx: ToolContext) => {
          const rows = workshop.list().slice(0, 12).map((p) => `- ${p.name} [${p.status}]${workshop.hasSite(p.slug) ? ' sitio: ' + workshop.siteUrl(p.slug, ctx.origin) : ''} | último encargo: ${(p.lastTask ?? '').slice(0, 100)} | resultado: ${(p.lastSummary ?? 'sin resultado').slice(0, 300)}`);
          return `${workshop.progress()}\nProyectos (${workshop.list().length}):\n${rows.join('\n') || 'ninguno todavía'}`;
        },
      },
      cancelar_encargo: {
        description: 'Cancela el encargo de programación que está en curso. Úsala solo si Javier pide detenerlo.',
        parameters: { type: 'object', properties: {}, required: [] },
        run: () => workshop.cancel(),
      },
      mostrar_proyecto: {
        description: 'Muestra en pantalla el código QR y el enlace del sitio publicado de un proyecto. Úsala cuando Javier pida ver, abrir o compartir un proyecto.',
        parameters: { type: 'object', properties: { proyecto: { type: 'string', description: 'Nombre del proyecto.' } }, required: ['proyecto'] },
        run: async (args: Record<string, unknown>, ctx: ToolContext) => {
          const p = workshop.find(String(args.proyecto ?? ''));
          if (!p) return `No existe un proyecto parecido. Proyectos: ${workshop.list().map((x) => x.name).join(', ') || 'ninguno'}.`;
          const card = await workshop.card(p.slug, ctx.origin);
          if (!card) return `El proyecto "${p.name}" no tiene un sitio publicado (no hay carpeta sitio con index.html). Último resultado: ${(p.lastSummary ?? 'ninguno').slice(0, 300)}`;
          return { text: `En pantalla está el código QR de "${p.name}". Enlace: ${workshop.siteUrl(p.slug, ctx.origin)}. Dile que lo escanee; no leas el enlace completo.`, card };
        },
      },
    });
  }
  /**
   * Definiciones en el formato de la API (compatible con OpenAI). Las herramientas privadas (Plane) solo se incluyen
   * en sesiones del dueño: en una sesion publica el modelo ni siquiera sabe que existen.
   */
  async definitions(owner: boolean): Promise<unknown[]> {
    const pub = Object.entries(this.tools).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
    if (!owner) return pub;
    const priv = Object.entries(this.ownerTools).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
    return [...pub, ...priv, ...(await this.plane.definitions())];
  }
  async run(name: string, rawArgs: string, owner: boolean, ctx: ToolContext = { origin: '' }): Promise<ToolResult> {
    if (name.startsWith(PLANE_PREFIX)) return { text: owner ? await this.plane.call(name, rawArgs) : 'Error: esa herramienta no existe.' }; // doble control
    const tool = this.tools[name] ?? (owner ? this.ownerTools[name] : undefined);
    if (!tool) return { text: `Error: la herramienta ${name} no existe.` };
    let args: Record<string, unknown> = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { text: 'Error: argumentos invalidos.' }; }
    try { const out = await tool.run(args, ctx); return typeof out === 'string' ? { text: out } : out; }
    catch (e) { return { text: `Error al consultar: ${(e as Error).message}. Dile a la persona que no pudiste consultarlo ahora.` }; }
  }
}
