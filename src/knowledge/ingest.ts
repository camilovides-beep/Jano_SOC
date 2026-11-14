// Carga los documentos de KNOWLEDGE_DIR en Qdrant. Uso: npm run conocimiento
//   <KNOWLEDGE_DIR>/publico/*.md|.txt  -> lo que puede saber cualquier visitante
//   <KNOWLEDGE_DIR>/privado/*.md|.txt  -> solo para el modo dueño
// Se puede ejecutar en local contra el Qdrant remoto: los documentos no necesitan estar en el repositorio.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
import { ConfigService } from '../config/config.service';
import { KnowledgeService } from './knowledge.service';

/** Parte un texto en fragmentos de ~900 caracteres respetando parrafos; el titulo de la seccion acompana a cada uno. */
export function chunk(text: string, max = 900): string[] {
  const out: string[] = [];
  let heading = '', cur = '';
  const push = () => { const t = cur.trim(); if (t.length > 20) out.push(heading && !t.startsWith(heading) ? `${heading}\n${t}` : t); cur = ''; };
  for (const para of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const p = para.trim(); if (!p) continue;
    const h = p.match(/^#{1,6}\s+(.+)$/m);
    if (h && p.startsWith('#')) { push(); heading = h[1].trim(); }
    if (cur.length + p.length > max) push();
    if (p.length > max) { for (let i = 0; i < p.length; i += max) { cur = p.slice(i, i + max); push(); } continue; }
    cur += (cur ? '\n\n' : '') + p;
  }
  push();
  return out;
}

async function main() {
  const cfg = new ConfigService(); const kb = new KnowledgeService(cfg);
  if (!kb.enabled) throw new Error('Faltan NVIDIA_API_KEY o QDRANT_URL');
  const [probe] = await kb.embed(['prueba'], 'passage');
  await kb.ensureCollection(probe.length);
  let total = 0;
  for (const scope of ['publico', 'privado'] as const) {
    const dir = join(cfg.knowledgeDir, scope);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f)).sort()) {
      const parts = chunk(readFileSync(join(dir, file), 'utf8'));
      await kb.replaceSource(`${scope}/${file}`, scope, parts);
      console.log(`${scope}/${file}: ${parts.length} fragmentos`);
      total += parts.length;
    }
  }
  console.log(`Listo: ${total} fragmentos cargados. La coleccion "${cfg.qdrantCollection}" tiene ${await kb.count()} puntos.`);
}
if (require.main === module) main().catch((e) => { console.error(`No se pudo cargar: ${e.message}`); process.exit(1); });
