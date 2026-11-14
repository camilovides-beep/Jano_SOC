import { Body, Controller, Delete, Get, HttpException, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LeadsService, STATUSES } from '../leads/leads.service';
import { OWNER_COOKIE, OwnerService } from './owner.service';

// Detras del proxy, la ultima direccion de X-Forwarded-For la puso el proxy (las anteriores las puede inventar el cliente).
const ipOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').pop()!.trim();
const isHttps = (req: Request) => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

/** Registro y administracion de los dispositivos del dueño. La pagina es public/owner.html. */
@Controller('owner')
export class OwnerController {
  constructor(private readonly owner: OwnerService, private readonly leads: LeadsService) {}

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

  // ---- interesados (solo desde un dispositivo registrado) ----
  @Get('leads')
  listLeads(@Req() req: Request) { this.require(req); return { statuses: STATUSES, leads: this.leads.list() }; }

  @Get('leads.csv')
  csv(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.require(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="interesados.csv"');
    return '\ufeff' + this.leads.csv();
  }

  @Patch('leads/:id')
  updateLead(@Req() req: Request, @Param('id') id: string, @Body() body: { status?: string; notes?: string }) {
    this.require(req); return { ok: this.leads.update(Number(id), body ?? {}) };
  }

  @Delete('leads/:id')
  removeLead(@Req() req: Request, @Param('id') id: string) { this.require(req); return { ok: this.leads.remove(Number(id)) }; }
}
