/**
 * Analisis de logs de aplicaciones y de red (pedido por Camilo el 2026-11-19). Funciones puras, sin dependencias.
 * Cada linea se reconoce por su forma y alimenta contadores; al final las reglas convierten esos contadores en hallazgos.
 *  - Aplicaciones: acceso web (nginx/apache, formato combinado), JSON por linea (pino, winston, etc.), texto con niveles,
 *    autenticacion del sistema (sshd, sudo, PAM).
 *  - Red: cortafuegos (UFW/iptables), tcpdump en texto (mejor con -nn), alertas de Suricata (eve.json).
 *  - SIEM: alertas de Wazuh en JSON (alerts.json o lo que envie su integracion).
 * Un JSON que llega dentro de una linea de syslog ("... suricata: {...}") se lee igual.
 * Todo lo que sale de aqui viene de texto que pudo escribir un atacante (rutas, usuarios, agentes): se limpia y se
 * recorta, y quien lo entregue al modelo debe envolverlo como datos de terceros.
 */
export type Sev = 'baja' | 'media' | 'alta' | 'critica';
export type Kind = 'web' | 'auth' | 'firewall' | 'tcpdump' | 'suricata' | 'siem' | 'app';
export const KIND_LABEL: Record<Kind, string> = { web: 'acceso web', auth: 'autenticación del sistema', firewall: 'cortafuegos', tcpdump: 'captura de red (tcpdump)', suricata: 'alertas de Suricata', siem: 'alertas de SIEM (Wazuh)', app: 'registro de aplicación' };
export interface Finding { rule: string; severity: Sev; title: string; detail: string; }
export interface Analysis { lines: number; kinds: Partial<Record<Kind, number>>; unknown: number; period: string; findings: Finding[]; stats: string[]; }

const RANK: Record<Sev, number> = { baja: 0, media: 1, alta: 2, critica: 3 };
const inc = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => { let s = m.get(k); if (!s) m.set(k, (s = new Set())); s.add(v); };
const top = <K>(m: Map<K, number>, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const sum = (m: Map<unknown, number>) => [...m.values()].reduce((a, b) => a + b, 0);
/** Deja solo caracteres imprimibles y sin las marcas que usa el modelo para separar datos; recorta. */
export const safe = (v: unknown, n = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^(?=.*:)[0-9a-f:.]{3,45}$/i;
const ip = (v: unknown) => { const s = String(v ?? '').replace(/^\[|\]$/g, ''); return IP_RE.test(s) ? s : ''; };
const list = (m: Map<string, number>, n = 3) => top(m, n).map(([k, c]) => `${k} (${c})`).join(', ');

// ---------- Secretos: nunca deben llegar al modelo ni quedar en un hallazgo ----------
const SECRET_KV = /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|session(?:[_-]?id)?|client[_-]secret|clave|contrase(?:ñ|n)a)(["']?\s*[:=]\s*["']?)(?!\[oculto\])([^\s"'&,;]{3,})/gi;
const SECRET_OTHER: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [oculto]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[jwt oculto]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[clave oculta]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[llave privada oculta]'],
];
const luhn = (d: string) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = Number(d[i]); if (alt && (n *= 2) > 9) n -= 9; s += n; alt = !alt; } return s % 10 === 0; };
/** Tapa contraseñas, tokens, cookies, llaves y numeros de tarjeta de una linea antes de mostrarla. */
export function redact(line: string): string {
  let out = line;
  for (const [re, to] of SECRET_OTHER) out = out.replace(re, to);
  out = out.replace(SECRET_KV, '$1$2[oculto]');
  // Solo 15 o 16 digitos: los de 13 y 19 suelen ser marcas de tiempo.
  return out.replace(/\b\d(?:[ -]?\d){14,15}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[número oculto]' : m));
}
const hasSecret = (line: string) => redact(line) !== line;

// ---------- Firmas de ataques web (sobre la ruta ya decodificada y en minusculas) ----------
/** `expuesto`: si el servidor respondio 2xx, el archivo quedo a la vista (critica). */
const WEB_SIGS: { rule: string; label: string; re: RegExp; expuesto?: boolean }[] = [
  { rule: 'sqli', label: 'inyección SQL', re: /union(\s|\+|\/\*.*?\*\/)+(all(\s|\+)+)?select|information_schema|sleep\(\d|benchmark\(|waitfor\s+delay|'\s*(or|and)\s+['\d]|\bor\s+1\s*=\s*1|;\s*drop\s+table|xp_cmdshell/ },
  { rule: 'traversal', label: 'salto de directorios o lectura de archivos del sistema', re: /\.\.[\/\\]|\/etc\/(passwd|shadow)|\/proc\/self|c:[\/\\]windows|php:\/\/(filter|input)|file:\/\// },
  { rule: 'cmdi', label: 'inyección de comandos', re: /(?:[;|`]|&&)\s*(?:cat|ls|id|whoami|uname|wget|curl|nc|bash|sh|powershell)(?:\s|$)|\$\((?:cat|id|whoami|curl|wget)|\/bin\/(?:ba)?sh|cmd\.exe/ },
  { rule: 'log4shell', label: 'Log4Shell (JNDI)', re: /\$\{\s*(jndi|\$\{)|\$\{(lower|upper|env):/ },
  { rule: 'xss', label: 'cross-site scripting', re: /<script|javascript:|onerror\s*=|onload\s*=|<svg[^>]*on\w+\s*=|<img[^>]*on\w+\s*=/ },
  { rule: 'archivos', label: 'lectura de archivos sensibles (claves, repositorio, respaldos)', expuesto: true, re: /\/\.(env|git|aws|ssh|htpasswd|svn)\b|\/(wp-config\.php|config\.ya?ml|backup\.(zip|sql|tar)|dump\.sql|id_rsa|web\.config|phpinfo\.php)/ },
  { rule: 'sondeo', label: 'búsqueda de paneles y servicios conocidos', re: /\/(wp-login\.php|xmlrpc\.php|phpmyadmin|pma|adminer|actuator|server-status|cgi-bin\/|vendor\/phpunit|solr\/admin|manager\/html|owa\/auth)/ },
];
const SCANNERS = /sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|dirbuster|gobuster|ffuf|feroxbuster|hydra|acunetix|nessus|openvas|burp|whatweb|zmeu|metasploit|l9explore|censys|shodan/i;
const LOGIN_PATH = /\/(login|signin|sign-in|auth|session|sessions|token|oauth|wp-login\.php|ingresar|acceso|owner\/login)\b/i;
const SENSITIVE_PORTS: Record<number, string> = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 445: 'SMB', 1433: 'SQL Server', 3306: 'MySQL', 3389: 'Escritorio remoto', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 9200: 'Elasticsearch', 27017: 'MongoDB' };
const PLAIN_PORTS: Record<number, string> = { 21: 'FTP', 23: 'Telnet', 110: 'POP3', 143: 'IMAP' };
const PORT_NAMES: Record<string, number> = { ssh: 22, telnet: 23, ftp: 21, http: 80, https: 443, domain: 53, smtp: 25, pop3: 110, imap2: 143, 'microsoft-ds': 445, mysql: 3306, postgresql: 5432 };
const AUTH_FAIL = /login failed|authentication fail|invalid (password|credentials|token)|unauthorized|access denied|credenciales inv|acceso denegado|no autorizado/i;
const decode = (s: string) => { let out = s; for (let i = 0; i < 2; i++) try { out = decodeURIComponent(out.replace(/\+/g, ' ')); } catch { break; } return out.toLowerCase(); };

const ACCESS_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?/;
const FW_RE = /SRC=(\S+) DST=(\S+).*?PROTO=(\w+)(?:.*?SPT=(\d+) DPT=(\d+))?/;
const TCPDUMP_RE = /^(?:\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d\.\d+ (?:\S+ +(?:In|Out|[BMPO]) +)?(?:IP6?|ARP)[ ,]+(.*)$/;
const TIME_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?|\d{1,2}\/[A-Z][a-z]{2}\/\d{4}:\d\d:\d\d:\d\d|[A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d|^\d\d:\d\d:\d\d(?=\.\d)/;

/** Separa "10.0.0.5.443" (tcpdump) en direccion y puerto. Sin -nn el puerto puede venir con nombre. */
function endpoint(s: string): { host: string; port: number } {
  const v4 = /^((?:\d{1,3}\.){3}\d{1,3})(?:\.([\w-]+))?$/.exec(s);
  if (v4) return { host: v4[1], port: v4[2] ? (Number(v4[2]) || PORT_NAMES[v4[2]] || 0) : 0 };
  const i = s.lastIndexOf('.'), tail = i > 0 ? s.slice(i + 1) : '';
  if (s.includes(':') && i > 0) return { host: s.slice(0, i), port: Number(tail) || PORT_NAMES[tail] || 0 };
  return i > 0 && (/^\d+$/.test(tail) || PORT_NAMES[tail]) ? { host: s.slice(0, i), port: Number(tail) || PORT_NAMES[tail] } : { host: s, port: 0 };
}

/** Analiza las lineas de un log y devuelve los hallazgos ordenados de mas a menos grave. */
export function analyze(lines: string[]): Analysis {
  const kinds: Partial<Record<Kind, number>> = {}, findings: Finding[] = [], stats: string[] = [];
  const seen = (k: Kind) => { kinds[k] = (kinds[k] ?? 0) + 1; };
  let unknown = 0, first = '', last = '', secrets = 0;
  // Web
  const web = { total: 0, ips: new Map<string, number>(), s5: 0, notFound: new Map<string, number>(), loginFail: new Map<string, number>(), loginOkAfter: new Map<string, number>(), scanners: new Map<string, number>(), scannerNames: new Set<string>(),
    sigs: new Map<string, { n: number; ok: number; ips: Map<string, number>; sample: string }>() };
  // Autenticacion del sistema
  const auth = { fail: new Map<string, number>(), invalid: new Map<string, number>(), users: new Map<string, number>(), okAfter: new Map<string, string>(), ok: new Map<string, number>(), rootPass: new Map<string, number>(), sudo: 0 };
  // Cortafuegos
  const fw = { blocked: new Map<string, number>(), ports: new Map<string, Set<number>>(), hosts: new Map<string, Set<string>>(), dports: new Map<number, number>(), allowed: 0 };
  // tcpdump
  const net = { packets: 0, talkers: new Map<string, number>(), synPorts: new Map<string, Set<number>>(), synHosts: new Map<string, Set<string>>(), synTo: new Map<string, number>(), synSrcs: new Map<string, Set<string>>(), synAck: new Map<string, number>(),
    plain: new Map<string, number>(), dnsLong: new Map<string, number>(), dnsOdd: new Map<string, number>(), icmp: new Map<string, number>(), arp: new Map<string, Set<string>>() };
  // Suricata y aplicacion
  const ids = { sigs: new Map<string, number>(), worst: 3, srcs: new Map<string, number>() };
  const wz = { rules: new Map<string, number>(), worst: 0, where: new Map<string, number>(), low: 0 };
  const app = { errors: 0, fatal: 0, msgs: new Map<string, number>(), authFail: new Map<string, number>(), authFailTotal: 0 };

  const webHit = (addr: string, method: string, rawPath: string, status: number, agent: string) => {
    seen('web'); web.total++;
    const a = ip(addr) || 'desconocida', path = decode(rawPath), probe = `${path} ${decode(agent)}`;
    inc(web.ips, a);
    if (status >= 500) web.s5++;
    if (status === 404) inc(web.notFound, a);
    const scanner = SCANNERS.exec(agent);
    if (scanner) { inc(web.scanners, a); web.scannerNames.add(scanner[0].toLowerCase()); }
    for (const sig of WEB_SIGS) {
      if (!sig.re.test(sig.rule === 'log4shell' ? probe : path)) continue;
      let s = web.sigs.get(sig.rule); if (!s) web.sigs.set(sig.rule, (s = { n: 0, ok: 0, ips: new Map(), sample: '' }));
      s.n++; inc(s.ips, a); if (status >= 200 && status < 300) s.ok++; s.sample ||= safe(rawPath, 90);
    }
    if (LOGIN_PATH.test(path) && method !== 'GET') {
      if (status === 401 || status === 403 || status === 429) inc(web.loginFail, a);
      else if (status < 400 && (web.loginFail.get(a) ?? 0) >= 10) inc(web.loginOkAfter, a);
    }
  };
  const appEvent = (level: string, msg: string, addr = '') => {
    seen('app');
    const lv = level.toLowerCase(), fatal = /^(fatal|crit|emerg|alert|panic)/.test(lv);
    if (fatal) app.fatal++;
    if (fatal || /^(err|severe)/.test(lv)) { app.errors++; inc(app.msgs, safe(redact(msg).replace(/\d+/g, 'N'), 70) || '(sin mensaje)'); }
    if (AUTH_FAIL.test(msg)) { app.authFailTotal++; inc(app.authFail, ip(addr) || ip(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(msg)?.[0]) || 'origen no registrado'); }
  };

  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    const t = TIME_RE.exec(line)?.[0]; if (t) { first ||= t; last = t; }
    if (hasSecret(line)) secrets++;
    let m: RegExpExecArray | null;
    const at = line[0] === '{' ? 0 : line.endsWith('}') ? line.indexOf('{"') : -1; // JSON suelto o dentro de una linea de syslog
    if (at >= 0) {
      let j: any; try { j = JSON.parse(line.slice(at)); } catch { j = undefined; }
      if (j && typeof j === 'object') {
        if (typeof j.timestamp === 'string' || typeof j.time === 'string') { const ts = safe(j.timestamp ?? j.time, 19); first ||= ts; last = ts; }
        if (j.rule && typeof j.rule === 'object' && j.rule.level !== undefined) { // alerta de Wazuh
          seen('siem');
          const lv = Number(j.rule.level) || 0;
          if (lv < 7) { wz.low++; continue; }
          inc(wz.rules, safe(j.rule.description, 90) || 'regla sin nombre'); wz.worst = Math.max(wz.worst, lv); inc(wz.where, ip(j.data?.srcip) || safe(j.agent?.name, 40) || 'origen no registrado');
          continue;
        }
        if (j.event_type) { // Suricata eve.json
          seen('suricata');
          if (j.event_type === 'alert' && j.alert) { inc(ids.sigs, safe(j.alert.signature, 90) || 'firma sin nombre'); ids.worst = Math.min(ids.worst, Number(j.alert.severity) || 3); inc(ids.srcs, ip(j.src_ip) || 'desconocida'); }
          continue;
        }
        const status = Number(j.status ?? j.statusCode ?? j.res?.statusCode ?? j.response?.status), path = j.path ?? j.url ?? j.req?.url ?? j.request?.url ?? j.uri;
        const addr = j.ip ?? j.remote_addr ?? j.client_ip ?? j.remoteAddress ?? j.req?.remoteAddress ?? j.clientIp ?? j.src_ip ?? '';
        if (status >= 100 && typeof path === 'string') webHit(String(addr), String(j.method ?? j.req?.method ?? 'GET'), path, status, String(j.user_agent ?? j.userAgent ?? j.req?.headers?.['user-agent'] ?? ''));
        const lvl = j.level ?? j.severity ?? j.lvl ?? j.levelname ?? '', level = typeof lvl === 'number' ? (lvl >= 60 ? 'fatal' : lvl >= 50 ? 'error' : 'info') : String(lvl);
        appEvent(level, String(j.msg ?? j.message ?? j.error ?? j.err?.message ?? ''), String(addr));
        continue;
      }
    }
    if ((m = ACCESS_RE.exec(line))) { const [method, path = ''] = m[3].split(' '); webHit(m[1], path ? method : '?', path || m[3], Number(m[4]), m[5] ?? ''); continue; }
    if ((m = FW_RE.exec(line))) {
      seen('firewall');
      const src = ip(m[1]) || 'desconocida', dport = Number(m[5]) || 0;
      if (/ALLOW|ACCEPT/.test(line) && !/BLOCK|DROP|REJECT|DENY/.test(line)) { fw.allowed++; continue; }
      inc(fw.blocked, src); add(fw.hosts, `${src}|${dport}`, m[2]);
      if (dport) { add(fw.ports, src, dport); inc(fw.dports, dport); }
      continue;
    }
    if (/\bsshd\b|\bsudo\b|pam_unix/.test(line)) {
      seen('auth');
      const user = (u: string) => safe(u.replace(/[^\w.@-]/g, '?'), 32);
      if ((m = /(?:Failed \w+|maximum authentication attempts exceeded) for (?:invalid user )?(\S+) from (\S+)/.exec(line))) { inc(auth.fail, ip(m[2]) || 'desconocida'); inc(auth.users, user(m[1])); }
      // "Invalid user" suele venir junto a un "Failed password" del mismo intento: se cuenta aparte y al final se toma el mayor.
      else if ((m = /Invalid user (\S+) from (\S+)/.exec(line))) inc(auth.invalid, ip(m[2]) || 'desconocida');
      else if ((m = /Accepted (\S+) for (\S+) from (\S+)/.exec(line))) {
        const a = ip(m[3]) || 'desconocida', u = user(m[2]);
        inc(auth.ok, `${u} desde ${a}`);
        if (Math.max(auth.fail.get(a) ?? 0, auth.invalid.get(a) ?? 0) >= 5) auth.okAfter.set(a, u);
        if (u === 'root' && m[1] === 'password') inc(auth.rootPass, a);
      } else if (!/sshd|sudo/.test(line) && (m = /authentication failure.*rhost=(\S+)/.exec(line))) inc(auth.fail, ip(m[1]) || 'desconocida');
      else if (/sudo.*(authentication failure|incorrect password)/.test(line)) auth.sudo++;
      continue;
    }
    if ((m = TCPDUMP_RE.exec(line))) {
      seen('tcpdump'); net.packets++;
      const body = m[1];
      let a: RegExpExecArray | null;
      if ((a = /^Reply (\S+) is-at ([0-9a-f:]{17})/i.exec(body))) { add(net.arp, a[1], a[2].toLowerCase()); continue; }
      if (!(a = /^(\S+) > (\S+): (.*)$/.exec(body))) continue;
      const src = endpoint(a[1]), dst = endpoint(a[2].replace(/:$/, '')), rest = a[3];
      inc(net.talkers, src.host);
      const flags = /^Flags \[([^\]]*)\]/.exec(rest)?.[1];
      if (flags === 'S') { add(net.synPorts, `${src.host}>${dst.host}`, dst.port); add(net.synHosts, `${src.host}|${dst.port}`, dst.host); inc(net.synTo, `${dst.host}:${dst.port}`); add(net.synSrcs, `${dst.host}:${dst.port}`, src.host); }
      else if (flags === 'S.') inc(net.synAck, `${src.host}:${src.port}`);
      // Solo cuenta si el paquete lleva datos: un SYN suelto al puerto 23 es un escaneo, no una sesion de Telnet.
      if (Number(/length (\d+)/.exec(rest)?.[1]) > 0) for (const p of [src.port, dst.port]) if (PLAIN_PORTS[p]) { inc(net.plain, PLAIN_PORTS[p]); break; }
      if (/ICMP6?,? echo request/.test(rest)) inc(net.icmp, src.host);
      const q = /\b(A|AAAA|TXT|NULL|ANY|MX|CNAME)\? (\S+?)\.? /.exec(rest);
      if (q) { const name = q[2]; if (name.length > 60 || name.split('.').some((l) => l.length > 40)) inc(net.dnsLong, src.host); if (q[1] === 'TXT' || q[1] === 'NULL' || q[1] === 'ANY') inc(net.dnsOdd, src.host); }
      continue;
    }
    if ((m = /\b(FATAL|CRITICAL|ERROR|SEVERE|Exception|Traceback)\b/.exec(line))) { appEvent(/Exception|Traceback/.test(m[1]) ? 'error' : m[1], line.slice(line.indexOf(m[1]) + m[1].length).replace(/^[\s:\]-]+/, '')); continue; }
    if (AUTH_FAIL.test(line)) { appEvent('warn', line); continue; }
    if (/\b(INFO|DEBUG|WARN|WARNING|NOTICE|TRACE)\b/.test(line)) { seen('app'); continue; }
    unknown++;
  }

  const push = (rule: string, severity: Sev, title: string, detail: string) => findings.push({ rule, severity, title: safe(title, 140), detail: safe(detail, 400) });

  // ---------- Reglas: acceso web ----------
  if (web.total) {
    stats.push(`Web: ${web.total} peticiones de ${web.ips.size} direcciones; las que más piden: ${list(web.ips)}.`);
    for (const sig of WEB_SIGS) {
      const s = web.sigs.get(sig.rule); if (!s) continue;
      const exposed = !!sig.expuesto && s.ok > 0, probing = sig.rule === 'sondeo';
      push(`web_${sig.rule}`, exposed ? 'critica' : s.ok > 0 && !probing ? 'alta' : 'media',
        `${s.n} ${s.n === 1 ? 'intento' : 'intentos'} de ${sig.label}${s.ok ? `; ${s.ok} con respuesta exitosa` : ''}`,
        `Origen: ${list(s.ips)}. Ejemplo de ruta: ${s.sample}. ${exposed ? 'El servidor respondió con éxito a un archivo sensible: revisar si quedó expuesto y rotar las claves que contenga.' : s.ok ? (probing ? 'Algunas rutas existen y respondieron: si no deben ser públicas, restringirlas por dirección.' : 'Hubo respuestas 2xx: revisar si el ataque funcionó.') : 'El servidor no respondió con éxito; bloquear el origen y confirmar que la aplicación valida esas entradas.'}`);
    }
    const brute = [...web.loginFail.entries()].filter(([, n]) => n >= 10);
    if (brute.length) {
      const got = [...web.loginOkAfter.keys()];
      push('web_fuerza_bruta', got.length ? 'alta' : 'media', `Fuerza bruta contra el inicio de sesión web desde ${brute.length} ${brute.length === 1 ? 'dirección' : 'direcciones'}`,
        `Intentos rechazados: ${list(new Map(brute))}. ${got.length ? `Después de los fallos hubo ingresos aceptados desde ${got.slice(0, 3).join(', ')}: revisar esas cuentas y cerrar sus sesiones.` : 'Ninguno entró después. Limitar intentos por dirección y exigir verificación en dos pasos.'}`);
    }
    const enumr = [...web.notFound.entries()].filter(([, n]) => n >= 40);
    if (enumr.length) push('web_exploracion', 'media', `Exploración de rutas: ${enumr.length} ${enumr.length === 1 ? 'dirección acumula' : 'direcciones acumulan'} muchos errores 404`, `Principales: ${list(new Map(enumr))}. Es alguien buscando rutas ocultas; conviene bloquearlo o limitarle la velocidad.`);
    if (web.scanners.size) push('web_escaner', 'media', `Herramientas de escaneo detectadas (${[...web.scannerNames].slice(0, 5).join(', ')})`, `${sum(web.scanners)} peticiones desde ${list(web.scanners)}.`);
    if (web.s5 >= 20 && web.s5 / web.total >= 0.05) push('web_errores', 'media', `${web.s5} errores 5xx del servidor (${Math.round((web.s5 / web.total) * 100)} por ciento de las peticiones)`, 'Puede ser una caída, una sobrecarga o un intento de explotación que rompe la aplicación: revisar el registro de errores de esa misma hora.');
  }

  // ---------- Reglas: autenticacion del sistema ----------
  if (kinds.auth) {
    for (const [a, n] of auth.invalid) if (n > (auth.fail.get(a) ?? 0)) auth.fail.set(a, n);
    const brute = [...auth.fail.entries()].filter(([, n]) => n >= 5), total = sum(auth.fail);
    if (auth.ok.size) stats.push(`Ingresos aceptados por SSH: ${list(auth.ok, 4)}.`);
    for (const [a, user] of [...auth.okAfter.entries()].slice(0, 3))
      push('ssh_acceso_tras_fallos', 'critica', `Ingreso aceptado por SSH después de ${auth.fail.get(a)} intentos fallidos desde ${a}`, `Usuario: ${user}. Puede ser una contraseña adivinada: cerrar esa sesión, cambiar la contraseña, revisar llaves autorizadas y qué se ejecutó.`);
    if (brute.length) push('ssh_fuerza_bruta', brute.some(([, n]) => n >= 50) || total >= 300 ? 'alta' : 'media', `Fuerza bruta por SSH: ${total} intentos fallidos desde ${auth.fail.size} ${auth.fail.size === 1 ? 'dirección' : 'direcciones'}`,
      `Principales: ${list(new Map(brute))}. Usuarios más probados: ${list(auth.users, 5)}. Recomendado: solo llaves, sin ingreso de root, y fail2ban o límite en el cortafuegos.`);
    if (auth.rootPass.size) push('ssh_root_clave', 'alta', 'Ingreso de root por SSH con contraseña', `Desde ${list(auth.rootPass)}. Conviene desactivar el ingreso de root y el uso de contraseñas (PermitRootLogin no, PasswordAuthentication no).`);
    if (auth.sudo >= 3) push('sudo_fallos', 'media', `${auth.sudo} intentos fallidos de sudo`, 'Alguien con sesión en el equipo está probando la contraseña de administrador: confirmar quién fue.');
  }

  // ---------- Reglas: cortafuegos ----------
  if (kinds.firewall) {
    stats.push(`Cortafuegos: ${sum(fw.blocked)} conexiones bloqueadas de ${fw.blocked.size} orígenes${fw.allowed ? ` y ${fw.allowed} permitidas` : ''}; puertos más golpeados: ${top(fw.dports, 4).map(([p, c]) => `${p}${SENSITIVE_PORTS[p] ? ` ${SENSITIVE_PORTS[p]}` : ''} (${c})`).join(', ') || 'ninguno'}.`);
    const scans = new Map([...fw.ports.entries()].filter(([, s]) => s.size >= 15).map(([k, s]) => [k, s.size]));
    if (scans.size) push('fw_escaneo_puertos', top(scans, 1)[0][1] >= 100 ? 'alta' : 'media', `Escaneo de puertos bloqueado desde ${scans.size} ${scans.size === 1 ? 'origen' : 'orígenes'}`, `Puertos distintos probados por origen: ${list(scans)}. El cortafuegos los frenó; verificar que no haya servicios expuestos de más.`);
    const sweeps = new Map([...fw.hosts.entries()].filter(([, s]) => s.size >= 10).map(([k, s]) => [k.replace('|', ' al puerto '), s.size]));
    if (sweeps.size) push('fw_barrido', 'media', `Barrido de equipos: un mismo origen probó el mismo puerto en muchos equipos`, `Equipos probados: ${list(sweeps)}.`);
    const hot = top(new Map([...fw.dports.entries()].filter(([p, c]) => SENSITIVE_PORTS[p] && c >= 20)), 4);
    if (hot.length) push('fw_puertos_sensibles', 'baja', `Intentos repetidos contra servicios sensibles (${hot.map(([p]) => SENSITIVE_PORTS[p]).join(', ')})`, `Bloqueados: ${hot.map(([p, c]) => `${SENSITIVE_PORTS[p]} ${c}`).join(', ')}. Es ruido habitual de internet, pero confirma que esos servicios no estén publicados.`);
  }

  // ---------- Reglas: captura de red ----------
  if (net.packets) {
    stats.push(`Captura: ${net.packets} paquetes; equipos que más envían: ${list(net.talkers)}.`);
    const scans = new Map([...net.synPorts.entries()].filter(([, s]) => s.size >= 15).map(([k, s]) => [k.replace('>', ' hacia '), s.size]));
    if (scans.size) push('red_escaneo_puertos', top(scans, 1)[0][1] >= 100 ? 'alta' : 'media', `Escaneo de puertos (SYN) en la red`, `Puertos distintos probados: ${list(scans)}. Si el origen es interno, ese equipo puede estar comprometido o alguien está haciendo reconocimiento.`);
    const sweeps = new Map([...net.synHosts.entries()].filter(([, s]) => s.size >= 10).map(([k, s]) => [k.replace('|', ' al puerto '), s.size]));
    if (sweeps.size) push('red_barrido', 'media', 'Barrido de equipos en la red por un mismo puerto', `Equipos probados: ${list(sweeps)}.`);
    const floods = [...net.synTo.entries()].filter(([k, n]) => n >= 300 && n >= 10 * (net.synAck.get(k) ?? 0));
    if (floods.length) push('red_inundacion_syn', 'alta', `Posible inundación SYN contra ${floods[0][0]}`, `${floods[0][1]} intentos de conexión sin completar desde ${net.synSrcs.get(floods[0][0])?.size ?? 0} orígenes. Activar SYN cookies y limitar conexiones nuevas por origen.`);
    const arp = [...net.arp.entries()].filter(([, s]) => s.size > 1);
    if (arp.length) push('red_arp', 'alta', `Posible suplantación ARP: ${arp.length === 1 ? 'una dirección responde' : `${arp.length} direcciones responden`} con varias MAC`, `${arp.slice(0, 3).map(([a, s]) => `${safe(a, 40)}: ${[...s].slice(0, 3).join(' y ')}`).join('; ')}. Puede ser alguien interceptando el tráfico (hombre en el medio); revisar ese equipo y el switch.`);
    if (net.dnsLong.size && sum(net.dnsLong) >= 5) push('red_dns_tunel', 'media', 'Consultas DNS con nombres anormalmente largos', `Desde ${list(net.dnsLong)}. Puede ser un túnel DNS para sacar datos; revisar qué programa las hace.`);
    if (sum(net.dnsOdd) >= 50) push('red_dns_raro', 'baja', 'Muchas consultas DNS de tipo TXT, NULL o ANY', `Desde ${list(net.dnsOdd)}.`);
    const pings = new Map([...net.icmp.entries()].filter(([, n]) => n >= 200));
    if (pings.size) push('red_icmp', 'media', 'Ráfaga de ping (ICMP) desde un mismo origen', `Peticiones: ${list(pings)}.`);
    if (net.plain.size) push('red_sin_cifrar', 'media', `Protocolos sin cifrar en uso (${[...net.plain.keys()].join(', ')})`, `Paquetes: ${list(net.plain, 4)}. Las contraseñas viajan en claro: reemplazar por SSH, SFTP o las versiones con TLS.`);
  }

  // ---------- Reglas: Suricata y aplicacion ----------
  if (ids.sigs.size) push('ids_alertas', ids.worst <= 1 ? 'alta' : ids.worst === 2 ? 'media' : 'baja', `Alertas del detector de intrusos: ${sum(ids.sigs)} (firmas distintas: ${ids.sigs.size})`, `Firmas: ${list(ids.sigs)}. Orígenes: ${list(ids.srcs)}.`);
  if (wz.rules.size) push('siem_alertas', wz.worst >= 13 ? 'critica' : wz.worst >= 10 ? 'alta' : 'media', `Alertas del SIEM de nivel 7 o más: ${sum(wz.rules)} (nivel máximo ${wz.worst})`, `Reglas: ${list(wz.rules)}. Equipos u orígenes: ${list(wz.where)}.${wz.low ? ` Además hay ${wz.low} de nivel bajo.` : ''}`);
  if (app.errors) push('app_errores', app.fatal || app.errors >= 20 ? 'media' : 'baja', `Errores de aplicación: ${app.errors}${app.fatal ? `, de ellos fatales: ${app.fatal}` : ''}`, `Los más repetidos: ${list(app.msgs)}.`);
  const appBrute = new Map([...app.authFail.entries()].filter(([, n]) => n >= 10));
  if (appBrute.size) push('app_fallos_acceso', 'media', `${app.authFailTotal} fallos de autenticación en la aplicación`, `Concentrados en: ${list(appBrute)}. Puede ser fuerza bruta o relleno de credenciales.`);
  if (secrets) push('secretos_en_logs', 'alta', `${secrets} ${secrets === 1 ? 'línea contiene' : 'líneas contienen'} contraseñas, tokens o llaves`, 'Los registros no deben guardar secretos: quien lea el archivo los obtiene. Corregir lo que escribe la aplicación y rotar esas credenciales.');

  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { lines: lines.length, kinds, unknown, period: first && last ? `${first} a ${last}` : '', findings, stats };
}

/** Texto para el modelo: lo mas grave primero. */
export function describe(name: string, a: Analysis, max = 8): string {
  const kinds = (Object.keys(a.kinds) as Kind[]).sort((x, y) => (a.kinds[y] ?? 0) - (a.kinds[x] ?? 0)).map((k) => `${KIND_LABEL[k]} (${a.kinds[k]})`).join(', ');
  const head = `Análisis de "${name}": ${a.lines} líneas${a.period ? `, de ${a.period}` : ''}. Tipo reconocido: ${kinds || 'ninguno'}${a.unknown ? `; ${a.unknown} líneas sin reconocer` : ''}.`;
  if (!kinds) return `${head} No reconocí el formato: sirve acceso web de nginx o apache, auth.log, UFW o iptables, tcpdump (texto o .pcap), eve.json de Suricata, alertas de Wazuh o registros de aplicación con niveles.`;
  const body = a.findings.length ? `Hallazgos (${a.findings.length}), del más grave al menos grave:\n` + a.findings.slice(0, max).map((f) => `- [${f.severity}] ${f.title}. ${f.detail}`).join('\n') : 'Sin hallazgos de seguridad con las reglas actuales.';
  return [head, ...a.stats, body].join('\n');
}
