import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createSocket, Socket as UdpSocket } from 'node:dgram';
import { createServer, Server } from 'node:net';
import { ConfigService } from '../config/config.service';
import { LogsService } from './logs.service';

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;
const PER_MINUTE = 20_000;

/**
 * Receptor de syslog (UDP y TCP en LOGS_SYSLOG_PORT; 0 = apagado). Es el idioma comun de routers, cortafuegos, switches,
 * puntos de acceso, rsyslog, syslog-ng, Suricata y los reenviadores de un SIEM. Cada equipo queda en su propio archivo:
 * recibidos/syslog-<direccion>.log.
 * Syslog no trae clave: solo se aceptan los remitentes de LOGS_SYSLOG_ALLOW (direcciones o prefijos como "192.168.1.");
 * sin esa lista, solo redes privadas. Hay un tope de lineas por minuto por remitente. En TCP, una linea por evento.
 */
@Injectable()
export class SyslogService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(SyslogService.name);
  private readonly pending = new Map<string, string[]>();
  private readonly rate = new Map<string, { at: number; n: number }>();
  private readonly denied = new Set<string>();
  private udp?: UdpSocket; private tcp?: Server; private timer?: NodeJS.Timeout;
  constructor(private readonly cfg: ConfigService, private readonly logs: LogsService) {}

  /** ¿Se acepta lo que envia esta direccion? */
  allowed(addr: string): boolean {
    const a = addr.replace(/^::ffff:/, ''), list = this.cfg.syslogAllow;
    return list.length ? list.some((x) => a === x || (/[.:]$/.test(x) && a.startsWith(x))) : PRIVATE.test(a);
  }
  /** Recibe un mensaje (una o varias lineas) de un remitente. Devuelve cuantas lineas acepto. */
  receive(addr: string, text: string): number {
    const a = addr.replace(/^::ffff:/, '');
    if (!this.allowed(a)) { if (!this.denied.has(a) && this.denied.size < 200) { this.denied.add(a); this.log.warn(`syslog de ${a} descartado: no está en LOGS_SYSLOG_ALLOW`); } return 0; }
    const now = Date.now(), r = this.rate.get(a); let n = 0;
    const win = r && now - r.at < 60_000 ? r : { at: now, n: 0 }; this.rate.set(a, win);
    const list = this.pending.get(a) ?? []; this.pending.set(a, list);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^<\d{1,3}>(?:1 )?/, '').trim(); // sin la prioridad ni la version de RFC 5424
      if (!line || win.n >= PER_MINUTE) continue;
      win.n++; n++; list.push(line);
    }
    return n;
  }
  /** Escribe lo acumulado (cada segundo). */
  async flush() {
    const batch = [...this.pending.entries()]; this.pending.clear();
    for (const [a, lines] of batch) if (lines.length) await this.logs.append(`syslog-${a.replace(/[^0-9a-f.]/gi, '-')}`, lines).catch((e) => this.log.warn(`no se pudo guardar syslog de ${a}: ${(e as Error).message}`));
  }

  onApplicationBootstrap() {
    const port = this.cfg.syslogPort; if (!port) return;
    this.udp = createSocket('udp4');
    this.udp.on('message', (msg, from) => this.receive(from.address, msg.toString('utf8', 0, Math.min(msg.length, 16_384))));
    this.udp.on('error', (e) => this.log.warn(`syslog UDP: ${e.message}`));
    this.udp.bind(port, '0.0.0.0');
    this.tcp = createServer((sock) => {
      const from = sock.remoteAddress ?? ''; let buf = '';
      if (!this.allowed(from)) { this.receive(from, ''); sock.destroy(); return; }
      sock.setEncoding('utf8'); sock.setTimeout(300_000, () => sock.destroy());
      sock.on('data', (d: string) => { buf += d; const cut = buf.lastIndexOf('\n'); if (cut >= 0) { this.receive(from, buf.slice(0, cut)); buf = buf.slice(cut + 1); } if (buf.length > 65_536) buf = ''; });
      sock.on('close', () => { if (buf) this.receive(from, buf); });
      sock.on('error', () => undefined);
    });
    this.tcp.maxConnections = 50;
    this.tcp.on('error', (e) => this.log.warn(`syslog TCP: ${e.message}`));
    this.tcp.listen(port, '0.0.0.0');
    this.timer = setInterval(() => void this.flush(), 1000); this.timer.unref();
    this.log.log(`recibiendo syslog en el puerto ${port} (UDP y TCP); remitentes: ${this.cfg.syslogAllow.join(', ') || 'solo redes privadas'}`);
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.udp?.close(); this.tcp?.close(); await this.flush(); }
}
