import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { contactKey } from '../security/optout.service';
import { SettingsService } from '../settings/settings.service';

export const DAYS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const;
const DAY_NAMES: Record<string, string> = { lun: 'Lunes', mar: 'Martes', mie: 'Miércoles', jue: 'Jueves', vie: 'Viernes', sab: 'Sábado', dom: 'Domingo' };
const HOURS = /^$|^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/;
const PHONES = /^$|^\+?\d[\d ]{6,18}(\s*,\s*\+?\d[\d ]{6,18}){0,19}$/;

/**
 * La politica de autonomia (etapa 2a, pedida por Javier el 2026-11-18): los limites dentro de los cuales minijavi puede
 * actuar por su cuenta. Los pone Javier en el panel; aqui solo se leen. Quien los IMPONE es ActionsService, en codigo.
 * Valores de fabrica aprobados por Javier: lunes a viernes de 8 a 18, sabados de 9 a 13, 2 mensajes y 1 llamada por
 * contacto al dia, 3 intentos por interesado y 20 mensajes al dia. Arranca en simulacion y sin produccion.
 */
@Injectable()
export class PolicyService {
  constructor(private readonly cfg: ConfigService, private readonly settings: SettingsService) {
    const g = 'politica', n = (key: string, label: string, def: number, max: number, hint?: string) => settings.define(`politica.${key}`, { type: 'number', def, min: 0, max, label, group: g, hint });
    settings.define('politica.pausa', { type: 'boolean', def: false, label: 'Pausar toda acción autónoma', group: g, hint: 'Interruptor general: con esto encendido el avatar no hace nada por su cuenta.' });
    settings.define('politica.simulacion', { type: 'boolean', def: true, label: 'Modo simulación', group: g, hint: 'Nada sale de verdad: la bitácora anota lo que habría hecho.' });
    settings.define('politica.produccion', { type: 'boolean', def: false, label: 'Producción activada', group: g, hint: 'Apagado: solo se puede contactar a los números de prueba.' });
    settings.define('politica.numeros_prueba', { type: 'text', def: '', pattern: PHONES, max: 400, example: '+573001234567, +573009876543', label: 'Números de prueba', group: g, hint: 'Hasta 20, separados por comas, con indicativo.' });
    for (const d of ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'])
      settings.define(`politica.horario.${d}`, { type: 'text', def: d === 'dom' ? '' : d === 'sab' ? '09:00-13:00' : '08:00-18:00', pattern: HOURS, max: 11, example: '08:00-18:00', label: DAY_NAMES[d], group: 'horario', hint: 'Vacío = ese día no se contacta a nadie.' });
    n('max_mensajes_contacto_dia', 'Mensajes por contacto al día', 2, 20);
    n('max_llamadas_contacto_dia', 'Llamadas por contacto al día', 1, 10);
    n('max_mensajes_dia', 'Mensajes autónomos al día, en total', 20, 2000);
    n('max_llamadas_dia', 'Llamadas autónomas al día, en total', 10, 500);
    n('max_intentos_interesado', 'Intentos por interesado (en total)', 3, 50, 'Contactos por iniciativa propia a una misma persona, sumando mensajes y llamadas.');
    n('gasto_dia_usd', 'Gasto máximo diario de las acciones autónomas (USD)', 2, 10_000, '0 = sin tope de gasto diario.');
    n('gasto_mes_usd', 'Gasto máximo mensual de las acciones autónomas (USD)', 30, 100_000, '0 = sin tope de gasto mensual.');
    n('costo_plantilla_usd', 'Costo de una plantilla de WhatsApp (USD)', 0, 10, 'Lo que te cobra Meta por cada plantilla. Con 0 las plantillas no suman al gasto.');
  }

  get paused() { return this.settings.boolean('politica.pausa'); }
  get simulation() { return this.settings.boolean('politica.simulacion'); }
  get production() { return this.settings.boolean('politica.produccion'); }
  limit(key: string) { return this.settings.number(`politica.${key}`); }
  testNumbers(): string[] { return this.settings.text('politica.numeros_prueba').split(',').map((p) => contactKey(p, this.cfg.whatsappDefaultCountry)).filter(Boolean); }
  isTestNumber(contact: string) { const k = contactKey(contact, this.cfg.whatsappDefaultCountry); return !!k && this.testNumbers().includes(k); }

  /** Fecha y hora en la zona del negocio: dia de la semana, minutos desde medianoche, y las claves del dia y del mes. */
  clock(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((x) => [x.type, x.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return { day: DAYS[dow], minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), dayKey: `${p.year}-${p.month}-${p.day}`, monthKey: `${p.year}-${p.month}` };
  }
  /** '' si a esta hora se puede contactar; si no, el motivo. */
  outsideHours(now = new Date()): string {
    const c = this.clock(now), range = this.settings.text(`politica.horario.${c.day}`);
    if (!range) return `los ${DAY_NAMES[c.day].toLowerCase()} no se contacta a nadie`;
    const [a, b] = range.split('-').map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
    return c.minutes >= a && c.minutes < b ? '' : `fuera del horario permitido (${DAY_NAMES[c.day].toLowerCase()} ${range})`;
  }
  /** Inicio del dia y del mes en curso (en la zona del negocio), como instantes ISO, para contar lo ya hecho. */
  since(now = new Date()) {
    const c = this.clock(now), startOfDay = new Date(now.getTime() - c.minutes * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds());
    const dayOfMonth = Number(c.dayKey.slice(8));
    return { day: startOfDay.toISOString(), month: new Date(startOfDay.getTime() - (dayOfMonth - 1) * 86_400_000).toISOString() };
  }
}
