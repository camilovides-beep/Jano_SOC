import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string> | string;
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
  constructor(cfg: ConfigService) {
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
              '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
              '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto',
          );
          const c = w.current, d = w.daily;
          const lugar = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
          return (
            `Clima en ${lugar}: ${WMO[c.weather_code] ?? 'condición desconocida'}, ${Math.round(c.temperature_2m)} grados ` +
            `(sensación de ${Math.round(c.apparent_temperature)}), humedad ${c.relative_humidity_2m} por ciento, viento ${Math.round(c.wind_speed_10m)} km/h. ` +
            `Hoy: máxima ${Math.round(d.temperature_2m_max[0])}, mínima ${Math.round(d.temperature_2m_min[0])}, ` +
            `probabilidad de lluvia ${d.precipitation_probability_max[0]} por ciento.`
          );
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
            return `TRM oficial de Colombia vigente el ${hoy}: ${Number(r.valor).toFixed(2)} pesos por dólar.`;
          }
          const fx = await getJson('https://open.er-api.com/v6/latest/USD');
          const rate = fx.rates?.[moneda];
          if (!rate) return `No tengo la tasa de cambio para la moneda ${moneda}.`;
          return `Un dólar equivale a ${Number(rate).toFixed(rate > 100 ? 0 : 2)} ${moneda} (tasa de referencia de mercado, no oficial).`;
        },
      },
    };
  }
  /** Definiciones en el formato de la API (compatible con OpenAI). */
  definitions() {
    return Object.entries(this.tools).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
  }
  async run(name: string, rawArgs: string): Promise<string> {
    const tool = this.tools[name];
    if (!tool) return `Error: la herramienta ${name} no existe.`;
    let args: Record<string, unknown> = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return 'Error: argumentos invalidos.'; }
    try { return String(await tool.run(args)); } catch (e) { return `Error al consultar: ${(e as Error).message}. Dile a la persona que no pudiste consultarlo ahora.`; }
  }
}
