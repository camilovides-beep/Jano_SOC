import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface SiteCheck { ok: boolean; pages: number; files: number; issues: string[]; at: string; }

const MAX_FILES = 400, MAX_BYTES = 1_500_000, MAX_ISSUES = 12;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i; // http:, https:, mailto:, tel:, data:, javascript:, //cdn..., #ancla

/**
 * Revision automatica del sitio que publico Claude Code (pedido por Javier el 2026-11-18: "terminado" debe venir con prueba).
 * No ejecuta nada: recorre `sitio/`, lee los .html y .css y comprueba que cada enlace, imagen, hoja de estilo o script
 * LOCAL exista. Tambien marca rutas absolutas (el sitio vive en /p/<proyecto>/, asi que "/css/x.css" no carga),
 * archivos vacios y enlaces simbolicos. No revisa enlaces externos ni si el diseño se ve bien.
 */
export function checkSite(base: string): SiteCheck {
  const issues: string[] = [], files: string[] = [];
  const add = (msg: string) => { if (issues.length < MAX_ISSUES && !issues.includes(msg)) issues.push(msg); };
  const walk = (dir: string) => {
    let names: string[]; try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (files.length >= MAX_FILES || n.startsWith('.') || n === 'node_modules') continue;
      const full = join(dir, n);
      let st; try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) { add(`${relative(base, full)}: es un enlace simbólico y no se publica`); continue; }
      if (st.isDirectory()) walk(full);
      else { files.push(full); if (st.size === 0) add(`${relative(base, full)}: el archivo está vacío`); }
    }
  };
  walk(base);
  const exists = (p: string) => { try { const st = lstatSync(p); return st.isFile() || (st.isDirectory() && lstatSync(join(p, 'index.html')).isFile()); } catch { return false; } };
  const root = resolve(base);
  let pages = 0;
  for (const file of files) {
    const isHtml = /\.html?$/i.test(file), isCss = /\.css$/i.test(file);
    if (!isHtml && !isCss) continue;
    let text: string;
    try { if (lstatSync(file).size > MAX_BYTES) continue; text = readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(base, file), refs = new Set<string>();
    if (isHtml) {
      pages++;
      text = text.replace(/<!--[\s\S]*?-->/g, '');
      for (const m of text.matchAll(/\s(?:href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) refs.add(m[1] ?? m[2]);
      for (const m of text.matchAll(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) for (const part of (m[1] ?? m[2]).split(',')) refs.add(part.trim().split(/\s+/)[0]);
      if (rel === 'index.html' && !/<title>\s*\S/i.test(text)) add('index.html: no tiene título (<title>)');
    }
    for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) refs.add(m[1] ?? m[2] ?? m[3]);
    for (const raw of refs) {
      const ref = (raw ?? '').trim();
      if (!ref || EXTERNAL.test(ref) || ref.includes('${') || ref.includes('{{')) continue; // externos y plantillas de JavaScript
      if (ref.startsWith('/')) { add(`${rel}: "${ref.slice(0, 80)}" es una ruta absoluta; el sitio se publica en una subcarpeta y no cargará`); continue; }
      let path = ref.split('#')[0].split('?')[0]; if (!path) continue;
      try { path = decodeURIComponent(path); } catch { /* se revisa tal cual */ }
      const target = resolve(dirname(file), path);
      if (target !== root && !target.startsWith(root + sep)) { add(`${rel}: "${ref.slice(0, 80)}" apunta fuera de la carpeta del sitio`); continue; }
      if (!exists(target)) add(`${rel}: no existe "${ref.slice(0, 80)}"`);
    }
  }
  if (!files.some((f) => relative(base, f) === 'index.html')) add('falta sitio/index.html');
  return { ok: issues.length === 0, pages, files: files.length, issues, at: new Date().toISOString() };
}
