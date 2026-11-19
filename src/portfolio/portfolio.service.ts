import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { GalleryItem } from './gallery';

/** Un caso del portafolio: un trabajo real de Javier, contado como problema, lo que hizo y resultado. */
export interface Case {
  id: number; created_at: string; updated_at: string; title: string; sector: string;
  client: string;    // vacio = el avatar no nombra al cliente
  problem: string; solution: string; result: string; tech: string; link: string;
  image: string;     // nombre del archivo en DATA_DIR/portafolio ('' = sin foto)
  visible: number;   // 0 = guardado pero el avatar no lo cuenta
}
export type CaseInput = Partial<Pick<Case, 'title' | 'sector' | 'client' | 'problem' | 'solution' | 'result' | 'tech' | 'link'>> & { visible?: boolean };

const FIELDS = { title: 100, sector: 80, client: 100, problem: 500, solution: 700, result: 500, tech: 200, link: 300 } as const;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** En el prompt van como mucho estos casos (los mas recientes); el resto se puede pedir con la herramienta. */
const PROMPT_CASES = 12;
/** Palabras que no sirven para buscar un caso (estan en casi todos los titulos). */
const STOP = new Set(['para', 'una', 'uno', 'unos', 'unas', 'con', 'los', 'las', 'del', 'por', 'que', 'caso', 'casos', 'proyecto', 'proyectos', 'trabajo', 'trabajos', 'camilo', 'guardian', 'cliente', 'the']);

/**
 * Portafolio de Javier (pedido el 2026-11-18): hasta ahora el avatar solo conocia servicios genericos. Los casos se cargan
 * en el panel o dictandoselos al avatar en modo dueño; viven en la base y se leen en memoria. Cada sesion nueva los recibe
 * en su prompt, asi que un caso guardado se puede contar en la conversacion siguiente, sin redesplegar.
 * Las fotos se guardan en DATA_DIR/portafolio y se sirven en /imagenes/<nombre> (nombre al azar con prefijo "p").
 */
@Injectable()
export class PortfolioService implements OnModuleInit {
  private readonly log = new Logger(PortfolioService.name);
  private items: Case[] = [];
  private readonly dir: string;
  constructor(cfg: ConfigService, private readonly db: DbService) { this.dir = resolve(cfg.dataDir, 'portafolio'); }

  async onModuleInit() {
    try { await this.reload(); this.log.log(`portafolio: ${this.items.length} casos (${this.visible().length} visibles)`); }
    catch (e) { this.log.warn(`no se pudo leer el portafolio: ${(e as Error).message}`); }
  }
  private async reload() { this.items = await this.db.query<Case>('SELECT * FROM portfolio ORDER BY updated_at DESC'); }

  list(): Case[] { return this.items; }
  visible(): Case[] { return this.items.filter((c) => Number(c.visible)); }
  get(id: number): Case | undefined { return this.items.find((c) => c.id === id); }

  /** Busca por parte del titulo, el sector o el cliente. `all` incluye los ocultos (modo dueño). */
  find(q: string, all = false, strict = false): Case[] {
    const words = plain(q).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 2 && !STOP.has(w));
    if (!words.length) return [];
    const pool = all ? this.items : this.visible();
    const hay = (c: Case) => plain(`${c.title} ${c.sector} ${c.client}`);
    const every = pool.filter((c) => words.every((w) => hay(c).includes(w)));
    return every.length || strict ? every : pool.filter((c) => words.some((w) => hay(c).includes(w))); // sin `strict`, vale parecerse en una palabra
  }
  /** El caso con ese titulo exacto (sin mirar mayusculas ni tildes). */
  byTitle(title: string): Case | undefined { const t = plain(title.trim()); return this.items.find((c) => plain(c.title) === t); }

  /** Crea un caso (sin id) o cambia los campos que vengan (con id). Devuelve el caso guardado. */
  async save(input: CaseInput, id?: number): Promise<Case> {
    const now = new Date().toISOString(), cur = id ? this.get(id) : undefined;
    if (id && !cur) throw new Error('ese caso no existe');
    const v: Record<string, string> = {};
    for (const [k, max] of Object.entries(FIELDS)) v[k] = (input as any)[k] === undefined ? (cur as any)?.[k] ?? '' : clip((input as any)[k], max);
    if (v.title.length < 3) throw new Error('falta el título del caso');
    if (v.link && !/^https?:\/\/[^\s]+$/i.test(v.link)) throw new Error('el enlace debe empezar por http:// o https://');
    const visible = input.visible === undefined ? Number(cur?.visible ?? 1) : input.visible ? 1 : 0;
    if (cur) await this.db.query('UPDATE portfolio SET updated_at = $1, title = $2, sector = $3, client = $4, problem = $5, solution = $6, result = $7, tech = $8, link = $9, visible = $10 WHERE id = $11',
      [now, v.title, v.sector, v.client, v.problem, v.solution, v.result, v.tech, v.link, visible, cur.id]);
    else id = (await this.db.query<{ id: number }>('INSERT INTO portfolio (created_at, updated_at, title, sector, client, problem, solution, result, tech, link, visible) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
      [now, now, v.title, v.sector, v.client, v.problem, v.solution, v.result, v.tech, v.link, visible]))[0].id;
    await this.reload();
    return this.get(id!)!;
  }

  async remove(id: number): Promise<boolean> {
    const cur = this.get(id); if (!cur) return false;
    await this.db.query('DELETE FROM portfolio WHERE id = $1', [id]);
    this.dropFile(cur.image);
    await this.reload();
    return true;
  }

  /** Guarda la foto de un caso (JPEG, PNG o WebP; se comprueba por sus primeros bytes, no por lo que diga el navegador). */
  async setImage(id: number, buf: Buffer): Promise<Case> {
    const cur = this.get(id); if (!cur) throw new Error('ese caso no existe');
    const ext = buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png'
      : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' : '';
    if (!ext) throw new Error('la foto debe ser JPEG, PNG o WebP');
    mkdirSync(this.dir, { recursive: true });
    const name = `p${randomBytes(12).toString('hex')}.${ext}`;
    writeFileSync(join(this.dir, name), buf);
    await this.db.query('UPDATE portfolio SET image = $1, updated_at = $2 WHERE id = $3', [name, new Date().toISOString(), id]);
    this.dropFile(cur.image);
    await this.reload();
    return this.get(id)!;
  }
  async clearImage(id: number): Promise<boolean> {
    const cur = this.get(id); if (!cur) return false;
    await this.db.query(`UPDATE portfolio SET image = '' WHERE id = $1`, [id]);
    this.dropFile(cur.image); await this.reload();
    return true;
  }
  private dropFile(name: string) { const f = this.file(name); if (f) try { unlinkSync(f); } catch { /* ya no estaba */ } }

  /** Ruta en disco de una foto del portafolio, o null si el nombre no es valido o no existe. */
  file(name: string): string | null {
    if (!/^p[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) return null;
    const full = join(this.dir, name);
    try { return statSync(full).isFile() ? full : null; } catch { return null; }
  }

  /** El caso contado en texto, para el modelo. `max` recorta cada parte (en el prompt va mas corto que en la herramienta). */
  describe(c: Case, max = 700): string {
    const part = (label: string, v: string) => (v ? ` ${label}: ${v.slice(0, max)}${/[.!?]$/.test(v.slice(0, max)) ? '' : '.'}` : '');
    return `"${c.title}"${c.sector ? ` (${c.sector})` : ''}.${c.client ? ` Cliente: ${c.client}.` : ' Cliente: no se nombra.'}` +
      part('Problema', c.problem) + part('Lo que hizo Camilo', c.solution) + part('Resultado', c.result) + part('Tecnología', c.tech);
  }

  /** Elementos de galeria de los casos que tienen foto. */
  gallery(cases: Case[]): GalleryItem[] {
    return cases.filter((c) => c.image).map((c) => ({ thumb: `/imagenes/${c.image}`, full: `/imagenes/${c.image}`, label: c.title + (c.sector ? ` · ${c.sector}` : '') }));
  }

  /** Reglas y lista de casos para el prompt de una sesion. Vacio si no hay casos visibles. */
  prompt(screen: boolean): string {
    const cases = this.visible();
    if (!cases.length) return '';
    return `

PORTAFOLIO: estos son trabajos REALES de Camilo. Son los únicos casos que puedes contar: no inventes otros, ni clientes, ni cifras que no estén aquí.
${cases.slice(0, PROMPT_CASES).map((c, i) => `${i + 1}. ${this.describe(c, 260)}`).join('\n')}${cases.length > PROMPT_CASES ? `\n(Hay ${cases.length - PROMPT_CASES} casos más; búscalos con la herramienta portafolio.)` : ''}
- Cuando la persona cuente qué negocio tiene o qué necesita, o pregunte qué ha hecho Camilo, cuéntale en dos o tres frases el caso que más se parezca: el problema, lo que hizo Camilo y el resultado. Uno solo, no la lista.
- Si el caso dice "Cliente: no se nombra", no digas ni adivines quién es el cliente; di "un cliente" o el sector.
- Si ningún caso se parece, dilo con honestidad y cuenta el más cercano sin exagerar el parecido.${screen ? '\n- Al contar un caso, llama a portafolio con su título: si tiene foto, se muestra en pantalla (en grande; tú quedas pequeño en una esquina). Con galeria cambias la foto ("la dos", "la siguiente") o las quitas.' : ''}`;
  }
}
