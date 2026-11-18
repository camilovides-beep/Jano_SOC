import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';

/** Un elemento de la galeria en pantalla: una foto (thumb/full) o un boceto en vivo (frame = direccion de la pagina). */
export interface GalleryItem { thumb?: string; full?: string; frame?: string; label: string; credit?: string; link?: string; }
/** Galeria de la sesion: lo que se esta mostrando al lado del avatar y cual esta seleccionada (va de fondo). */
export interface GalleryState { title: string; kind: 'fotos' | 'bocetos' | ''; items: GalleryItem[]; index: number; }

/**
 * Busqueda de fotos en Pexels (pedido por Javier el 2026-11-18). Documentacion leida ese dia:
 *  - GET https://api.pexels.com/v1/search?query=&per_page=(max 80)&orientation=landscape|portrait|square&locale=es-ES
 *    con cabecera `Authorization: <clave>` (sin "Bearer"). No tiene parametro de busqueda segura.
 *  - Respuesta: photos[] con url (pagina en Pexels), photographer, alt y src {tiny 280x200, medium (alto 350),
 *    landscape 1200x627, large, large2x, original...}.
 *  - Limite por defecto: 200 peticiones por hora y 20.000 al mes.
 *  - Condiciones: mostrar un enlace visible a Pexels ("Photos provided by Pexels") y dar credito al fotografo cuando se pueda.
 * SIN PROBAR con una clave real al escribir esto (Javier aun no la habia puesto): solo con respuestas simuladas.
 */
@Injectable()
export class ImagesService {
  private readonly log = new Logger(ImagesService.name);
  private readonly cache = new Map<string, { at: number; items: GalleryItem[] }>();
  private day = ''; private used = 0;
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {}

  get enabled() { return !!this.cfg.pexelsApiKey; }
  newState(): GalleryState { return { title: '', kind: '', items: [], index: 0 }; }

  async search(query: string, count = 6): Promise<GalleryItem[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 100), key = q.toLowerCase(), n = Math.min(8, Math.max(1, Math.round(count) || 6));
    if (!q) return [];
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.items.slice(0, n);
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
    if (this.used >= this.cfg.imagesDailySearches) throw new Error('se alcanzó el tope de búsquedas de imágenes de hoy');
    this.used++; this.usage.add('pexels_searches');
    const url = new URL('https://api.pexels.com/v1/search');
    url.search = new URLSearchParams({ query: q, per_page: '8', orientation: 'landscape', locale: 'es-ES' }).toString();
    let res: Response;
    try { res = await fetch(url, { headers: { Authorization: this.cfg.pexelsApiKey }, signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw new Error(`no se pudo conectar con Pexels (${(e as Error).name})`); }
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) { this.log.warn(`Pexels respondió ${res.status}`); throw new Error(`Pexels respondió ${res.status}`); }
    const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const https = (v: unknown) => { const s = String(v ?? ''); return /^https:\/\/[a-z0-9.-]+\.pexels\.com\//i.test(s) ? s : ''; }; // solo direcciones de Pexels
    const items: GalleryItem[] = (Array.isArray(d.photos) ? d.photos : []).map((p: any) => ({
      thumb: https(p?.src?.medium), full: https(p?.src?.landscape) || https(p?.src?.large), label: clean(p?.alt, 120) || q,
      credit: clean(p?.photographer, 60), link: https(p?.url),
    })).filter((i: GalleryItem) => i.thumb && i.full);
    this.cache.set(key, { at: Date.now(), items });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return items.slice(0, n);
  }
}
