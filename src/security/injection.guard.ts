import { Injectable, Logger } from '@nestjs/common';
import { DecisionsService } from '../decisions/decisions.service';
import { QUESTIONS } from '../decisions/questions';
import { AlertsService } from '../ops/alerts.service';

/** Herramientas publicas que cambian algo (guardan datos, cambian el modo de la conversacion o gastan cupo). */
export const EFFECT_TOOLS = new Set(['registrar_interesado', 'demo', 'buscar_imagenes']);

/** La revision de un turno. `blocks()` dice si las herramientas con efectos deben quedarse sin correr en ese turno. */
export interface Screen { blocks(tool: string): Promise<boolean> }

/**
 * Señal de inyeccion (etapa 1b). Es una señal ADICIONAL, no la defensa: la defensa es que el texto de afuera nunca se
 * obedece (reglas del prompt, `asData`, herramientas privadas solo en modo dueño). Lo que hace: si lo que dijo una
 * persona en una conversacion publica parece traer ordenes para una IA, en ese turno no corren las herramientas con
 * efectos y Javier recibe una alerta. La conversacion sigue.
 *  - Con Jev se evalua cada turno, en paralelo con la respuesta del modelo (no agrega espera: una herramienta nunca llega
 *    antes que la decision). Sin Jev se evalua solo cuando el turno esta por ejecutar una herramienta con efectos.
 *  - Si nadie responde a tiempo, la herramienta corre (valor por defecto de la pregunta) y queda anotado en el registro.
 */
@Injectable()
export class InjectionGuard {
  private readonly log = new Logger(InjectionGuard.name);
  private lastAlert = 0; private muted = 0;
  constructor(private readonly decisions: DecisionsService, private readonly alerts: AlertsService) {}

  screen(text: string, subject: string): Screen {
    const said = text.trim().slice(0, 4000);
    let verdict: Promise<boolean> | undefined;
    const run = () => (verdict ??= said.length < 8 ? Promise.resolve(false) : this.decisions.decide('inyeccion', said, QUESTIONS.inyeccion, { subject }).then(async (d) => {
      const hit = d.answers.ordenes.value === true;
      if (hit) try { this.alert(said, subject); } catch { /* el aviso no puede cambiar el veredicto */ }
      return hit;
    }).catch(() => false));
    if (this.decisions.graded) void run();
    return {
      blocks: async (tool) => {
        if (!EFFECT_TOOLS.has(tool)) return false;
        const hit = await run();
        if (hit) this.log.warn(`${subject}: ${tool} no corrió (posible texto con instrucciones para la IA)`);
        return hit;
      },
    };
  }

  /** Como mucho una alerta cada 10 minutos; las que se callan se cuentan en la siguiente. */
  private alert(text: string, subject: string) {
    const now = Date.now();
    if (now - this.lastAlert < 600_000) { this.muted++; return; }
    const more = this.muted ? ` (y ${this.muted} más desde el último aviso)` : '';
    this.lastAlert = now; this.muted = 0;
    void this.alerts.send(`⚠️ Posible intento de darme órdenes en ${subject}${more}. En ese turno no ejecuté acciones.\nLo que dijo: «${text.replace(/\s+/g, ' ').slice(0, 240)}»`);
  }
}
/** Lo que se le dice al modelo cuando una herramienta no corrio por la señal. */
export const BLOCKED_NOTE = 'NO se ejecutó. Por seguridad, en esta respuesta no se ejecutan acciones. Sigue conversando con normalidad sobre lo que la persona necesita; si quiere dejar sus datos o ver algo, pídele que te lo diga de nuevo.';
