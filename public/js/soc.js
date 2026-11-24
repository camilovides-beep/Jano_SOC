// Consola SOC de Jano: ingreso con la cuenta provisional y monitoreo de alertas, logs, SIEM, integridad y accesos.
// Todo lo que viene del servidor puede traer texto escrito por terceros (titulos de alertas, lineas de log, nombres de
// reglas, usuarios de un intento de ingreso): se pinta SIEMPRE con textContent, nunca como HTML.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => { const n = Object.assign(document.createElement(tag), props); for (const k of [].concat(kids)) if (k != null) n.append(k); return n; };
const svg = (tag, attrs = {}, kids = []) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); for (const k of [].concat(kids)) n.append(k); return n; };
const fill = (node, kids) => { node.replaceChildren(...[].concat(kids).filter((k) => k != null)); return node; };
const SEV = { baja: 'Baja', media: 'Media', alta: 'Alta', critica: 'Crítica' }, SEV_ORDER = ['critica', 'alta', 'media', 'baja'];
const REFRESH_MS = 10_000;
let tz = 'America/Bogota', view = 'resumen', timer = 0, alerts = [], logName = '';

// ---------- formato ----------
const fmt = (opts) => (iso) => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('es-CO', { timeZone: tz, ...opts }).format(d) : '—'; };
const dateTime = fmt({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const timeOnly = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hourMin = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? 'hace un momento' : s < 3600 ? `hace ${Math.round(s / 60)} min` : s < 86400 ? `hace ${Math.round(s / 3600)} h` : `hace ${Math.round(s / 86400)} d`; };
const duration = (min) => (min == null ? '—' : min < 60 ? `${min} min` : min < 1440 ? `${(min / 60).toFixed(1).replace('.', ',')} h` : `${(min / 1440).toFixed(1).replace('.', ',')} d`);
const uptime = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- peticiones ----------
class ApiError extends Error { constructor(status, body) { super(body?.error || `error ${status}`); this.status = status; this.body = body; } }
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`./soc/${path}`, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'jano-soc', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { showLogin('La sesión venció. Vuelve a entrar.'); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
const banner = (text) => { $('banner').textContent = text || ''; $('banner').hidden = !text; };

// ---------- piezas ----------
const sevTag = (s) => el('span', { className: 'sev' }, [el('i', { className: `dot ${s in SEV ? s : ''}` }), SEV[s] ?? String(s)]);
const empty = (text) => el('li', { className: 'empty', textContent: text });
function table(node, heads, rows, none) {
  const head = el('tr', {}, heads.map((h) => el('th', { textContent: h.replace(/^#/, ''), className: h.startsWith('#') ? 'num' : '' })));
  const body = rows.length ? rows.map((cells) => el('tr', {}, cells.map((c) => (c instanceof HTMLTableCellElement ? c : el('td', {}, c))))) : [el('tr', { className: 'empty' }, el('td', { colSpan: heads.length, textContent: none }))];
  fill(node, [el('thead', {}, head), el('tbody', {}, body)]);
}
const td = (text, className = '') => el('td', { textContent: text, className });
function bars(node, items, none) {
  const max = Math.max(1, ...items.map((i) => i.count));
  fill(node, items.length ? items.map((i) => { const b = el('i'); b.style.width = `${(i.count / max) * 100}%`; return el('div', { className: 'bar', title: `${i.name}: ${i.count}` }, [el('span', { textContent: i.name }), el('div', {}, b), el('b', { textContent: String(i.count) })]); }) : el('p', { className: 'muted', textContent: none }));
}
const tile = (value, label, { dot = '', small = '', cls = '', text = false } = {}) => el('div', { className: `tile ${cls}` }, [el('b', { textContent: String(value), className: text ? 'text' : '' }), el('span', {}, [dot ? el('i', { className: `dot ${dot}` }) : null, label]), small ? el('small', { textContent: small }) : null]);
const check = (state, label, detail, word) => el('li', {}, [el('i', { className: `dot ${state}` }), el('span', { textContent: label }), el('em', { textContent: word }), detail ? el('small', { textContent: detail }) : null]);

/** Una alerta en una lista, con su boton para resolverla si sigue abierta. */
function alertItem(a, onDone) {
  const open = a.status === 'abierta';
  const li = el('li', { className: open ? 'open' : '' }, [
    el('div', { className: 'head' }, [sevTag(a.severity), el('span', { className: 'title', textContent: `#${a.id} · ${a.title}` }), a.count > 1 ? el('span', { className: 'tag', textContent: `×${a.count}` }) : null, !open ? el('span', { className: 'tag', textContent: 'Resuelta' }) : null]),
    a.detail ? el('p', { className: 'detail', textContent: a.detail }) : null,
    el('p', { className: 'meta', textContent: [a.sourceLabel, a.origin, `${dateTime(a.created_at)} (${ago(a.created_at)})`, !open ? `resuelta ${dateTime(a.resolved_at)} por ${a.resolved_by}${a.resolution ? `: ${a.resolution}` : ''}` : ''].filter(Boolean).join(' · ') }),
  ]);
  if (open) {
    const note = el('input', { placeholder: 'Nota de cierre (opcional)', maxLength: 600 }), msg = el('span', { className: 'error' });
    const go = el('button', { className: 'small', textContent: 'Marcar resuelta', type: 'button' });
    go.onclick = async () => {
      go.disabled = true; msg.textContent = '';
      try { await api(`alerts/${a.id}/resolve`, { method: 'POST', body: { note: note.value } }); await onDone(); }
      catch (e) { msg.textContent = e.message; go.disabled = false; }
    };
    li.append(el('div', { className: 'row' }, [note, go, msg]));
  }
  return li;
}

// ---------- grafico: alertas nuevas por dia, en dos grupos de gravedad ----------
function chart(node, days) {
  const W = 640, H = 200, L = 28, R = 6, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const rows = days.map((d) => ({ day: d.day, low: d.baja + d.media, high: d.alta + d.critica, d }));
  const peak = Math.max(...rows.map((r) => r.low + r.high)), max = Math.max(4, Math.ceil(peak / 4) * 4), step = pw / rows.length, bw = Math.min(26, step - 8);
  const y = (v) => T + ph - (v / max) * ph, root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Alertas nuevas por día en los últimos 14 días. Total: ${rows.reduce((s, r) => s + r.low + r.high, 0)}.` });
  for (const v of [0, max / 2, max]) root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v ? 'gridline' : 'base' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, String(v)));
  const tip = $('tip');
  rows.forEach((r, i) => {
    const x = L + i * step + (step - bw) / 2, [, m, dd] = r.day.split('-');
    let top = y(0);
    for (const [key, val] of [['low', r.low], ['high', r.high]]) {
      if (!val) continue;
      const h = Math.max(2, (val / max) * ph - 2); top -= h + 2; // 2 px de separacion entre tramos
      root.append(svg('rect', { x, y: top + 2, width: bw, height: h, rx: 3, class: `seg ${key}` }));
    }
    if (i % 2 === 1 || rows.length <= 7) root.append(svg('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' }, `${dd}/${m}`));
    const hit = svg('rect', { x: L + i * step, y: T, width: step, height: ph, class: 'hit' });
    hit.addEventListener('pointermove', (e) => {
      tip.textContent = `${dd}/${m}\nAlta y crítica: ${r.high}\nBaja y media: ${r.low}`;
      tip.style.left = `${e.clientX}px`; tip.style.top = `${e.clientY}px`; tip.hidden = false;
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    root.append(hit);
  });
  if (!peak) root.append(svg('text', { x: L + pw / 2, y: T + ph / 2, 'text-anchor': 'middle', class: 'none' }, 'Sin alertas en estos 14 días'));
  fill(node, root);
}

// ---------- resumen ----------
async function loadOverview(auto = false) {
  const o = await api(`overview${auto ? '?auto=1' : ''}`);
  tz = o.timezone || tz; banner('');
  const a = o.alerts, on = a.active > 0;
  document.body.dataset.state = on ? 'alerta' : 'calma';
  document.title = `${on ? `(${a.active}) ` : ''}Jano SOC · Consola de monitoreo`;
  $('rail-title').textContent = on ? plural(a.active, 'alerta abierta', 'alertas abiertas') : 'En calma';
  $('rail-sub').textContent = on ? `La más grave: ${SEV[a.worst]?.toLowerCase() ?? a.worst}. Jano está en rojo hasta que se resuelvan.` : 'Sin alertas abiertas. Jano está en azul.';
  $('updated').textContent = `Actualizado ${timeOnly(o.now)}`;
  $('who').textContent = o.user; $('expires').textContent = `Sesión hasta las ${hourMin(o.expiresAt)}`;
  $('nav-alerts').textContent = String(a.active); $('nav-alerts').hidden = !on;
  if (view !== 'resumen') return;
  fill($('sev-tiles'), SEV_ORDER.map((s) => tile(a.bySeverity[s] ?? 0, `${SEV[s]} · abiertas`, { dot: s, cls: a.bySeverity[s] ? '' : 'zero' })));
  chart($('chart'), a.days);
  fill($('facts'), [['Alertas en 30 días', a.last30], ['Resueltas', a.resolved30], ['Mediana para resolver', duration(a.medianMinutes)]].map(([k, v]) => el('span', {}, [el('b', { textContent: String(v) }), k])));
  fill($('open-list'), a.open.length ? a.open.map((x) => alertItem(x, () => loadOverview())) : empty('No hay alertas abiertas.'));
  bars($('by-source'), a.bySource.filter((s) => s.count).map((s) => ({ name: s.label, count: s.count })), 'Sin alertas en los últimos 30 días.');
  fill($('channels'), o.channels.map((c) => check(c.on ? 'ok' : 'off', c.label, c.detail, c.on ? 'Encendido' : 'Apagado')));
  fill($('services'), o.services.length ? o.services.map((s) => check(s.ok ? 'ok' : 'fail', s.name, `${s.detail ? `${s.detail} · ` : ''}desde ${dateTime(s.since)}`, s.ok ? 'Funciona' : 'Falla')) : el('li', {}, [el('i', { className: 'dot off' }), el('span', { className: 'muted', textContent: 'La primera comprobación corre a los pocos segundos de arrancar.' })]));
  const i = o.integrity;
  fill($('sys-tiles'), [
    tile(i.ok ? 'Íntegra' : 'Alterada', 'Bitácora encadenada', { text: true, dot: i.ok ? 'ok' : 'fail', cls: i.ok ? '' : 'bad', small: i.ok ? plural(i.rows, 'fila verificada', 'filas verificadas') : `la cadena se rompe en la fila ${i.brokenAt}` }),
    tile(i.approvals, 'Aprobaciones pendientes', { cls: i.approvals ? '' : 'zero' }),
    tile(o.logs.sources, 'Fuentes de logs', { cls: o.logs.sources ? '' : 'zero', small: o.logs.latest ? `última: ${o.logs.latest.name}, ${ago(o.logs.latest.mtime)}` : 'ninguna todavía' }),
    tile(o.access.failed24h, 'Ingresos fallidos (24 h)', { cls: o.access.failed24h ? 'bad' : 'zero', small: `${plural(o.access.sessions, 'sesión activa', 'sesiones activas')} · ${plural(o.access.devices, 'dispositivo', 'dispositivos')} del dueño` }),
    tile(uptime(o.system.uptime), 'En marcha', { text: true, small: `base ${o.system.db} · voz ${o.system.voice}` }),
  ]);
}

// ---------- alertas ----------
async function loadAlerts() { alerts = (await api('alerts')).alerts; drawAlerts(); }
function drawAlerts() {
  const st = $('f-status').value, sv = $('f-severity').value, q = $('f-text').value.trim().toLowerCase();
  const list = alerts.filter((a) => (!st || a.status === st) && (!sv || a.severity === sv) && (!q || `${a.title} ${a.detail} ${a.origin} ${a.sourceLabel} #${a.id}`.toLowerCase().includes(q)));
  $('alerts-count').textContent = `${plural(list.length, 'alerta', 'alertas')} de ${alerts.length}`;
  fill($('alerts-list'), list.length ? list.map((a) => alertItem(a, async () => { await loadAlerts(); await loadOverview(); })) : empty(alerts.length ? 'Ninguna alerta coincide con el filtro.' : 'Todavía no hay alertas.'));
}

// ---------- logs ----------
async function loadLogs() {
  const d = await api('logs');
  $('logs-note').textContent = d.sources.length ? `Se lee el final de cada archivo (${d.maxMb} MB)` : '';
  if (d.dbError) $('logs-note').textContent = `La base de logs no responde: ${d.dbError}`;
  drawWatch(d.watch);
  fill($('log-sources'), d.sources.length ? d.sources.map((s) => {
    const li = el('li', { tabIndex: 0 }, [el('span', { className: 'name', textContent: s.name }), el('span', { className: 'muted', textContent: s.rows === null ? bytes(s.size) : plural(s.rows, 'fila', 'filas') }), el('span', { className: 'meta', textContent: `modificado ${ago(s.mtime)}` })]);
    li.setAttribute('role', 'button'); li.setAttribute('aria-selected', String(s.name === logName));
    const go = () => analyzeLog(s.name);
    li.onclick = go; li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    return li;
  }) : empty(d.enabled ? 'No hay archivos de log todavía. Copia alguno a la carpeta de logs o envíalo por HTTP o syslog.' : 'El análisis de logs está apagado: define LOGS_DIR, LOGS_INGEST_SECRET o LOGS_SYSLOG_PORT.'));
}
function drawWatch(w) {
  $('watch-run').hidden = !w.enabled;
  if (!w.enabled) { $('watch-note').textContent = w.minutes > 0 ? 'Vigilante apagado: no hay de dónde leer logs.' : 'Vigilante apagado (LOGS_WATCH_MINUTES en 0): los logs solo se analizan a pedido.'; return; }
  const p = w.last, head = `Vigilante: revisa cada ${w.minutes} min y abre una alerta desde gravedad ${SEV[w.severity]?.toLowerCase() ?? w.severity}.`;
  $('watch-note').textContent = p ? `${head} Última pasada ${ago(p.at)}: ${plural(p.checked, 'fuente con cambios', 'fuentes con cambios')}, ${plural(p.opened, 'alerta nueva', 'alertas nuevas')}${p.updated ? `, ${plural(p.updated, 'actualizada', 'actualizadas')}` : ''}${p.errors.length ? `. Con problemas: ${p.errors[0]}` : ''}.` : `${head} La primera pasada corre a los 30 segundos de arrancar.`;
}
async function runWatch() {
  const b = $('watch-run'); b.disabled = true; b.textContent = 'Revisando…';
  try { await api('logs/watch', { method: 'POST' }); await loadLogs(); await loadOverview(); }
  catch (e) { if (e.status !== 401) $('watch-note').textContent = `No se pudo revisar: ${e.message}`; }
  finally { b.disabled = false; b.textContent = 'Revisar ahora'; }
}
async function analyzeLog(name) {
  logName = name;
  for (const li of $('log-sources').children) li.setAttribute('aria-selected', String(li.querySelector('.name')?.textContent === name));
  $('log-title').textContent = name; $('log-period').textContent = 'Analizando…'; $('log-empty').hidden = true; $('log-body').hidden = true;
  $('log-hits').textContent = ''; $('log-lines').hidden = true; $('log-q').value = '';
  try {
    const a = await api(`logs/analyze?name=${encodeURIComponent(name)}`);
    if (logName !== name) return;
    $('log-period').textContent = a.period || '';
    const kinds = Object.entries(a.kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} (${n})`).join(', ');
    fill($('log-facts'), [['líneas leídas', a.lines], ['sin reconocer', a.unknown], ['hallazgos', a.findings.length]].map(([k, v]) => el('span', {}, [el('b', { textContent: String(v) }), k])).concat(kinds ? el('span', { textContent: `Tipos: ${kinds}` }) : []));
    fill($('log-findings'), a.findings.length ? a.findings.map((f) => el('li', {}, [el('div', { className: 'head' }, [sevTag(f.severity), el('span', { className: 'title', textContent: f.title }), el('span', { className: 'tag push', textContent: f.rule })]), el('p', { className: 'detail', textContent: f.detail })])) : empty('Sin hallazgos en el tramo leído.'));
    fill($('log-stats'), a.stats.length ? a.stats.map((s) => el('li', { textContent: s })) : el('li', { textContent: 'Sin cifras.' }));
    $('log-body').hidden = false;
  } catch (e) { if (e.status !== 401) { $('log-period').textContent = ''; $('log-empty').textContent = `No se pudo analizar: ${e.message}`; $('log-empty').hidden = false; } }
}
async function searchLog(ev) {
  ev.preventDefault();
  $('log-hits').textContent = 'Buscando…'; $('log-lines').hidden = true;
  try {
    const r = await api(`logs/search?name=${encodeURIComponent(logName)}&q=${encodeURIComponent($('log-q').value)}`);
    $('log-hits').textContent = r.total ? `${plural(r.total, 'línea coincide', 'líneas coinciden')}${r.total > r.lines.length ? `; se muestran las últimas ${r.lines.length}` : ''}. Contraseñas y tokens van ocultos.` : 'Ninguna línea coincide.';
    $('log-lines').textContent = r.lines.join('\n'); $('log-lines').hidden = !r.lines.length;
  } catch (e) { $('log-hits').textContent = e.message; }
}

// ---------- SIEM ----------
async function loadSiem(ev) {
  ev?.preventDefault();
  $('siem-msg').textContent = 'Consultando…'; $('siem-body').hidden = true;
  const d = await api(`siem?hours=${$('siem-hours').value}&q=${encodeURIComponent($('siem-q').value)}`);
  if (!d.enabled) { $('siem-msg').textContent = 'No hay un SIEM conectado. Define SIEM_URL (Wazuh, Elastic Security u OpenSearch) con un usuario de solo lectura para ver aquí sus eventos.'; return; }
  if (d.error) { $('siem-msg').textContent = `El SIEM no respondió: ${d.error}`; return; }
  $('siem-msg').textContent = `${plural(d.total, 'evento', 'eventos')} en el periodo${d.total > d.sampled ? `; se resumen los ${d.sampled} más recientes` : ''}.`;
  fill($('siem-tiles'), SEV_ORDER.map((s) => tile(d.bySeverity[s] ?? 0, SEV[s], { dot: s, cls: d.bySeverity[s] ? '' : 'zero' })));
  table($('siem-rules'), ['Gravedad', 'Regla', '#Veces'], d.rules.map((r) => [sevTag(r.severity), td(r.name, 'wrap'), td(String(r.count), 'num')]), 'Sin eventos con ese filtro.');
  bars($('siem-hosts'), d.hosts, 'Sin datos de equipos.'); bars($('siem-origins'), d.origins, 'Sin datos de origen.');
  $('siem-body').hidden = false;
}

// ---------- integridad ----------
async function loadIntegrity() {
  const d = await api('actions'), c = d.chain;
  fill($('chain-tiles'), [
    tile(c.ok ? 'Íntegra' : 'Alterada', 'Cadena de huellas', { text: true, dot: c.ok ? 'ok' : 'fail', cls: c.ok ? '' : 'bad', small: c.ok ? 'ninguna fila cambiada ni borrada' : `se rompe en la fila ${c.brokenAt}` }),
    tile(c.rows, 'Filas en la bitácora', { cls: c.rows ? '' : 'zero' }),
    tile(d.approvals, 'Aprobaciones pendientes', { cls: d.approvals ? '' : 'zero', small: 'se deciden en el panel del dueño' }),
  ]);
  table($('actions-table'), ['Cuándo', 'Acción', 'Contacto', 'Resultado', 'Motivo'], d.actions.map((r) => [td(dateTime(r.at), 'mono'), td(r.kind), td(r.contact, 'mono'), td(r.simulated ? `${r.status} (simulación)` : r.status), td(r.reason, 'wrap')]), 'Jano no ha intentado ninguna acción por su cuenta en 30 días.');
}

// ---------- accesos ----------
async function loadAccess() {
  const d = await api('access');
  table($('sessions-table'), ['Usuario', 'Dirección', 'Inicio', 'Última actividad', 'Vence'], d.sessions.map((s) => [td(s.current ? `${s.user} (esta)` : s.user), td(s.ip, 'mono'), td(dateTime(s.createdAt), 'mono'), td(ago(s.lastSeen)), td(hourMin(s.expiresAt), 'mono')]), 'Sin sesiones.');
  table($('devices-table'), ['Dispositivo', 'Registrado', 'Último uso'], d.devices.map((x) => [td(x.name, 'wrap'), td(dateTime(x.createdAt), 'mono'), td(ago(x.lastSeen))]), 'No hay dispositivos del dueño registrados.');
  table($('events-table'), ['Cuándo', 'Dirección', 'Usuario escrito', 'Resultado'], d.events.map((e) => [td(dateTime(e.at), 'mono'), td(e.ip, 'mono'), td(e.user, 'wrap'), el('td', {}, el('span', { className: 'sev' }, [el('i', { className: `dot ${e.ok ? 'ok' : 'fail'}` }), e.ok ? 'Ingreso' : e.note]))]), 'Sin intentos registrados.');
}

// ---------- navegacion y ciclo ----------
const loaders = { resumen: () => loadOverview(), alertas: loadAlerts, logs: loadLogs, siem: () => loadSiem(), integridad: loadIntegrity, accesos: loadAccess };
async function go(name) {
  view = name in loaders ? name : 'resumen';
  for (const b of $('nav').children) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  for (const s of document.querySelectorAll('section[data-view]')) s.hidden = s.dataset.view !== view;
  try { history.replaceState(null, '', `#${view}`); } catch { /* sin historial */ }
  await run(loaders[view]);
}
async function run(fn) { try { await fn(); } catch (e) { if (e.status !== 401) banner(e instanceof ApiError ? `No se pudo cargar: ${e.message}` : 'No hay conexión con el servidor de Jano.'); } }
function tick() {
  if ($('app').hidden || document.hidden) return;
  void run(async () => { await loadOverview(true); if (view === 'alertas' && !document.activeElement?.closest('#alerts-list, #alert-form')) await loadAlerts(); });
}
function clock() { $('clock').textContent = timeOnly(new Date().toISOString()); }

function showLogin(message = '') {
  clearInterval(timer); timer = 0;
  $('app').hidden = true; $('login').hidden = false; document.body.dataset.state = 'calma';
  $('login-error').textContent = message; $('password').value = '';
  ($('user').value ? $('password') : $('user')).focus();
}
async function showApp() {
  $('login').hidden = true; $('app').hidden = false;
  clock(); await loadOverview().catch(() => undefined); // primero el estado general (trae la zona horaria)
  await go(location.hash.slice(1) || 'resumen');
  let beats = 0;
  if (!timer) timer = setInterval(() => { clock(); if (++beats % (REFRESH_MS / 1000) === 0) tick(); }, 1000);
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('login-btn'); btn.disabled = true; $('login-error').textContent = '';
  try { await api('login', { method: 'POST', body: { user: $('user').value, password: $('password').value } }); $('password').value = ''; await showApp(); }
  catch (e) {
    $('login-error').textContent = e.status === 429 ? `Demasiados intentos. Espera ${Math.max(1, Math.ceil((e.body?.seconds ?? 60) / 60))} min y vuelve a probar.`
      : e.status === 401 ? 'Usuario o contraseña incorrectos.' : e.status === 404 ? 'La consola está apagada: faltan SOC_USER y SOC_PASSWORD en el servidor.' : 'No hay conexión con el servidor de Jano.';
    $('password').value = ''; $('password').focus();
  } finally { btn.disabled = false; }
});
$('logout').onclick = async () => { await api('logout', { method: 'POST' }).catch(() => undefined); showLogin(); };
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) void go(b.dataset.view); });
document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) void go(b.dataset.go); });
for (const id of ['f-status', 'f-severity', 'f-text']) $(id).addEventListener('input', drawAlerts);
$('alert-new-toggle').onclick = () => { $('alert-form').hidden = !$('alert-form').hidden; if (!$('alert-form').hidden) $('alert-title').focus(); };
$('alert-form').addEventListener('submit', async (ev) => {
  ev.preventDefault(); $('alert-msg').textContent = '';
  try {
    await api('alerts', { method: 'POST', body: { title: $('alert-title').value, detail: $('alert-detail').value, severity: $('alert-severity').value, origin: $('alert-origin').value } });
    ev.target.reset(); $('alert-form').hidden = true; $('f-status').value = 'abierta'; await loadAlerts(); await loadOverview();
  } catch (e) { $('alert-msg').textContent = e.message; }
});
$('log-search').addEventListener('submit', searchLog);
$('watch-run').onclick = runWatch;
$('siem-form').addEventListener('submit', (ev) => void run(() => loadSiem(ev)));
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

// Arranque: si ya hay sesion entra directo; si no, pide usuario y contraseña.
(async () => {
  try {
    const res = await fetch('./soc/session', { credentials: 'same-origin' }), s = await res.json();
    if (s.user) await showApp();
    else showLogin(s.enabled ? '' : 'La consola está apagada: faltan SOC_USER y SOC_PASSWORD en el servidor.');
  } catch { showLogin('No hay conexión con el servidor de Jano.'); }
})();
