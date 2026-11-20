import { Body, Controller, Header, HttpCode, HttpException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { LogsService } from './logs.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const HOUR = 3600_000, MAX_LINES = 5000;

/**
 * Entrada de logs por HTTP: POST /logs/<fuente>, con la cabecera `X-Logs-Secret` igual a LOGS_INGEST_SECRET (sin esa
 * variable la entrada no existe). Sirve para cualquier cosa que sepa enviar por HTTP: un SIEM (Wazuh, Graylog, Splunk,
 * Elastic), Fluent Bit, Vector, Logstash, rsyslog (omhttp), n8n o un script con curl. Cuerpos aceptados:
 *  - texto (text/plain o application/x-ndjson): una linea por evento;
 *  - JSON: un arreglo de lineas u objetos, { "lineas": [...] } (tambien lines, events, records, logs), o un solo objeto.
 * Cada evento queda como una linea en recibidos/<fuente>.log. Lo que llega es texto de terceros: se guarda como dato.
 */
@Controller('logs')
export class IngestController {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly cfg: ConfigService, private readonly logs: LogsService) {}

  @Post(':fuente')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async ingest(@Req() req: Request, @Param('fuente') fuente: string, @Body() body: unknown) {
    const secret = this.cfg.logsIngestSecret;
    if (!secret) throw new HttpException({ ok: false, error: 'desactivado' }, 404);
    const given = Buffer.from(String(req.headers['x-logs-secret'] ?? '')), want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpException({ ok: false, error: 'clave' }, 401);
    const now = Date.now(), ip = ipOf(req), list = (this.hits.get(ip) ?? []).filter((t) => now - t < HOUR);
    if (list.length >= 6000) throw new HttpException({ ok: false, error: 'limite' }, 429);
    list.push(now); this.hits.set(ip, list);
    const b = body as any, bag = Array.isArray(b) ? b : b && typeof b === 'object' ? (['lineas', 'lines', 'events', 'records', 'logs'].map((k) => b[k]).find(Array.isArray) ?? [b]) : String(b ?? '').split(/\r?\n/);
    const lines = (bag as unknown[]).slice(0, MAX_LINES).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const saved = await this.logs.append(fuente, lines);
    if (!saved) throw new HttpException({ ok: false, error: 'sin líneas o nombre de fuente inválido' }, 400);
    return { ok: true, lineas: saved };
  }
}
