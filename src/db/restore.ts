import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
if (existsSync('.env')) process.loadEnvFile('.env');
import { ConfigService } from '../config/config.service';
import { DbService } from './db.service';
import { BACKUP_TABLES } from '../ops/ops.service';

/**
 * Restaura un respaldo hecho por el avatar: `npm run restaurar -- <archivo.json.gz> [--forzar]`.
 * Escribe en la base que indique DATABASE_URL (o en el SQLite de DATA_DIR). Por seguridad no toca una base que ya tenga
 * interesados, salvo con --forzar, que BORRA lo que haya en las tablas antes de cargar el respaldo.
 */
async function main() {
  const file = process.argv[2], force = process.argv.includes('--forzar');
  if (!file || !existsSync(file)) throw new Error('Uso: npm run restaurar -- <archivo.json.gz> [--forzar]');
  const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  if (data?.app !== 'minijavi' || !data.tables) throw new Error('El archivo no es un respaldo del avatar');
  const db = new DbService(new ConfigService());
  const existing = Number((await db.query('SELECT COUNT(*) AS n FROM leads'))[0]?.n ?? 0);
  if (existing && !force) throw new Error(`La base ya tiene ${existing} interesados. Para reemplazar todo su contenido, repite con --forzar.`);
  for (const t of BACKUP_TABLES) {
    if (!(t in data.tables)) continue; // respaldo anterior a esa tabla: no se toca lo que haya
    const rows: Record<string, unknown>[] = Array.isArray(data.tables[t]) ? data.tables[t] : [];
    await db.query(`DELETE FROM ${t}`);
    for (const r of rows) {
      const cols = Object.keys(r).filter((c) => /^[a-z_]+$/.test(c));
      await db.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => r[c]));
    }
    // En PostgreSQL el contador de ids debe seguir despues del mayor id restaurado.
    if (db.kind === 'postgres' && rows.some((r) => 'id' in r && typeof r.id === 'number')) await db.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`);
    console.log(`${t}: ${rows.length} registros`);
  }
  console.log(`Respaldo del ${String(data.at).slice(0, 10)} restaurado en ${db.kind}.`);
  await db.onModuleDestroy();
}
main().catch((e) => { console.error(`No se pudo restaurar: ${e.message}`); process.exit(1); });
