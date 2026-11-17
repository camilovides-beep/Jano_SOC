import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

export interface Track { id: string; title: string; channel: string; }
/** Musica de una sesion: la cola la decide el servidor; el navegador la reproduce y avisa cuando cambia de cancion. */
export interface MusicState { queue: Track[]; index: number; volume: number; playing: boolean; since: number; }

const decode = (t: string) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * Busqueda de musica en YouTube (Data API v3). Verificado con la documentacion y una llamada real el 2026-11-17:
 *  GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&q=...&key=...
 *  -> items[].id.videoId, snippet.title, snippet.channelTitle. videoEmbeddable exige type=video.
 * La cuota por defecto es de solo 100 busquedas al dia: cada busqueda trae varias canciones (sirven para "la siguiente"),
 * se guarda 24 h y hay un tope diario propio. La reproduccion la hace el navegador con el reproductor oficial (IFrame
 * API), visible y de al menos 200x200 px, como exigen las politicas de YouTube; no se extrae el audio.
 */
@Injectable()
export class MusicService {
  private readonly log = new Logger(MusicService.name);
  private readonly cache = new Map<string, { at: number; tracks: Track[] }>();
  private day = ''; private used = 0;
  constructor(private readonly cfg: ConfigService) {}

  get enabled() { return !!this.cfg.youtubeApiKey; }
  newState(): MusicState { return { queue: [], index: 0, volume: this.cfg.musicVolume, playing: false, since: 0 }; }

  async search(query: string): Promise<Track[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 120), key = q.toLowerCase();
    if (!q) return [];
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.tracks;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
    if (this.used >= this.cfg.musicDailySearches) throw new Error('se alcanzó el tope de búsquedas de música de hoy');
    this.used++;
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', q, type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '10', safeSearch: 'moderate', key: this.cfg.youtubeApiKey }).toString();
    let res: Response;
    try { res = await fetch(url, { signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw new Error(`no se pudo conectar con YouTube (${(e as Error).name})`); } // sin el mensaje: podria traer la URL con la clave
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) { this.log.warn(`YouTube respondió ${res.status}: ${String(d.error?.errors?.[0]?.reason ?? 'sin detalle')}`); throw new Error(`YouTube respondió ${res.status}${d.error?.errors?.[0]?.reason === 'quotaExceeded' ? ' (se acabó la cuota de hoy)' : ''}`); }
    const tracks: Track[] = (d.items ?? []).filter((i: any) => i.id?.videoId)
      .map((i: any) => ({ id: String(i.id.videoId), title: decode(String(i.snippet?.title ?? '')).slice(0, 100), channel: decode(String(i.snippet?.channelTitle ?? '')).slice(0, 60) }));
    this.cache.set(key, { at: Date.now(), tracks });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    this.log.log(`música: "${q}" -> ${tracks.length} resultados (búsqueda ${this.used}/${this.cfg.musicDailySearches} de hoy)`);
    return tracks;
  }
}
