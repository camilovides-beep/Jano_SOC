import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as QRCode from 'qrcode';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';
import { checkSite, SiteCheck } from './site-check';

export interface Project {
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;        // sesion de Claude Code: se retoma en cada encargo para que recuerde lo hecho
  status: 'libre' | 'trabajando' | 'error';
  lastTask?: string;
  lastSummary?: string;      // informe final del ultimo encargo
  model?: string;            // modelo del ultimo encargo
  unseen?: boolean;          // termino y aun no se le ha contado a Javier
  jobs: number;
  check?: SiteCheck;         // revision automatica del sitio publicado tras el ultimo encargo
  repaired?: boolean;        // el ultimo encargo necesito una correccion automatica
}
/** Modelos de Claude Code que Javier puede elegir por voz (verificados con su suscripcion el 2026-11-17). */
export const MODELS = [
  { key: 'fable', id: 'claude-fable-5-2', label: 'Fable 5.2' },
  { key: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { key: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { key: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
] as const;
/** Lo que se muestra y se cuenta mientras Claude Code trabaja. */
export interface WorkState {
  active: boolean; project?: string; model?: string; activity?: string; spoken?: string;
  steps?: number; agents?: number; agentsTotal?: number; seconds?: number; code?: string[];
}
export interface JobDone { project: Project; ok: boolean; summary: string; seconds: number; site: boolean; check?: SiteCheck; }

/** Nombre de carpeta seguro: minusculas, digitos y guiones. */
export function slugify(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const RULES = (slug: string, formUrl: string) => `
Trabajas para Javier Hermosilla, que te da los encargos hablando con su avatar de voz; no puede ver tu pantalla ni contestarte mientras trabajas.
- Trabaja SOLO dentro de la carpeta actual (el proyecto "${slug}"). No leas ni toques nada fuera de ella.
- Si el resultado se puede ver en un navegador (landing, página, app web sin servidor), deja la versión lista para publicar en la carpeta "sitio/" con un "sitio/index.html". Debe ser estática y funcionar desde una subruta: usa rutas RELATIVAS y no dependas de un servidor propio. Esa carpeta se publica sola.
- Formularios de contacto: envía un POST JSON a ${formUrl} con {proyecto: "${slug}", nombre, contacto, mensaje, autoriza: true}. Incluye una casilla de autorización de tratamiento de datos y no envíes sin ella. Responde {ok: true} si se guardó.
- Si el encargo es grande o tiene partes independientes (varias páginas o módulos, frontend y backend, investigar y luego construir), reparte el trabajo entre varios subagentes en paralelo con la herramienta Agent, y al final integra y verifica tú el resultado. Si es pequeño, hazlo directamente.
- No dejes procesos corriendo (servidores, watchers) al terminar. Si pruebas algo con un servidor, apágalo.
- No inventes datos de Javier, precios ni testimonios; si faltan, usa textos claramente marcados para completar y dilo en el informe.
- Si te falta una decisión importante, toma la opción más razonable y dilo; si de verdad no puedes seguir, pregunta en el informe.
- Comprobar es parte del trabajo: antes de terminar, PRUEBA lo que hiciste. Abre los archivos que escribiste, verifica que cada enlace, imagen, estilo y script local exista con ese nombre exacto, ejecuta lo que se pueda ejecutar (node --check, pruebas, un servidor temporal y curl) y corrige lo que falle. Al terminar, el servidor revisa solo los enlaces y archivos de "sitio/"; si encuentra fallos te los devuelve.
- Termina con un informe BREVE en español, en texto plano sin markdown (se leerá en voz alta): qué hiciste, qué quedó pendiente y, si aplica, la pregunta que necesitas que te respondan. Cierra con dos frases: "Comprobado:" (qué verificaste y cómo) y "Sin comprobar:" (lo que no pudiste verificar). No digas que algo funciona si no lo probaste.`;

/**
 * Taller de programacion del dueño: cada proyecto es una carpeta en DATA_DIR/proyectos y los encargos los ejecuta
 * Claude Code (`claude -p`) con la suscripcion de Javier (CLAUDE_CODE_OAUTH_TOKEN). Solo se usa desde el modo dueño:
 * la documentacion de Claude Code (legal-and-compliance) no permite usar la suscripcion para atender a terceros.
 *
 * Verificado el 2026-11-17 con la documentacion y una ejecucion real (Claude Code 2.1.326):
 *  - `claude -p <texto> --output-format stream-json --verbose`: una linea JSON por evento; `system/init` trae session_id,
 *    `assistant` trae bloques text / tool_use y la ultima linea es `result` {is_error, result, session_id, num_turns}.
 *  - `--resume <session_id>` retoma la conversacion; `--permission-mode acceptEdits` + `--allowedTools`.
 * Aislamiento: en produccion se ejecuta como otro usuario del sistema (TALLER_USER, via sudo) con un entorno que solo
 * lleva el token de Claude Code, para que los comandos que ejecute no puedan leer las claves ni los datos del avatar.
 */
@Injectable()
export class WorkshopService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WorkshopService.name);
  private readonly root: string;
  private readonly file: string;
  private projects: Project[] = [];
  private job?: {
    slug: string; proc: ChildProcess; t0: number; activity: string; spoken: string; steps: number; timer: NodeJS.Timeout; cancelled?: boolean;
    model: string; agents: Set<string>; agentsTotal: number; code: string[];
  };
  private progressListeners: ((w: WorkState) => void)[] = [];
  private lastEmit = 0; private emitTimer?: NodeJS.Timeout;
  private listeners: ((d: JobDone) => void)[] = [];

  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {
    this.root = resolve(cfg.dataDir, 'proyectos');
    this.file = resolve(cfg.dataDir, 'proyectos.json');
    if (!this.enabled) return;
    mkdirSync(this.root, { recursive: true });
    // El usuario del taller debe poder crear archivos aqui; lo demas de DATA_DIR queda solo para el avatar.
    if (cfg.tallerUser) try { chmodSync(this.root, 0o1777); } catch { /* volumen de otro dueño */ }
    try { if (existsSync(this.file)) this.projects = JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { this.log.error(`No se pudo leer ${this.file}: ${(e as Error).message}`); }
    for (const p of this.projects) if (p.status === 'trabajando') { p.status = 'error'; p.lastSummary = 'El servidor se reinició mientras trabajaba; el encargo quedó a medias.'; }
    this.log.log(`taller activo: ${this.projects.length} proyectos${cfg.tallerUser ? `, usuario ${cfg.tallerUser}` : ' (sin usuario separado)'}`);
  }

  /**
   * Con todos los servicios ya creados: los datos del avatar que existian de antes (interesados, dispositivos) dejan de
   * ser legibles para otros usuarios. Los nuevos ya nacen asi por el umask de main.ts.
   */
  onApplicationBootstrap() {
    if (!this.enabled || !this.cfg.tallerUser) return;
    const data = resolve(this.cfg.dataDir);
    try { chmodSync(data, 0o711); } catch { /* volumen de otro dueño */ }
    for (const n of readdirSync(data)) { const f = join(data, n); try { if (statSync(f).isFile()) chmodSync(f, 0o600); } catch { /* no es nuestro */ } }
  }

  get enabled() { return !!this.cfg.claudeToken; }
  onModuleDestroy() { this.job?.proc.kill('SIGTERM'); }
  onDone(fn: (d: JobDone) => void) { this.listeners.push(fn); }
  onProgress(fn: (w: WorkState) => void) { this.progressListeners.push(fn); }

  /** Modelo por defecto (CLAUDE_MODEL) y el que corresponde a lo que pidio Javier ("sonnet", "Opus 5.5", un id completo). */
  get defaultModel() { return MODELS.find((m) => m.id === this.cfg.claudeModel || m.key === this.cfg.claudeModel) ?? { key: '', id: this.cfg.claudeModel, label: this.cfg.claudeModel }; }
  model(name?: string) {
    const n = String(name ?? '').toLowerCase();
    return (n && MODELS.find((m) => n.includes(m.key) || n === m.id)) || this.defaultModel;
  }

  /** Estado del encargo en curso, para la pantalla (actividad, agentes, lineas de codigo) y para la voz. */
  state(): WorkState {
    const j = this.job; if (!j) return { active: false };
    const p = this.projects.find((x) => x.slug === j.slug);
    return {
      active: true, project: p?.name ?? j.slug, model: MODELS.find((m) => m.id === j.model)?.label ?? j.model, activity: j.activity, spoken: j.spoken,
      steps: j.steps, agents: j.agents.size, agentsTotal: j.agentsTotal, seconds: Math.round((Date.now() - j.t0) / 1000), code: j.code.slice(-14),
    };
  }
  /** Avisa el progreso como mucho una vez por segundo. */
  private emit(now = false) {
    clearTimeout(this.emitTimer);
    const wait = now ? 0 : 1000 - (Date.now() - this.lastEmit);
    if (wait > 0) { this.emitTimer = setTimeout(() => this.emit(true), wait); return; }
    this.lastEmit = Date.now();
    const st = this.state();
    for (const fn of this.progressListeners) try { fn(st); } catch { /* un oyente roto no detiene el trabajo */ }
  }

  private save() { try { writeFileSync(this.file, JSON.stringify(this.projects, null, 1), { mode: 0o600 }); } catch (e) { this.log.error(`No se pudo guardar ${this.file}: ${(e as Error).message}`); } }
  list(): Project[] { return [...this.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  dir(slug: string) { return join(this.root, slug); }
  hasSite(slug: string) { return existsSync(join(this.dir(slug), 'sitio', 'index.html')); }
  unseen(): Project[] { return this.projects.filter((p) => p.unseen); }
  markSeen(slug: string) { const p = this.projects.find((x) => x.slug === slug); if (p?.unseen) { p.unseen = false; this.save(); } }

  /** Busca un proyecto por nombre aproximado (lo dicta una persona: "la landing del cafe" -> "landing-cafe"). */
  find(name: string): Project | undefined {
    const s = slugify(name);
    if (!s) return undefined;
    return this.projects.find((p) => p.slug === s)
      ?? this.projects.find((p) => p.slug.includes(s) || s.includes(p.slug))
      ?? this.projects.find((p) => s.split('-').filter((w) => w.length > 2).every((w) => p.slug.includes(w)));
  }

  /** Que esta haciendo ahora, para contarlo en voz. */
  progress(): string {
    if (!this.job) return 'El taller está libre, no hay ningún encargo en curso.';
    const p = this.projects.find((x) => x.slug === this.job!.slug);
    const min = Math.max(1, Math.round((Date.now() - this.job.t0) / 60000));
    const st = this.state();
    return `Trabajando en "${p?.name ?? this.job.slug}" con ${st.model} hace ${min} min (${this.job.steps} pasos${st.agentsTotal ? `, ${st.agentsTotal} subagentes lanzados` : ''}). Ahora: ${this.job.activity}. Encargo: ${p?.lastTask ?? ''}`;
  }
  busy() { return this.job?.slug; }

  cancel(): string {
    if (!this.job) return 'No hay ningún encargo en curso.';
    this.job.cancelled = true;
    this.job.proc.kill('SIGTERM');
    setTimeout(() => this.job?.proc.kill('SIGKILL'), 5000).unref();
    return 'Encargo cancelado. Lo que alcanzó a hacer queda en el proyecto.';
  }

  /**
   * Empieza un encargo y vuelve enseguida; el resultado llega por `onDone`.
   * Devuelve el texto para el modelo (si empezo o por que no).
   */
  start(projectName: string, task: string, formUrl: string, createIfMissing: boolean, modelName?: string, repair = false): string {
    if (!this.enabled) return 'El taller no está configurado (falta CLAUDE_CODE_OAUTH_TOKEN).';
    task = task.trim();
    if (task.length < 8) return 'Falta describir el encargo con más detalle.';
    if (this.job) return `Ya hay un encargo en curso en el proyecto "${this.job.slug}". Hay que esperar a que termine o cancelarlo.`;
    let p = this.find(projectName);
    if (!p) {
      const slug = slugify(projectName);
      if (slug.length < 2) return 'Falta el nombre del proyecto.';
      if (!createIfMissing) return `No existe un proyecto parecido a "${projectName}". Proyectos: ${this.projects.map((x) => x.name).join(', ') || 'ninguno'}. Si es nuevo, vuelve a llamar con nuevo: true.`;
      if (this.projects.length >= this.cfg.tallerMaxProjects) return `Ya hay ${this.projects.length} proyectos, que es el máximo configurado.`;
      const now = new Date().toISOString();
      p = { slug, name: projectName.trim().slice(0, 60), createdAt: now, updatedAt: now, status: 'libre', jobs: 0 };
      this.projects.push(p);
    }
    const project = p;
    const args = ['-p', task, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite,Agent,Task', '--max-turns', String(this.cfg.tallerMaxTurns),
      '--append-system-prompt', RULES(project.slug, formUrl)];
    if (project.sessionId) args.push('--resume', project.sessionId);
    const model = this.model(modelName);
    if (model.id) args.push('--model', model.id);
    // Entorno minimo: nada de las claves del avatar llega a Claude Code ni a los comandos que ejecute.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: 'C.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: this.cfg.claudeToken,
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    };
    let cmd = this.cfg.claudeBin, argv = args;
    const cwd = this.dir(project.slug);
    if (this.cfg.tallerUser) {
      // sudo solo permite ejecutar claude como el usuario del taller (ver Dockerfile); la carpeta del proyecto queda abierta para el.
      argv = ['-n', '-H', '-u', this.cfg.tallerUser, '--preserve-env=PATH,LANG,CLAUDE_CODE_OAUTH_TOKEN,DISABLE_AUTOUPDATER,DISABLE_TELEMETRY,DISABLE_ERROR_REPORTING', this.cfg.claudeBin, ...args];
      cmd = 'sudo';
    } else { env.HOME = process.env.HOME; }
    try { mkdirSync(cwd, { recursive: true, mode: 0o777 }); if (this.cfg.tallerUser) chmodSync(cwd, 0o777); } catch (e) { return `No se pudo crear la carpeta del proyecto: ${(e as Error).message}`; }

    let proc: ChildProcess;
    try { proc = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return `No se pudo iniciar Claude Code: ${(e as Error).message}`; }
    try { if (proc.pid && this.cfg.tallerNice) require('node:os').setPriority(proc.pid, this.cfg.tallerNice); } catch { /* sin permiso para cambiar la prioridad */ }

    const t0 = Date.now();
    const job: NonNullable<WorkshopService['job']> & { timedOut?: boolean } = { slug: project.slug, proc, t0, activity: 'empezando', spoken: 'está empezando', steps: 0, model: model.id, agents: new Set(), agentsTotal: 0, code: [], timer: setTimeout(() => { job.activity = 'tiempo agotado'; job.timedOut = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 5000).unref(); }, this.cfg.tallerMaxMinutes * 60_000) };
    this.job = job;
    project.status = 'trabajando'; project.lastTask = task.slice(0, 500); project.updatedAt = new Date().toISOString(); project.jobs++; project.unseen = false; project.model = model.label;
    this.save();
    this.log.log(`taller: encargo en "${project.slug}" con ${model.label}${project.sessionId ? ' (retoma sesión)' : ''}: ${task.slice(0, 120)}`);
    this.emit(true);

    let pending = '', result: any, stderr = '', lastText = '';
    proc.stdout!.on('data', (d: Buffer) => {
      pending += d.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id && ev.type === 'system') project.sessionId = ev.session_id;
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && b.text?.trim()) lastText = b.text.trim();
            if (b.type === 'tool_use') {
              job.steps++;
              const d = describe(b.name, b.input); job.activity = d.screen; job.spoken = d.spoken;
              if (b.name === 'Agent' || b.name === 'Task') { job.agents.add(b.id); job.agentsTotal++; }
              // Lineas reales de lo que esta escribiendo o ejecutando: se ven reflejadas en las gafas del avatar.
              const src = String(b.input?.content ?? b.input?.new_string ?? b.input?.command ?? b.input?.prompt ?? '');
              for (const l of src.split('\n')) { const t = l.replace(/\s+$/, '').slice(0, 64); if (t.trim()) job.code.push(t); }
              if (job.code.length > 60) job.code.splice(0, job.code.length - 60);
            }
          }
          this.emit();
        }
        if (ev.type === 'user') { // resultado de una herramienta: si era un subagente, ya termino
          for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) if (b.type === 'tool_result' && job.agents.delete(b.tool_use_id)) this.emit();
        }
        if (ev.type === 'result') result = ev;
      }
    });
    proc.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-600); });
    const finish = (code: number | null, err?: Error) => {
      if (this.job !== job) return;
      clearTimeout(job.timer); this.job = undefined; this.emit(true);
      const seconds = Math.round((Date.now() - t0) / 1000);
      // Consumo del encargo. total_cost_usd es el equivalente a precio de API que informa Claude Code; con la suscripcion no se cobra aparte.
      this.usage.add('claude_jobs'); this.usage.add('claude_s', seconds); this.usage.add('claude_turns', Number(result?.num_turns) || 0); this.usage.add('claude_usd', Number(result?.total_cost_usd) || 0);
      if (result?.session_id) project.sessionId = result.session_id;
      let ok = !!result && !result.is_error && code === 0;
      let summary = String(result?.result ?? '').trim() || lastText;
      if (job.cancelled) { ok = false; summary = 'El encargo se canceló antes de terminar.' + (lastText ? ` Lo último que dijo: ${lastText}` : ''); }
      else if (job.timedOut) { ok = false; summary = `Se acabó el tiempo (${this.cfg.tallerMaxMinutes} min) y el encargo quedó a medias.` + (lastText ? ` Lo último que dijo: ${lastText}` : ''); }
      else if (result?.subtype === 'error_max_turns') { ok = false; summary = `Llegó al máximo de pasos y quedó a medias. ${lastText}`; }
      else if (!ok) summary = `Claude Code falló${err ? `: ${err.message}` : ''}. ${summary || stderr.replace(/\s+/g, ' ').slice(-300) || `código ${code}`}`;
      project.status = ok || job.cancelled ? 'libre' : 'error';
      // Prueba antes de "terminado": el servidor revisa el sitio publicado. Si hay fallos, se le devuelven a Claude Code
      // UNA vez (misma sesion) antes de avisarle a Javier; si siguen, el aviso lo dice.
      const check = this.hasSite(project.slug) ? checkSite(join(this.dir(project.slug), 'sitio')) : undefined;
      project.check = check; project.repaired = repair;
      if (check && !check.ok) this.log.warn(`taller: la revisión de "${project.slug}" encontró ${check.issues.length} problemas${repair ? ' (tras la corrección)' : ''}`);
      if (ok && check && !check.ok && !repair && this.cfg.tallerAutoFix) {
        const original = project.lastTask;
        project.lastSummary = summary.slice(0, 4000); this.save();
        this.start(project.name, `La revisión automática del servidor encontró estos problemas en la carpeta sitio/ después de tu último trabajo:\n- ${check.issues.join('\n- ')}\nCorrígelos, vuelve a comprobar cada enlace y archivo, y termina con el informe completo del encargo original (no solo de esta corrección).`, formUrl, false, modelName, true);
        if (this.job) { project.lastTask = original; this.save(); return; } // el aviso a Javier sale cuando termine la correccion
      }
      project.lastSummary = summary.slice(0, 4000); project.updatedAt = new Date().toISOString(); project.unseen = true;
      this.save();
      this.log.log(`taller: "${project.slug}" ${ok ? 'terminó' : 'NO terminó'} en ${seconds} s, ${job.steps} pasos${result?.num_turns ? `, ${result.num_turns} turnos` : ''}`);
      const done: JobDone = { project, ok, summary: project.lastSummary, seconds, site: this.hasSite(project.slug), check };
      for (const fn of this.listeners) try { fn(done); } catch (e) { this.log.error(`aviso del taller: ${(e as Error).message}`); }
    };
    proc.on('error', (e) => finish(null, e));
    proc.on('close', (code) => finish(code));
    return `Encargo iniciado en el proyecto "${project.name}"${project.jobs > 1 ? ' (continúa lo anterior)' : ' (proyecto nuevo)'} con el modelo ${model.label}. Claude Code está trabajando en segundo plano y puede tardar varios minutos. ` +
      'Dile a Javier que ya empezó y que le avisarás cuando termine; mientras tanto puede seguir hablando contigo.';
  }

  /**
   * Ruta real de un archivo publicado (`sitio/`) de un proyecto, o null si no existe o se sale de la carpeta
   * (un enlace simbolico hacia fuera no se sirve: el taller escribe ahi y no debe poder publicar archivos del avatar).
   */
  siteFile(slug: string, rel: string): string | null {
    if (!/^[a-z0-9-]{2,40}$/.test(slug) || !this.projects.some((p) => p.slug === slug)) return null;
    const base = join(this.dir(slug), 'sitio');
    if (rel.split('/').some((part) => part.startsWith('.'))) return null;
    try {
      const realBase = realpathSync(base);
      if (realBase !== resolve(base)) return null;
      let target = realpathSync(resolve(base, rel || '.'));
      if (statSync(target).isDirectory()) target = realpathSync(join(target, 'index.html'));
      if (target !== realBase && !target.startsWith(realBase + sep)) return null;
      return statSync(target).isFile() ? target : null;
    } catch { return null; }
  }

  /** Direccion publica del sitio de un proyecto ('' si no tiene). */
  siteUrl(slug: string, origin: string): string { return this.hasSite(slug) ? `${this.cfg.publicUrl || origin}/p/${slug}/` : ''; }

  /** Tarjeta para la pantalla del avatar: nombre, enlace y codigo QR del sitio publicado. */
  async card(slug: string, origin: string): Promise<{ title: string; lines: string[]; qr: string; caption: string } | null> {
    const p = this.projects.find((x) => x.slug === slug), url = this.siteUrl(slug, origin);
    if (!p || !url) return null;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    return { title: p.name, lines: [url.replace(/^https?:\/\//, '')], qr, caption: 'Escanea para abrirlo' };
  }

  /** Archivos del proyecto (sin dependencias instaladas), para mostrarlos en el panel. */
  files(slug: string, max = 200): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      let names: string[]; try { names = readdirSync(dir).sort(); } catch { return; }
      for (const n of names) {
        if (out.length >= max || n === 'node_modules' || n === '.git') continue;
        const full = join(dir, n);
        let st; try { st = statSync(full, { throwIfNoEntry: false }); } catch { continue; }
        if (!st) continue;
        if (st.isDirectory()) walk(full, rel + n + '/'); else out.push(rel + n);
      }
    };
    walk(this.dir(slug), '');
    return out;
  }
}

/** Describe lo que esta haciendo Claude Code: version para la pantalla y version para decir en voz. */
function describe(tool: string, input: any): { screen: string; spoken: string } {
  const path = String(input?.file_path ?? input?.path ?? ''), file = path.split('/').slice(-2).join('/'), base = path.split('/').pop() ?? '';
  switch (tool) {
    case 'Write': return { screen: `escribiendo ${file}`, spoken: `está escribiendo el archivo ${base}` };
    case 'Edit': return { screen: `editando ${file}`, spoken: `está editando el archivo ${base}` };
    case 'Read': return { screen: `leyendo ${file}`, spoken: `está revisando el archivo ${base}` };
    case 'Bash': return { screen: `$ ${String(input?.command ?? '').replace(/\s+/g, ' ').slice(0, 60)}`, spoken: 'está ejecutando comandos' };
    case 'WebFetch': case 'WebSearch': return { screen: 'consultando en internet', spoken: 'está consultando en internet' };
    case 'TodoWrite': return { screen: 'organizando los pasos', spoken: 'está organizando los pasos' };
    case 'Agent': case 'Task': { const d = String(input?.description ?? 'una parte del trabajo').slice(0, 60); return { screen: `agente: ${d}`, spoken: `acaba de lanzar un agente para ${d}` }; }
    default: return { screen: `usando ${tool}`, spoken: 'sigue trabajando' };
  }
}
