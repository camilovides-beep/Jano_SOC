import { EventEmitter } from 'node:events';

/** Marca de los sockets internos (llamadas): el gateway confia en los datos de su saludo; nunca la tiene un navegador. */
export const INTERNAL = Symbol('internal-socket');

/**
 * Socket virtual que imita un WebSocket del navegador, para que una llamada de WhatsApp use la misma conversacion
 * (escucha, modelo, voz, herramientas, captacion) que la pagina web.
 */
export class CallSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly [INTERNAL] = true;
  constructor(private readonly onServer: (msg: any) => void, private readonly onClosed: () => void) { super(); }

  /** El gateway envia JSON al "navegador". */
  send(data: string) {
    try { this.onServer(JSON.parse(data)); } catch { /* no es JSON */ }
  }
  /** El gateway cierra la sesion (limites, errores). */
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3; this.emit('close'); this.onClosed();
  }
  /** La llamada termino del lado de WhatsApp. */
  hangup() { if (this.readyState === 1) { this.readyState = 3; this.emit('close'); } }
  json(obj: unknown) { if (this.readyState === 1) this.emit('message', Buffer.from(JSON.stringify(obj)), false); }
  audio(pcm16k: Buffer) { if (this.readyState === 1) this.emit('message', pcm16k, true); }
}
