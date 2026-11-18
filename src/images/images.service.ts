import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { UsageService } from '../usage/usage.service';

/** Un elemento de la galeria en pantalla: una foto (thumb/full) o un boceto en vivo (frame = direccion de la pagina). */
export interface GalleryItem { thumb?: string; full?: string; frame?: string; label: string; credit?: string; link?: string; }
/** Galeria de la sesion: lo que se esta mostrando al lado del avatar y cual esta seleccionada (va de fondo). */
export interface GalleryState { title: string; kind: 'fotos' | 'bocetos' | 'generadas' | 'portafolio' | ''; items: GalleryItem[]; index: number; }

const FORMATS: Record<string, string> = { horizontal: 'widescreen_16_9', cuadrada: 'square_1_1', vertical: 'social_story_9_16' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Imagenes para la galeria del avatar (pedido por Javier el 2026-11-18).
 *
 * BUSQUEDA: Unsplash (Pexels tenia pausada la entrega de claves). Documentacion leida ese dia:
 *  - GET https://api.unsplash.com/search/photos?query=&per_page=(max 30)&orientation=landscape|portrait|squarish&content_filter=low|high
 *    con cabecera `Authorization: Client-ID <clave de acceso>`. Modo demo: 50 peticiones por hora.
 *  - EXIGEN usar directamente las direcciones `urls.*` que devuelve la API (enlazar, no copiar) y dar credito al fotografo
 *    y a Unsplash. `content_filter=high` quita contenido no apto para publico joven.
 *  - De cada resultado se usa urls.small, urls.regular, alt_description, user.name y links.html. Estos tres ultimos nombres
 *    NO se confirmaron en la lectura de la documentacion (se cortaba antes): comprobar con la primera busqueda real.
 *
 * GENERACION: Magnific (la API de Freepik), modelo Mystic. Documentacion leida ese dia:
 *  - POST https://api.magnific.com/v1/ai/mystic con cabecera `x-magnific-api-key`; cuerpo {prompt, aspect_ratio, resolution
 *    (1k|2k|4k), filter_nsfw (true y no se puede apagar)} -> {data: {task_id, status}}.
 *  - GET /v1/ai/mystic/{task-id} -> data.status CREATED|IN_PROGRESS|COMPLETED|FAILED y data.generated[] con la direccion.
 *  - La direccion caduca a los 30 minutos: la imagen se descarga y se guarda en DATA_DIR/imagenes. Cobra por creditos;
 *    el precio por imagen no esta en la documentacion.
 * SIN PROBAR con claves reales al escribir esto (Javier aun no las habia puesto): solo con respuestas simuladas.
 */
@Injectable()
export class ImagesService implements OnModuleInit {
  private readonly log = new Logger(ImagesService.name);
  private readonly cache = new Map<string, { at: number; items: GalleryItem[] }>();
  private day = ''; private used = 0; private generated = 0;
  private readonly dir: string;
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService, private readonly db: DbService) { this.dir = resolve(cfg.dataDir, 'imagenes'); } // absoluta: res.sendFile no acepta rutas relativas

  /** Hay busqueda de fotos. */
  get enabled() { return !!this.cfg.unsplashAccessKey; }
  /** Hay generacion de imagenes. */
  get canGenerate() { return !!this.cfg.magnificApiKey; }
  newState(): GalleryState { return { title: '', kind: '', items: [], index: 0 }; }
  private today() { const t = new Date().toISOString().slice(0, 10); if (t !== this.day) { this.day = t; this.used = 0; this.generated = 0; } }

  async search(query: string, count = 6): Promise<GalleryItem[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 100), key = q.toLowerCase(), n = Math.min(8, Math.max(1, Math.round(count) || 6));
    if (!q) return [];
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.items.slice(0, n);
    this.today();
    if (this.used >= this.cfg.imagesDailySearches) throw new Error('se alcanzó el tope de búsquedas de imágenes de hoy');
    this.used++; this.usage.add('image_searches');
    const url = new URL('https://api.unsplash.com/search/photos');
    url.search = new URLSearchParams({ query: q, per_page: '8', orientation: 'landscape', content_filter: 'high' }).toString();
    let res: Response;
    try { res = await fetch(url, { headers: { Authorization: `Client-ID ${this.cfg.unsplashAccessKey}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Unsplash (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) { this.log.warn(`Unsplash respondió ${res.status}`); throw new Error(res.status === 403 ? 'Unsplash llegó a su límite por hora; se puede reintentar más tarde' : `Unsplash respondió ${res.status}`); }
    const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const own = (v: unknown) => { const s = String(v ?? ''); return /^https:\/\/([a-z0-9-]+\.)?unsplash\.com\//i.test(s) ? s : ''; }; // solo direcciones de Unsplash
    const items: GalleryItem[] = (Array.isArray(d.results) ? d.results : []).map((p: any) => {
      const author = clean(p?.user?.name, 60);
      return { thumb: own(p?.urls?.small), full: own(p?.urls?.regular), label: clean(p?.alt_description ?? p?.description, 120) || q,
        credit: author ? `Foto de ${author} en Unsplash` : 'Foto de Unsplash', link: own(p?.links?.html) || 'https://unsplash.com' };
    }).filter((i: GalleryItem) => i.thumb && i.full);
    this.cache.set(key, { at: Date.now(), items });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return items.slice(0, n);
  }

  /** Antes de lanzar una generacion: '' si se puede, o el motivo por el que no. Cuenta el intento. */
  reserveGeneration(): string {
    if (!this.canGenerate) return 'la generación de imágenes no está configurada';
    this.today();
    if (this.generated >= this.cfg.imagesDailyGenerations) return 'se alcanzó el tope de imágenes generadas de hoy';
    this.generated++; this.usage.add('image_generations');
    return '';
  }

  /**
   * Genera una imagen con Magnific y la guarda en DATA_DIR/imagenes. Tarda de varios segundos a mas de un minuto.
   * Devuelve el nombre del archivo guardado (se sirve en /imagenes/<nombre>).
   */
  async generate(prompt: string, format = 'horizontal', signal?: AbortSignal): Promise<string> {
    const headers = { 'x-magnific-api-key': this.cfg.magnificApiKey, 'Content-Type': 'application/json' };
    const api = 'https://api.magnific.com/v1/ai/mystic';
    const res = await fetch(api, { method: 'POST', headers, body: JSON.stringify({ prompt: prompt.slice(0, 1500), aspect_ratio: FORMATS[format] ?? FORMATS.horizontal, resolution: '1k' }), signal: signal ?? AbortSignal.timeout(20_000) });
    const d: any = await res.json().catch(() => ({}));
    const id = String(d?.data?.task_id ?? '');
    if (!res.ok || !/^[\w-]{6,80}$/.test(id)) throw new Error(`Magnific respondió ${res.status}${res.status === 401 ? ' (clave inválida)' : ''}`);
    let urlOut = String(d?.data?.generated?.[0] ?? '');
    for (let i = 0; !urlOut && i < 60; i++) { // hasta ~2 minutos
      await wait(2000);
      const r = await fetch(`${api}/${id}`, { headers, signal: AbortSignal.timeout(10_000) });
      const t: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Magnific respondió ${r.status} al consultar la imagen`);
      if (t?.data?.status === 'FAILED') throw new Error('Magnific no pudo generar la imagen');
      if (t?.data?.status === 'COMPLETED') { urlOut = String(t.data.generated?.[0] ?? ''); if (!urlOut) throw new Error('Magnific terminó sin entregar la imagen (pudo bloquearla su filtro de contenido)'); }
    }
    if (!urlOut) throw new Error('la imagen tardó demasiado');
    if (!/^https:\/\//.test(urlOut)) throw new Error('Magnific devolvió una dirección no válida');
    const img = await fetch(urlOut, { signal: AbortSignal.timeout(30_000) });
    const type = (img.headers.get('content-type') ?? '').split(';')[0];
    if (!img.ok || !/^image\/(jpeg|png|webp)$/.test(type)) throw new Error('no se pudo descargar la imagen generada');
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 20 * 1024 * 1024) throw new Error('la imagen generada es demasiado grande');
    mkdirSync(this.dir, { recursive: true });
    const name = `${randomBytes(12).toString('hex')}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
    writeFileSync(join(this.dir, name), buf);
    await this.db.query('INSERT INTO generated_images (at, name, prompt, format, bytes) VALUES ($1, $2, $3, $4, $5)', [new Date().toISOString(), name, prompt.slice(0, 1500), FORMATS[format] ? format : 'horizontal', buf.length])
      .catch((e) => this.log.warn(`la imagen se guardó pero no quedó anotada: ${(e as Error).message}`));
    this.log.log(`imagen generada (${Math.round(buf.length / 1024)} KB)`);
    return name;
  }

  /** Ruta en disco de una imagen generada, o null si el nombre no es valido o no existe. */
  file(name: string): string | null {
    if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) return null;
    const full = join(this.dir, name);
    try { return statSync(full).isFile() ? full : null; } catch { return null; }
  }

  /**
   * Las imagenes generadas se conservan todas (pedido por Javier el 2026-11-18: antes solo quedaban las ultimas 200) y se
   * anotan en la tabla `generated_images` con su descripcion, para verlas, descargarlas o borrarlas en el panel.
   * Al arrancar se anotan las que ya estaban en la carpeta de antes (sin descripcion).
   */
  async onModuleInit() {
    try {
      const known = new Set((await this.db.query<{ name: string }>('SELECT name FROM generated_images')).map((r) => r.name));
      for (const n of readdirSync(this.dir)) {
        if (known.has(n) || !this.file(n)) continue;
        const st = statSync(join(this.dir, n));
        await this.db.query('INSERT INTO generated_images (at, name, prompt, format, bytes) VALUES ($1, $2, $3, $4, $5)', [st.mtime.toISOString(), n, '', '', st.size]);
      }
    } catch { /* aun no hay carpeta de imagenes */ }
  }
  listGenerated(limit = 300): Promise<GeneratedImage[]> { return this.db.query<GeneratedImage>('SELECT * FROM generated_images ORDER BY at DESC LIMIT $1', [Math.min(1000, Math.max(1, limit))]); }
  async removeGenerated(id: number): Promise<boolean> {
    const row = (await this.db.query<GeneratedImage>('DELETE FROM generated_images WHERE id = $1 RETURNING name', [id]))[0];
    if (!row) return false;
    const f = this.file(row.name); if (f) try { unlinkSync(f); } catch { /* ya no estaba */ }
    return true;
  }
}

/** Una imagen generada con IA y guardada en DATA_DIR/imagenes. */
export interface GeneratedImage { id: number; at: string; name: string; prompt: string; format: string; bytes: number }
