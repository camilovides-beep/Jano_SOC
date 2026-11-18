import { Body, Controller, Get, Header, HttpCode, HttpException, Options, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LeadsService } from '../leads/leads.service';
import { WorkshopService } from './workshop.service';

const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const HOUR = 3600_000;

/**
 * Sitios publicados por el taller (`/p/<proyecto>/`) y formulario de contacto para esos sitios (`POST /formulario`).
 * El contenido lo escribe Claude Code, asi que se sirve con `Content-Security-Policy: sandbox`: el navegador lo trata
 * como otro origen y sus scripts no pueden usar la sesion de dueño ni llamar a /owner con la cookie.
 */
@Controller()
export class SitesController {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly workshop: WorkshopService, private readonly leads: LeadsService) {}

  @Get('p/:slug')
  root(@Req() req: Request, @Param('slug') slug: string, @Res() res: Response) {
    if (!req.path.endsWith('/')) return res.redirect(302, `/p/${encodeURIComponent(slug)}/`); // las rutas relativas necesitan la barra final
    return this.serve(slug, '', res);
  }

  @Get('p/:slug/{*path}')
  file(@Param('slug') slug: string, @Param('path') path: string | string[], @Res() res: Response) {
    return this.serve(slug, Array.isArray(path) ? path.join('/') : String(path ?? ''), res);
  }

  private serve(slug: string, rel: string, res: Response) {
    const file = this.workshop.siteFile(slug, rel);
    if (!file) throw new HttpException('no encontrado', 404);
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(file);
  }

  private cors(res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*'); // los sitios en sandbox llaman desde un origen opaco
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  /** Tope de envios por direccion y global, en memoria: evita que el formulario se use para llenar la base. */
  private allowed(key: string, max: number): boolean {
    const now = Date.now(), list = (this.hits.get(key) ?? []).filter((t) => now - t < HOUR);
    if (list.length >= max) { this.hits.set(key, list); return false; }
    list.push(now); this.hits.set(key, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < HOUR)) this.hits.delete(k);
    return true;
  }

  @Options('formulario')
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) res: Response) { this.cors(res); }

  /**
   * Guarda un interesado que lleno el formulario de un sitio del taller y avisa por Telegram.
   * No envia la plantilla de WhatsApp: cualquiera podria usar el formulario para mandar mensajes a numeros ajenos.
   */
  @Post('formulario')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async form(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: Record<string, unknown>) {
    this.cors(res);
    const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const slug = txt(body?.proyecto, 40), name = txt(body?.nombre, 120), contact = txt(body?.contacto, 160), message = txt(body?.mensaje, 600);
    if (txt(body?.sitio_web, 10)) return { ok: true }; // campo trampa: solo lo llenan los robots
    const project = this.workshop.list().find((p) => p.slug === slug);
    if (!project || !this.workshop.hasSite(slug)) throw new HttpException({ ok: false, error: 'proyecto' }, 400);
    if (body?.autoriza !== true && body?.autoriza !== 'true' && body?.autoriza !== 'on') throw new HttpException({ ok: false, error: 'autorizacion' }, 400);
    if (name.length < 2 || contact.length < 5) throw new HttpException({ ok: false, error: 'datos' }, 400);
    if (!this.allowed(`ip:${ipOf(req)}`, 5) || !this.allowed('global', 60)) throw new HttpException({ ok: false, error: 'limite' }, 429);
    const lead = await this.leads.add({ name, contact, interest: 'otro', detail: `[Formulario del sitio "${project.name}"] ${message}`.trim(), source: `formulario:${slug}` });
    void this.leads.telegram(this.leads.message(lead)).catch(() => undefined);
    return { ok: true };
  }
}
