import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { ConfigService } from '../config/config.service';

/** Una tabla de logs: `last` es el id mas alto (hace de "tamaño" para saber si llego algo nuevo). */
export interface LogTable { schema: string; table: string; last: number; rows: number; mtime: Date; }
/** Prefijo de las fuentes que salen de la base de logs: bd/<esquema>/<tabla>. */
export const LOGDB = 'bd';
const LIST_TTL_MS = 20_000, MAX_TABLES = 150;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Base de datos de logs (pedido por Camilo el 2026-11-24): un PostgreSQL donde cada aplicacion o servidor escribe sus
 * registros en una tabla propia, dentro de los esquemas de LOGS_DB_SCHEMAS (apps, servers). Cada tabla se ofrece como
 * una fuente de logs mas ("bd/apps/clara") y pasa por el mismo analisis que un archivo: cada fila viaja como una linea JSON.
 *  - Solo se lee: la sesion arranca en modo de solo lectura y cada consulta tiene tiempo limite.
 *  - Las tablas salen del catalogo de PostgreSQL, nunca de lo que pida el modelo o la consola, y solo de esos esquemas.
 *  - Una tabla necesita una columna `id` entera que crezca con cada fila; sin ella no se lista.
 *  - Se leen las ultimas LOGS_DB_MAX_ROWS filas de cada tabla.
 */
@Injectable()
export class LogDbService implements OnModuleDestroy {
  private readonly log = new Logger(LogDbService.name);
  private pool?: Pool;
  private cache?: { at: number; tables: LogTable[] };
  private listing?: Promise<LogTable[]>;
  /** Ultimo fallo al consultar, para mostrarlo en la consola. */
  error = '';
  constructor(private readonly cfg: ConfigService) {
    if (!this.enabled) return;
    this.pool = new Pool({ host: cfg.logsDbHost, port: cfg.logsDbPort, database: cfg.logsDbName, user: cfg.logsDbUser, password: cfg.logsDbPassword, ssl: cfg.logsDbSsl ? { rejectUnauthorized: false } : undefined,
      max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8000, statement_timeout: 20_000, application_name: 'jano-soc', options: '-c default_transaction_read_only=on' });
    this.pool.on('error', (e) => this.log.warn(`base de logs: ${e.message}`));
  }
  get enabled() { return !!(this.cfg.logsDbHost && this.cfg.logsDbName && this.cfg.logsDbUser && this.cfg.logsDbSchemas.length); }
  get label() { return this.enabled ? `${this.cfg.logsDbName} · esquemas ${this.cfg.logsDbSchemas.join(', ')}` : ''; }
  async onModuleDestroy() { await this.pool?.end().catch(() => undefined); }

  /** Tablas con filas de los esquemas configurados. La lista se guarda unos segundos: la consola la pide a cada rato. */
  tables(): Promise<LogTable[]> {
    if (!this.pool) return Promise.resolve([]);
    if (this.cache && Date.now() - this.cache.at < LIST_TTL_MS) return Promise.resolve(this.cache.tables);
    this.listing ??= this.list().then((tables) => { this.cache = { at: Date.now(), tables }; this.error = ''; return tables; })
      .catch((e) => { this.error = (e as Error).message; this.log.warn(`base de logs: ${this.error}`); return this.cache?.tables ?? []; })
      .finally(() => { this.listing = undefined; });
    return this.listing;
  }

  private async list(): Promise<LogTable[]> {
    const found = (await this.pool!.query<{ schema: string; table: string; ts: string | null }>(
      `SELECT c.table_schema AS schema, c.table_name AS table,
              (SELECT x.column_name FROM information_schema.columns x WHERE x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.data_type LIKE 'timestamp%' ORDER BY (x.column_name = 'timestamp') DESC, x.ordinal_position LIMIT 1) AS ts
         FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = ANY($1) AND c.column_name = 'id' AND c.data_type IN ('bigint', 'integer', 'smallint')
        ORDER BY 1, 2 LIMIT ${MAX_TABLES}`, [this.cfg.logsDbSchemas])).rows;
    if (!found.length) return [];
    // Una sola consulta para todas: id mas alto, filas y fecha mas reciente de cada tabla.
    const sql = found.map((f, i) => `SELECT ${i} AS i, max(id)::bigint AS last, count(*)::bigint AS rows, ${f.ts ? `max(${ident(f.ts)})` : 'NULL::timestamptz'} AS mtime FROM ${ident(f.schema)}.${ident(f.table)}`).join(' UNION ALL ');
    const stats = (await this.pool!.query<{ i: number; last: string | null; rows: string; mtime: Date | null }>(sql)).rows;
    return stats.filter((s) => Number(s.rows) > 0 && Number(s.last) > 0)
      .map((s) => ({ schema: found[s.i].schema, table: found[s.i].table, last: Number(s.last), rows: Number(s.rows), mtime: s.mtime ? new Date(s.mtime) : new Date(0) }));
  }

  /** Las ultimas filas de una tabla (las de id mayor que `afterId`), de la mas antigua a la mas nueva, una linea JSON por fila. */
  async lines(schema: string, table: string, afterId = 0, max = this.cfg.logsDbMaxRows): Promise<string[]> {
    // La tabla tiene que estar en la lista que salio del catalogo: asi un nombre de fuera nunca llega al SQL.
    const t = (await this.tables()).find((x) => x.schema === schema && x.table === table);
    if (!this.pool || !t) throw new Error('esa tabla no está en la base de logs');
    const limit = Math.min(Math.max(1, max), this.cfg.logsDbMaxRows);
    const { rows } = await this.pool.query<{ line: string }>(`SELECT row_to_json(r)::text AS line FROM (SELECT * FROM ${ident(schema)}.${ident(table)} WHERE id > $1 ORDER BY id DESC LIMIT $2) r`, [Math.max(0, Math.floor(afterId)), limit]);
    return rows.reverse().map((r) => r.line);
  }
}
