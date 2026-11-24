import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { SecurityAlertsService } from '../security/security-alerts.service';

export const SOC_COOKIE = 'jano_soc';
export interface SocSession { id: string; user: string; ip: string; createdAt: number; lastSeen: number; }
export interface LoginEvent { at: string; ip: string; user: string; ok: boolean; note: string; }
export type LoginResult = { token: string; session: SocSession } | { error: 'credenciales' } | { error: 'bloqueado'; seconds: number };

const MIN = 60_000, MAX_SESSIONS = 50, MAX_EVENTS = 100;
const sha = (v: string) => createHash('sha256').update(v).digest();
const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Inicio de sesion de la consola SOC (pedido por Camilo el 2026-11-24). No hay registro de usuarios: existe una sola
 * cuenta PROVISIONAL, definida con SOC_USER y SOC_PASSWORD, mientras la consola esta en desarrollo. Sin las dos
 * variables (o con una contraseña de menos de 15 caracteres, directriz APP-01) la consola queda apagada.
 *  - Sesiones del lado del servidor: identificador al azar, en memoria (se guarda solo su huella). Vencen por tiempo
 *    total y por inactividad, y se invalidan al cerrar sesion. Un reinicio del servidor las cierra todas.
 *  - Freno a la fuerza bruta: 5 fallos por direccion bloquean con espera creciente (1, 2, 4... hasta 30 minutos) y hay un
 *    tope global de fallos. Al bloquear una direccion se abre una alerta de seguridad.
 *  - El mensaje de error es el mismo para usuario y para contraseña equivocados.
 * Pendiente al dejar de ser provisional: cuentas personales, contraseñas con Argon2id y segundo factor (APP-02, APP-03).
 */
@Injectable()
export class SocAuthService {
  private readonly log = new Logger(SocAuthService.name);
  private readonly sessions = new Map<string, SocSession>(); // huella del identificador -> sesion
  private readonly fails = new Map<string, { count: number; strikes: number; until: number; last: number }>();
  private recentFails: number[] = [];
  private readonly events: LoginEvent[] = [];
  readonly enabled: boolean;
  /** Por que esta apagada ('' = encendida). */
  readonly problem: string;
  /** Reloj: las pruebas lo cambian para comprobar vencimientos y bloqueos. */
  now: () => number = () => Date.now();

  constructor(private readonly cfg: ConfigService, private readonly alerts: SecurityAlertsService) {
    this.problem = !cfg.socUser || !cfg.socPassword ? 'faltan SOC_USER o SOC_PASSWORD' : cfg.socPassword.length < 15 ? 'SOC_PASSWORD tiene menos de 15 caracteres' : '';
    this.enabled = !this.problem;
    if (this.problem && (cfg.socUser || cfg.socPassword)) this.log.warn(`consola SOC apagada: ${this.problem}`);
  }

  get maxAgeSeconds() { return this.cfg.socSessionHours * 3600; }
  private note(ip: string, user: string, ok: boolean, note: string) {
    this.events.unshift({ at: new Date(this.now()).toISOString(), ip: clean(ip, 45), user: clean(user, 40), ok, note });
    this.events.length = Math.min(this.events.length, MAX_EVENTS);
  }
  private alive(s: SocSession, now: number) { return now - s.createdAt < this.cfg.socSessionHours * 3600_000 && now - s.lastSeen < this.cfg.socIdleMinutes * MIN; }
  private sweep(now: number) { for (const [k, s] of this.sessions) if (!this.alive(s, now)) this.sessions.delete(k); }

  /** Segundos que debe esperar esta direccion antes de volver a intentar (0 = puede intentar). */
  blockedFor(ip: string): number {
    const f = this.fails.get(ip), now = this.now();
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }

  login(user: string, password: string, ip: string): LoginResult {
    const now = this.now();
    if (!this.enabled) return { error: 'credenciales' };
    const wait = this.blockedFor(ip);
    if (wait) return { error: 'bloqueado', seconds: wait };
    // Tope global: aunque cambien de direccion, no mas de 30 fallos cada 15 minutos.
    this.recentFails = this.recentFails.filter((t) => now - t < 15 * MIN);
    if (this.recentFails.length >= 30) return { error: 'bloqueado', seconds: Math.ceil((this.recentFails[0] + 15 * MIN - now) / 1000) };
    // Se comparan las huellas de "usuario + contraseña" juntas y en tiempo constante: no se distingue cual fallo.
    const given = sha(`${String(user ?? '').trim().toLowerCase()}\n${String(password ?? '')}`), want = sha(`${this.cfg.socUser}\n${this.cfg.socPassword}`);
    if (!timingSafeEqual(given, want)) {
      this.recentFails.push(now);
      const f = this.fails.get(ip) ?? { count: 0, strikes: 0, until: 0, last: 0 };
      if (now - f.last > 60 * MIN) { f.count = 0; f.strikes = 0; } // una hora sin fallos: empieza de cero
      f.count++; f.last = now;
      let note = 'credenciales incorrectas';
      if (f.count >= 5) {
        const minutes = Math.min(30, 2 ** f.strikes);
        f.until = now + minutes * MIN; f.count = 0; f.strikes++;
        note = `bloqueada ${minutes} min tras 5 fallos`;
        void this.alerts.open({ source: 'sistema', origin: 'Consola SOC', severity: f.strikes > 2 ? 'alta' : 'media', title: 'Intentos repetidos de inicio de sesión en la consola SOC',
          detail: `La dirección ${clean(ip, 45)} falló 5 veces seguidas y quedó bloqueada ${minutes} minutos.` }).catch(() => undefined);
      }
      this.fails.set(ip, f);
      if (this.fails.size > 5000) this.fails.delete(this.fails.keys().next().value!);
      this.note(ip, user, false, note);
      this.log.warn(`inicio de sesión fallido en la consola SOC desde ${clean(ip, 45)} (${note})`);
      return f.until > now ? { error: 'bloqueado', seconds: Math.ceil((f.until - now) / 1000) } : { error: 'credenciales' };
    }
    this.fails.delete(ip);
    this.sweep(now);
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!); // la mas antigua
    const token = randomBytes(32).toString('base64url');
    const session: SocSession = { id: randomBytes(6).toString('hex'), user: this.cfg.socUser, ip: clean(ip, 45), createdAt: now, lastSeen: now };
    this.sessions.set(sha(token).toString('hex'), session);
    this.note(ip, user, true, 'ingreso');
    this.log.log(`sesión iniciada en la consola SOC desde ${session.ip}`);
    return { token, session };
  }

  private token(cookieHeader: string | undefined): string {
    const m = String(cookieHeader ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SOC_COOKIE}=`));
    return m ? decodeURIComponent(m.slice(SOC_COOKIE.length + 1)) : '';
  }

  /**
   * Valida la sesion de una peticion (cabecera Cookie). `touch` = cuenta como actividad de la persona; las consultas
   * automaticas de la pantalla pasan false, asi una pestaña olvidada vence por inactividad.
   */
  verify(cookieHeader: string | undefined, touch = true): SocSession | null {
    const token = this.token(cookieHeader);
    if (!this.enabled || !token) return null;
    const key = sha(token).toString('hex'), s = this.sessions.get(key), now = this.now();
    if (!s) return null;
    if (!this.alive(s, now)) { this.sessions.delete(key); return null; }
    if (touch) s.lastSeen = now;
    return s;
  }

  logout(cookieHeader: string | undefined): boolean {
    const token = this.token(cookieHeader);
    return !!token && this.sessions.delete(sha(token).toString('hex'));
  }

  /** Cuando vence esta sesion si no hay mas actividad. */
  expiresAt(s: SocSession) { return Math.min(s.createdAt + this.cfg.socSessionHours * 3600_000, s.lastSeen + this.cfg.socIdleMinutes * MIN); }
  active(): SocSession[] { this.sweep(this.now()); return [...this.sessions.values()]; }
  recent(): LoginEvent[] { return this.events.slice(); }
  failedSince(ms: number) { const from = this.now() - ms; return this.events.filter((e) => !e.ok && Date.parse(e.at) >= from).length; }
}
