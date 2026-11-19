import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DecisionsService } from '../decisions/decisions.service';
import { QUESTIONS } from '../decisions/questions';
import { CapableModelService } from '../llm/capable.service';
import { AlertsService } from '../ops/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { SecurityAlertsService } from './security-alerts.service';

/** Herramientas publicas que cambian algo (guardan datos o abren una alerta). */
export const EFFECT_TOOLS = new Set(['registrar_interesado', 'reportar_alerta']);
/** Herramientas que no se quitan nunca aunque la ruta diga "charla": son las que consiguen clientes. */
export const ALWAYS_TOOLS = new Set(['registrar_interesado', 'portafolio']);
/** Herramientas que delatan un encargo largo (para medir si la ruta acerto). Hoy ninguna: un analisis largo no usa una herramienta propia. */
const JOB_TOOLS = new Set<string>();
export type Route = 'charla' | 'sencilla' | 'herramienta' | 'encargo';

/** La revision de un turno: la señal de inyeccion y, con Jev, la ruta. */
export interface Screen {
  /** ¿La herramienta debe quedarse sin correr en este turno? (señal de inyeccion; solo herramientas con efectos) */
  blocks(tool: string): Promise<boolean>;
  /** La ruta, SOLO si ya llego y esta activa; undefined = usar todo como siempre. Nunca espera. */
  route(): Route | undefined;
  /** Al terminar el turno: que herramientas uso de verdad el modelo, para medir los aciertos de la ruta. */
  done(toolsUsed: string[]): void;
}

/**
 * Revision de cada turno (etapas 1b y 1c).
 * Señal de inyeccion: es una señal ADICIONAL, no la defensa (la defensa es que el texto de afuera nunca se obedece). Si
 * lo que dijo una persona en una conversacion publica parece traer ordenes para una IA, en ese turno no corren las
 * herramientas con efectos y Javier recibe una alerta. La conversacion sigue.
 * Ruta (solo con Jev): clasifica el turno en la MISMA peticion que la señal. Arranca en sombra: se registra y se compara
 * con las herramientas que el modelo uso de verdad. Solo si Javier la activa en el panel sirve para enviar menos
 * herramientas al modelo o, en encargos largos del dueño, usar el modelo mas capaz.
 *  - Con Jev todo se evalua con el turno, en paralelo con la respuesta (no agrega espera). Sin Jev no hay ruta y la señal
 *    se evalua solo cuando el turno esta por ejecutar una herramienta con efectos.
 *  - Nada de esto se espera en serie: si la ruta no ha llegado cuando se arma la peticion al modelo, se usa todo.
 */
@Injectable()
export class InjectionGuard {
  private readonly log = new Logger(InjectionGuard.name);
  private lastAlert = 0; private muted = 0;
  constructor(private readonly decisions: DecisionsService, private readonly alerts: AlertsService, private readonly settings: SettingsService, private readonly cfg: ConfigService, private readonly capable: CapableModelService, private readonly security?: SecurityAlertsService) {
    settings.define('ruta.grupos', { type: 'boolean', def: false, label: 'Enviar al modelo solo las herramientas de la ruta', group: 'ruta' });
    settings.define('ruta.modelo_capaz', { type: 'boolean', def: false, label: 'Usar el modelo capaz en encargos largos del dueño', group: 'ruta' });
  }

  /** `who`: 'publico' revisa inyeccion (y ruta con Jev); 'dueno' solo ruta; 'chat' solo inyeccion (el chat escrito no enruta). */
  screen(text: string, subject: string, who: 'publico' | 'dueno' | 'chat' = 'chat'): Screen {
    const said = text.trim().slice(0, 4000), graded = this.decisions.graded;
    const wantRoute = graded && who !== 'chat', wantInjection = who !== 'dueno';
    const routeQ = who === 'dueno' ? { turno_dueno: QUESTIONS.ruta.turno_dueno } : { turno: QUESTIONS.ruta.turno };
    let route: Route | undefined, routeId: Promise<number | null> | undefined, verdict: Promise<boolean> | undefined;

    const run = () => (verdict ??= said.length < 8 ? Promise.resolve(false) : (async () => {
      const sets = { ...(wantInjection ? { inyeccion: QUESTIONS.inyeccion } : {}), ...(wantRoute ? { ruta: routeQ } : {}) } as Record<string, any>;
      const d: any = await this.decisions.decideMany(said, sets, { subject });
      if (d.ruta) {
        routeId = d.ruta.id;
        const a = d.ruta.answers.turno ?? d.ruta.answers.turno_dueno;
        if (!d.ruta.shadow && a.by !== 'defecto') route = a.value as Route; // en sombra o sin respuesta: no hay ruta, se usa todo
      }
      const hit = d.inyeccion?.answers.ordenes.value === true;
      if (hit) try { this.alert(said, subject); } catch { /* el aviso no puede cambiar el veredicto */ }
      return hit;
    })().catch(() => false));
    if (graded) void run(); // con Jev: en paralelo desde el inicio del turno. Sin Jev: solo si hace falta (blocks).

    return {
      blocks: async (tool) => {
        if (!wantInjection || !EFFECT_TOOLS.has(tool)) return false;
        const hit = await run();
        if (hit) this.log.warn(`${subject}: ${tool} no corrió (posible texto con instrucciones para la IA)`);
        return hit;
      },
      route: () => route,
      done: (toolsUsed) => {
        if (!routeId) return;
        const real: Route = toolsUsed.some((t) => JOB_TOOLS.has(t)) ? 'encargo' : toolsUsed.length ? 'herramienta' : 'charla';
        void this.decisions.outcome(routeId, `${real}${toolsUsed.length ? ': ' + [...new Set(toolsUsed)].join(', ') : ''}`);
      },
    };
  }

  /** Las herramientas que se le envian al modelo segun la ruta. Sin ruta, o con el ajuste apagado, van todas. */
  tools<T extends { function?: { name?: string } }>(all: T[], route: Route | undefined): T[] {
    if (!route || route === 'herramienta' || route === 'encargo' || !this.settings.boolean('ruta.grupos')) return all;
    return all.filter((t) => ALWAYS_TOOLS.has(String(t.function?.name)));
  }
  /** ¿Este turno va con el modelo capaz? Solo un encargo largo del DUEÑO, si hay modelo configurado y Javier lo encendio en el panel. */
  useCapable(route: Route | undefined, owner: boolean): boolean {
    return owner && route === 'encargo' && this.capable.enabled && this.settings.boolean('ruta.modelo_capaz');
  }

  /**
   * El intento abre una alerta de seguridad: el avatar se pone rojo y llega el aviso por Telegram (si se repite mientras
   * sigue abierta, suma una repeticion sin volver a avisar). Sin servicio de alertas: aviso directo, como mucho uno cada 10 minutos.
   */
  private alert(text: string, subject: string) {
    if (this.security) { void this.security.open({ source: 'manipulacion', title: 'Posible intento de darle órdenes ocultas a la IA', origin: subject, severity: 'media', detail: `Lo que dijo: «${text.replace(/\s+/g, ' ').slice(0, 400)}»` }).catch(() => undefined); return; }
    const now = Date.now();
    if (now - this.lastAlert < 600_000) { this.muted++; return; }
    const more = this.muted ? ` (y ${this.muted} más desde el último aviso)` : '';
    this.lastAlert = now; this.muted = 0;
    void this.alerts.send(`⚠️ Posible intento de darme órdenes en ${subject}${more}. En ese turno no ejecuté acciones.\nLo que dijo: «${text.replace(/\s+/g, ' ').slice(0, 240)}»`);
  }
}
/** Lo que se le dice al modelo cuando una herramienta no corrio por la señal. */
export const BLOCKED_NOTE = 'NO se ejecutó. Por seguridad, en esta respuesta no se ejecutan acciones. Sigue conversando con normalidad sobre lo que la persona necesita; si quiere dejar sus datos o ver algo, pídele que te lo diga de nuevo.';
