import { Body, Controller, Delete, Get, HttpException, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LeadsService, STATUSES } from '../leads/leads.service';
import { OWNER_COOKIE, OwnerService } from './owner.service';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import * as QRCode from 'qrcode';
import { WorkshopService } from '../workshop/workshop.service';
import { UsageService } from '../usage/usage.service';

// Detras del proxy, la ultima direccion de X-Forwarded-For la puso el proxy (las anteriores las puede inventar el cliente).
const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const isHttps = (req: Request) => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

/** Registro y administracion de los dispositivos del dueño. La pagina es public/owner.html. */
@Controller('owner')
export class OwnerController {
  constructor(private readonly owner: OwnerService, private readonly leads: LeadsService, private readonly workshop: WorkshopService, private readonly usage: UsageService) {}

  private cookie(req: Request, value: string, maxAge: number) {
    return `${OWNER_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }
  private require(req: Request) {
    const device = this.owner.verify(req.headers.cookie);
    if (!device) throw new HttpException({ error: 'no_autorizado' }, 401);
    return device;
  }

  @Get('status')
  status(@Req() req: Request) {
    const device = this.owner.verify(req.headers.cookie);
    return { enabled: this.owner.enabled, registered: !!device, device: device?.name ?? null };
  }

  @Post('register')
  register(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { secret?: string; name?: string }) {
    const ip = ipOf(req);
    if (!this.owner.enabled) throw new HttpException({ error: 'desactivado' }, 404);
    const wait = this.owner.blockedFor(ip);
    if (wait) throw new HttpException({ error: 'bloqueado', seconds: wait }, 429);
    const out = this.owner.register(String(body?.secret ?? ''), String(body?.name ?? ''), ip);
    if (!out) throw new HttpException({ error: 'clave' }, 401);
    res.setHeader('Set-Cookie', this.cookie(req, out.token, this.owner.maxAgeSeconds));
    return { ok: true, device: out.device.name };
  }

  @Get('devices')
  devices(@Req() req: Request) {
    const me = this.require(req);
    return this.owner.list().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, current: d.id === me.id }));
  }

  @Delete('devices/:id')
  revoke(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    const me = this.require(req);
    const ok = this.owner.revoke(id);
    if (ok && id === me.id) res.setHeader('Set-Cookie', this.cookie(req, '', 0));
    return { ok };
  }

  // ---- consumo por dia de cada proveedor ----
  @Get('usage')
  async usageDays(@Req() req: Request) { this.require(req); return { days: await this.usage.days(30) }; }

  // ---- interesados (solo desde un dispositivo registrado) ----
  @Get('leads')
  async listLeads(@Req() req: Request) { this.require(req); return { statuses: STATUSES, leads: await this.leads.list() }; }

  @Get('leads.csv')
  async csv(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.require(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="interesados.csv"');
    return '\ufeff' + (await this.leads.csv());
  }

  @Patch('leads/:id')
  async updateLead(@Req() req: Request, @Param('id') id: string, @Body() body: { status?: string; notes?: string }) {
    this.require(req); return { ok: await this.leads.update(Number(id), body ?? {}) };
  }

  @Delete('leads/:id')
  async removeLead(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: await this.leads.remove(Number(id)) }; }

  // ---- taller de programacion (solo desde un dispositivo registrado) ----
  @Get('projects')
  async projects(@Req() req: Request) {
    this.require(req);
    const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
    const projects = await Promise.all(this.workshop.list().map(async (p) => {
      const url = this.workshop.siteUrl(p.slug, origin);
      return {
        slug: p.slug, name: p.name, status: p.status, updatedAt: p.updatedAt, jobs: p.jobs, lastTask: p.lastTask ?? '', lastSummary: p.lastSummary ?? '', check: p.check ?? null, repaired: !!p.repaired,
        url, qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 240 }) : '', files: this.workshop.files(p.slug, 60),
      };
    }));
    return { enabled: this.workshop.enabled, busy: this.workshop.busy() ?? null, progress: this.workshop.progress(), projects };
  }

  /** Descarga el proyecto como .tar.gz (sin node_modules ni .git). tar no sigue enlaces simbolicos. */
  @Get('projects/:slug/descargar')
  download(@Req() req: Request, @Param('slug') slug: string, @Res() res: Response) {
    this.require(req);
    if (!this.workshop.list().some((p) => p.slug === slug)) throw new HttpException({ error: 'no_existe' }, 404);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.tar.gz"`);
    const tar = spawn('tar', ['-czf', '-', '--exclude=node_modules', '--exclude=.git', '-C', dirname(this.workshop.dir(slug)), slug], { stdio: ['ignore', 'pipe', 'ignore'] });
    tar.stdout.pipe(res);
    tar.on('error', () => res.destroy());
    res.on('close', () => tar.kill());
  }
}
