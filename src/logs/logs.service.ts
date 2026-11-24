import { Injectable, Optional } from '@nestjs/common';
import { appendFile, mkdir, open, readdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ConfigService } from '../config/config.service';
import { Analysis, analyze, redact, safe } from './log-analysis';
import { pcapToLines } from './pcap';
import { LogDbService, LOGDB } from './log-db.service';

export interface LogSource {
  /** Nombre con "/" (los recibidos por la red empiezan por "recibidos/"; las tablas de la base de logs, por "bd/"). */ name: string;
  /** Bytes del archivo. En una tabla, el id de su ultima fila: crece igual cuando llega algo nuevo. */ size: number; mtime: Date;
  /** Carpeta raiz y ruta dentro de ella (vacias en una tabla). */ root: string; rel: string;
  /** Solo en las tablas de la base de logs. */ db?: { schema: string; table: string; rows: number };
}
const MAX_LINES = 60_000, MAX_SOURCES = 200, MAX_GZ = 8 * 1024 * 1024, MAX_PCAP = 64 * 1024 * 1024, MAX_LINE = 8000;
const LOG_NAME = /\.(log|txt|json|jsonl|out|gz|pcap|cap)$|(^|\/)(syslog|messages|secure|auth|kern)(\.\d+)?$|\.log\.\d+$/i;
/** Prefijo de los logs que llegan por la red (ingesta HTTP y syslog). */
export const INBOX = 'recibidos';

/**
 * Archivos de log que Jano puede analizar (pedido por Camilo el 2026-11-19). Hay dos carpetas:
 *  - LOGS_DIR: la que montan los proyectos. Solo se lee.
 *  - DATA_DIR/logs-recibidos: lo que llega por la red (POST /logs/<fuente> y syslog). Solo ahi se escribe.
 * Ademas, cada tabla de la base de logs (LOGS_DB_*) es una fuente "bd/<esquema>/<tabla>"; ver LogDbService.
 * El nombre que pide el modelo se resuelve contra la lista de archivos reales, nunca se usa como ruta, y un enlace
 * simbolico que apunte fuera de la carpeta se ignora. De cada archivo se lee solo el final (LOGS_MAX_MB).
 */
@Injectable()
export class LogsService {
  private readonly inbox: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly cfg: ConfigService, @Optional() private readonly logDb?: LogDbService) { this.inbox = join(cfg.dataDir, 'logs-recibidos'); }
  /** Hay de donde leer: una carpeta montada o un canal de entrada encendido. */
  get enabled() { return !!this.cfg.logsDir || this.receiving || !!this.logDb?.enabled; }
  get receiving() { return !!this.cfg.logsIngestSecret || this.cfg.syslogPort > 0; }

  /** Archivos de log de las dos carpetas (hasta dos niveles), del mas reciente al mas antiguo. */
  async sources(): Promise<LogSource[]> {
    const out: LogSource[] = [];
    for (const [dir, prefix] of [[this.cfg.logsDir, ''], [this.inbox, `${INBOX}/`]] as const) {
      if (!dir) continue;
      const root = await realpath(resolve(dir)).catch(() => ''); if (!root) continue;
      const walk = async (at: string, rel: string, depth: number) => {
        for (const e of await readdir(at, { withFileTypes: true }).catch(() => [])) {
          if (e.name.startsWith('.') || out.length >= MAX_SOURCES) continue;
          const full = join(at, e.name), name = rel ? `${rel}/${e.name}` : e.name;
          const real = await realpath(full).catch(() => '');
          if (!real.startsWith(root + sep)) continue; // enlaces que salen de la carpeta
          const st = await stat(real).catch(() => undefined);
          if (st?.isDirectory()) { if (depth < 2) await walk(full, name, depth + 1); }
          else if (st?.isFile() && st.size > 0 && LOG_NAME.test(name)) out.push({ name: prefix + name, size: st.size, mtime: st.mtime, root, rel: name });
        }
      };
      await walk(root, '', 0);
    }
    for (const t of (await this.logDb?.tables()) ?? []) out.push({ name: `${LOGDB}/${t.schema}/${t.table}`, size: t.last, mtime: t.mtime, root: '', rel: '', db: { schema: t.schema, table: t.table, rows: t.rows } });
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  /** Ubica una fuente por nombre exacto o por una parte del nombre ("nginx", "auth"). Devuelve un texto si no hay una sola. */
  async find(query: string): Promise<LogSource | string> {
    const all = await this.sources(), q = String(query ?? '').trim().toLowerCase();
    if (!all.length) return 'no hay archivos de log todavía';
    if (!q) return all.length === 1 ? all[0] : `hay ${all.length} archivos; falta decir cuál: ${all.slice(0, 8).map((s) => s.name).join(', ')}`;
    const exact = all.find((s) => s.name.toLowerCase() === q); if (exact) return exact;
    const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !['log', 'logs', 'archivo', 'el', 'la', 'de', 'del'].includes(w));
    const near = all.filter((s) => s.name.toLowerCase().includes(q) || (words.length > 0 && words.every((w) => s.name.toLowerCase().includes(w))));
    if (near.length === 1) return near[0];
    return near.length ? `varios archivos coinciden: ${near.slice(0, 8).map((s) => s.name).join(', ')}` : `ningún archivo coincide; los que hay: ${all.slice(0, 8).map((s) => s.name).join(', ')}`;
  }

  /**
   * Las ultimas lineas del archivo (el final, hasta LOGS_MAX_MB). Una captura .pcap se convierte a lineas de tcpdump.
   * `from`: solo lo escrito despues de ese byte (archivos de texto sin comprimir; en los demas se ignora). En una tabla
   * de la base de logs, solo las filas con id mayor.
   */
  async tail(src: LogSource, from = 0): Promise<string[]> {
    if (src.db) { if (!this.logDb) throw new Error('la base de logs está apagada'); return this.logDb.lines(src.db.schema, src.db.table, from, MAX_LINES); } // `from` = id ya visto
    const real = await realpath(join(src.root, src.rel));
    if (!real.startsWith(src.root + sep)) throw new Error('ese archivo está fuera de la carpeta de logs');
    const max = this.cfg.logsMaxMb * 1024 * 1024;
    if (/\.(pcap|cap)$/i.test(src.name)) {
      if (src.size > MAX_PCAP) throw new Error('la captura es demasiado grande; divídela con tcpdump -C o -G');
      return pcapToLines(await readFile(real), MAX_LINES);
    }
    let text: string, cut = false;
    if (/\.gz$/i.test(src.name)) {
      if (src.size > MAX_GZ) throw new Error('el archivo comprimido es demasiado grande');
      const buf = gunzipSync(await readFile(real), { maxOutputLength: 64 * 1024 * 1024 });
      cut = buf.length > max; text = buf.subarray(Math.max(0, buf.length - max)).toString('utf8');
    } else {
      const fh = await open(real, 'r');
      try { const size = (await fh.stat()).size, start = from > 0 && from <= size ? from : 0, len = Math.min(size - start, max), buf = Buffer.alloc(len); await fh.read(buf, 0, len, size - len); cut = size - start > len; text = buf.toString('utf8'); }
      finally { await fh.close(); }
    }
    const lines = text.split(/\r?\n/);
    if (cut) lines.shift(); // la primera quedo cortada
    return lines.filter((l) => l.length > 0).slice(-MAX_LINES);
  }

  async analyze(src: LogSource, from = 0): Promise<Analysis> { return analyze(await this.tail(src, from)); }

  /** Busca un texto literal (sin expresiones regulares) y devuelve cuantas lineas coinciden y las ultimas, sin secretos. */
  async search(src: LogSource, text: string, max = 12): Promise<{ total: number; lines: string[] }> {
    const q = text.toLowerCase(), hits = (await this.tail(src)).filter((l) => l.toLowerCase().includes(q));
    return { total: hits.length, lines: hits.slice(-max).map((l) => safe(redact(l), 260)) };
  }

  /**
   * Guarda lineas que llegaron por la red en recibidos/<fuente>.log. El nombre se reduce a letras, numeros, punto, guion
   * y guion bajo; cada linea queda en un solo renglon y recortada. Al pasar de LOGS_INBOX_MAX_MB el archivo rota a ".1"
   * (se conserva uno anterior). Devuelve cuantas lineas guardo.
   */
  append(source: string, lines: string[]): Promise<number> {
    const name = String(source ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60);
    const clean = lines.map((l) => String(l ?? '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, MAX_LINE)).filter(Boolean);
    if (!name || !clean.length) return Promise.resolve(0);
    const file = join(this.inbox, `${name}.log`);
    const job = this.queue.then(async () => {
      await mkdir(this.inbox, { recursive: true });
      const size = (await stat(file).catch(() => undefined))?.size ?? 0;
      if (size > this.cfg.logsInboxMaxMb * 1024 * 1024) await rename(file, `${file}.1`);
      await appendFile(file, clean.join('\n') + '\n');
      return clean.length;
    });
    this.queue = job.catch(() => undefined); // un fallo no frena las escrituras siguientes
    return job;
  }
}
