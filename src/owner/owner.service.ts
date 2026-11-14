import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '../config/config.service';

export interface Device { id: string; name: string; createdAt: string; lastSeen: string; }

export const OWNER_COOKIE = 'minijavi_owner';

/**
 * Modo dueño: solo los dispositivos registrados con la clave OWNER_SECRET pueden usar las herramientas privadas.
 * Cada dispositivo recibe un pase firmado (cookie HttpOnly) que el servidor valida contra la lista de dispositivos,
 * asi se puede revocar uno sin cambiar la clave. Si OWNER_SECRET esta vacio, el modo dueño queda desactivado.
 */
@Injectable()
export class OwnerService {
  private readonly log = new Logger(OwnerService.name);
  private readonly file: string;
  private readonly key: Buffer;
  private devices: Device[] = [];
  private readonly fails = new Map<string, { count: number; until: number }>();
  private recent: number[] = [];
  readonly enabled: boolean;

  constructor(private readonly cfg: ConfigService) {
    this.enabled = cfg.ownerSecret.length >= 16;
    if (cfg.ownerSecret && !this.enabled) this.log.warn('OWNER_SECRET tiene menos de 16 caracteres: el modo dueño queda desactivado');
    this.key = createHash('sha256').update(`minijavi-owner:${cfg.ownerSecret}`).digest();
    this.file = join(cfg.dataDir, 'devices.json');
    try { if (existsSync(this.file)) this.devices = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.devices = []; }
  }

  private save() {
    try { mkdirSync(this.cfg.dataDir, { recursive: true }); writeFileSync(this.file, JSON.stringify(this.devices, null, 2)); }
    catch (e) { this.log.error(`No se pudo guardar la lista de dispositivos: ${(e as Error).message}`); }
  }
  private sign(payload: string) { return createHmac('sha256', this.key).update(payload).digest('base64url'); }

  /** Segundos que debe esperar esta IP antes de volver a intentar (0 = puede intentar). */
  blockedFor(ip: string): number {
    const f = this.fails.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  /** Registra un dispositivo si la clave es correcta. Devuelve el pase o null. */
  register(secret: string, name: string, ip: string): { token: string; device: Device } | null {
    if (!this.enabled || this.blockedFor(ip)) return null;
    // Tope global: aunque cambien de direccion, no mas de 20 intentos fallidos cada 15 minutos.
    const now0 = Date.now(); this.recent = this.recent.filter((t) => now0 - t < 15 * 60_000);
    if (this.recent.length >= 20) return null;
    const a = createHash('sha256').update(secret).digest(), b = createHash('sha256').update(this.cfg.ownerSecret).digest();
    if (!timingSafeEqual(a, b)) {
      this.recent.push(Date.now());
      const f = this.fails.get(ip) ?? { count: 0, until: 0 };
      f.count++; if (f.count >= 5) { f.until = Date.now() + 15 * 60_000; f.count = 0; }
      this.fails.set(ip, f);
      this.log.warn(`intento fallido de registro de dispositivo desde ${ip}`);
      return null;
    }
    this.fails.delete(ip);
    const now = new Date().toISOString();
    const device: Device = { id: randomBytes(12).toString('hex'), name: (name || 'Dispositivo').slice(0, 60), createdAt: now, lastSeen: now };
    this.devices.push(device); this.save();
    const exp = Date.now() + this.cfg.ownerDays * 86_400_000;
    const payload = `${device.id}.${exp}`;
    this.log.log(`dispositivo registrado: ${device.name}`);
    return { token: `${payload}.${this.sign(payload)}`, device };
  }

  /** Valida el pase de una peticion (cabecera Cookie). Devuelve el dispositivo o null. */
  verify(cookieHeader: string | undefined): Device | null {
    if (!this.enabled || !cookieHeader) return null;
    const m = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${OWNER_COOKIE}=`));
    if (!m) return null;
    const [id, exp, sig] = decodeURIComponent(m.slice(OWNER_COOKIE.length + 1)).split('.');
    if (!id || !exp || !sig) return null;
    const good = Buffer.from(this.sign(`${id}.${exp}`)), got = Buffer.from(sig);
    if (good.length !== got.length || !timingSafeEqual(good, got) || Number(exp) < Date.now()) return null;
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null; // revocado
    device.lastSeen = new Date().toISOString();
    return device;
  }

  list(): Device[] { return this.devices; }
  revoke(id: string): boolean {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== n) { this.save(); return true; }
    return false;
  }
  get maxAgeSeconds() { return this.cfg.ownerDays * 86_400; }
}
