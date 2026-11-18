// Panel privado de Javier: registro del dispositivo, cifras, interesados, conversaciones, consumo, taller y dispositivos.
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(new URL(`owner/${path}`, window.location.href), { credentials: 'same-origin', ...opts });
const json = async (path) => { const r = await api(path); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
const fecha = (iso) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
const n = (v) => Math.round(v || 0).toLocaleString('es-CO');
const min = (v) => Math.round((v || 0) / 60);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k !== null && k !== undefined)); return e; };
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const short = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + ' M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace('.0', '') + ' mil' : String(Math.round(v)));

/**
 * Barras por dia (apiladas si hay varias series). Un solo eje; con dos o mas series lleva leyenda; al pasar el cursor
 * muestra el valor de ese dia. labels: fechas AAAA-MM-DD en orden. series: [{name, values}].
 */
function barChart(box, labels, series, unit = '') {
  const W = 640, H = 220, L = 44, R = 8, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const peak = Math.max(...totals, 0);
  box.replaceChildren();
  if (!peak) { box.append(el('p', { className: 'muted', textContent: 'Sin datos todavía.' })); return; }
  // Escala con marcas redondas (1, 2 o 5 por una potencia de 10) y como mucho 5 divisiones.
  const mag = Math.pow(10, Math.floor(Math.log10(peak))), tick = [1, 2, 5, 10].map((m) => m * mag).find((s) => peak / s <= 5), ticks = Math.max(1, Math.ceil(peak / tick)), top = ticks * tick;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((s) => s.name).join(', ') });
  for (let g = 0; g <= ticks; g++) {
    const y = T + ph - (ph * g) / ticks;
    root.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'gridline' }));
    const t = svg('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', class: 'axis' }); t.textContent = short(tick * g); root.append(t);
  }
  const slot = pw / labels.length, bw = Math.max(2, Math.min(26, slot - 2));
  const tip = el('div', { className: 'tip', hidden: true });
  labels.forEach((label, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    let y = T + ph;
    const live = series.map((s, k) => ({ k, v: s.values[i] || 0 })).filter((s) => s.v > 0);
    live.forEach((s, idx) => {
      const h = Math.max(1, (s.v / top) * ph - (idx < live.length - 1 ? 2 : 0)); // 2 px de separacion entre tramos
      y -= h;
      const last = idx === live.length - 1, r = last ? Math.min(4, bw / 2, h) : 0;
      root.append(svg('path', { d: `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + h} Z`, fill: COLORS[s.k] }));
      if (!last) y -= 2;
    });
    const every = Math.ceil(labels.length / 8), lastI = labels.length - 1;
    if (i === lastI || (i % every === 0 && lastI - i >= every)) { // la ultima fecha siempre; las demas, espaciadas y sin encimarse con ella
      const t = svg('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' }); t.textContent = label.slice(8) + '/' + label.slice(5, 7); root.append(t);
    }
    const hit = svg('rect', { x: L + slot * i, y: T, width: slot, height: ph, fill: 'transparent' }); // zona de cursor mas grande que la barra
    hit.addEventListener('pointerenter', () => {
      tip.textContent = `${label.slice(8)}/${label.slice(5, 7)} · ` + (series.length > 1 ? series.map((s) => `${s.name}: ${n(s.values[i])}`).join(' · ') : n(totals[i])) + (unit ? ` ${unit}` : '');
      tip.style.left = `${((L + slot * i + slot / 2) / W) * 100}%`; tip.style.top = `${((T + ph - (totals[i] / top) * ph) / H) * 100}%`; tip.hidden = false;
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    root.append(hit);
  });
  box.append(root, tip);
  if (series.length > 1) box.append(el('div', { className: 'legend' }, ...series.map((s, k) => el('span', {}, el('i', { style: `background:${COLORS[k]}` }), s.name))));
}

/** Barras horizontales para comparar categorias (estado, origen, interes), con el valor escrito al lado. */
function hbars(box, rows, label = (k) => k) {
  const peak = Math.max(...rows.map((r) => r.n), 1);
  box.replaceChildren(...(rows.length ? rows.map((r) => el('div', { className: 'hbar' }, el('span', { textContent: label(r.k) }), el('div', { style: `width:${Math.max(1, (r.n / peak) * 100)}%` }), el('b', { textContent: n(r.n) })))
    : [el('p', { className: 'muted', textContent: 'Sin datos todavía.' })]));
}
const pretty = (k) => String(k).replace(/_/g, ' ').replace(/^formulario:/, 'formulario · ').replace(/^./, (c) => c.toUpperCase());
const SOURCE = (k) => (k === 'sin dato' ? 'Sin dato (anteriores)' : k === 'voz' ? 'Conversación en el sitio' : k === 'llamada' ? 'Llamada de WhatsApp' : pretty(k));

// ---------- pestañas ----------
const loaders = { resumen: loadSummary, interesados: loadLeads, visitas: loadVisits, portafolio: loadCases, conversaciones: loadConversations, consumo: loadUsage, taller: loadProjects, dispositivos: loadDevices };
function show(tab) {
  if (!loaders[tab]) tab = 'resumen';
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== tab;
  try { history.replaceState(null, '', `#${tab}`); } catch { /* sin historial */ }
  loaders[tab]().catch((e) => console.warn('panel:', e.message));
}
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (loaders[t] && document.querySelector(`[data-view="${t}"]`).hidden) show(t); });
$('tabs').addEventListener('click', (ev) => { const t = ev.target.closest('button[data-tab]'); if (t) show(t.dataset.tab); });

async function refresh() {
  const st = await (await api('status')).json();
  if (!st.enabled) { $('register').hidden = false; $('msg').textContent = 'El modo dueño está desactivado en el servidor.'; $('form').hidden = true; return; }
  $('register').hidden = st.registered; $('panel').hidden = !st.registered;
  if (!st.registered) return;
  $('me').textContent = `Este dispositivo está autorizado como "${st.device}".`;
  json('summary').then((s) => { $('db').textContent = s.db === 'postgres' ? 'Base de datos: PostgreSQL' : 'Base de datos: SQLite (falta DATABASE_URL)'; }).catch(() => undefined);
  show(location.hash.slice(1));
}

// ---------- resumen ----------
let summary = null;
async function loadSummary() {
  summary = await json('summary');
  const s = summary.stats, nuevo = s.byStatus.find((r) => r.k === 'nuevo')?.n || 0, last7 = s.days.slice(-7).reduce((a, d) => a + d.leads, 0);
  const tile = (value, label) => el('div', { className: 'tile' }, el('b', { textContent: value }), el('span', { textContent: label }));
  $('tiles').replaceChildren(
    tile(n(s.total), 'Interesados en total'), tile(n(nuevo), 'Sin contactar'), tile(n(summary.pending), 'Esperando hace días'), tile(n(last7), 'Interesados en 7 días'),
    tile(n(s.conversations), 'Conversaciones guardadas, 30 días'), tile(`${n(s.talkSeconds / 60)} min`, 'Tiempo conversado, 30 días'),
    ...(summary.workshop.enabled ? [tile(n(summary.workshop.projects), 'Proyectos del taller')] : []));
  $('features').replaceChildren('Funciones: ', ...Object.entries(summary.features || {}).flatMap(([name, on], i) => [i ? ' · ' : '', el('span', { style: `color:${on ? 'var(--ok)' : 'var(--warn)'}`, textContent: `${on ? '✓' : '✗'} ${name}${on ? '' : ' (falta su clave)'}` })]));
  const sv = Object.entries(summary.services || {});
  $('services').replaceChildren(sv.length ? 'Servicios: ' : 'Servicios: aún sin comprobar (la primera revisión tarda unos segundos).', ...sv.flatMap(([name, st], i) => [i ? ' · ' : '', el('span', { style: `color:${st.ok ? 'var(--ok)' : '#ff8a8a'}`, title: st.detail || '', textContent: `${st.ok ? '✓' : '✗'} ${name}${st.detail && (!st.ok || /saldo/i.test(name)) ? ` (${st.detail})` : ''}` })]),
    summary.alerts ? '' : ' · Los avisos por Telegram están apagados (falta configurarlo).');
  drawFunnel(summary.funnel, summary.reports);
  barChart($('ch-leads'), s.days.map((d) => d.day), [{ name: 'Interesados', values: s.days.map((d) => d.leads) }], 'interesados');
  hbars($('by-status'), s.byStatus, pretty); hbars($('by-source'), s.bySource, SOURCE); hbars($('by-interest'), s.byInterest, pretty);
}

/**
 * Embudo: una barra por paso, todas medidas contra el total de conversaciones (el porcentaje va escrito al lado).
 * Los pasos no son uno dentro de otro (se puede dejar datos sin hacer la demostracion); por eso la segunda tarjeta
 * compara, entre quienes mostraron interes, cuantos dejaron datos con y sin demostracion, y con y sin caso contado.
 */
function drawFunnel(f, reports) {
  const pc = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const bar = (label, value, total, of, color) => el('div', { className: 'hbar', title: `${n(value)} de ${n(total)}` }, el('span', { textContent: label }),
    el('div', { style: `width:${total ? Math.max(1, (value / total) * 100) : 1}%;background:${color}` }), el('b', {}, of ? (total ? `${n(value)} de ${n(total)}` : 'ninguna aún') : n(value), el('small', { className: 'muted', textContent: total ? `${pc(value, total)} %` : '' })));
  if (!f || !f.conversations) {
    $('funnel').replaceChildren(el('p', { className: 'muted', textContent: 'Todavía no hay conversaciones con visitantes registradas (se cuentan desde esta versión).' }));
    $('funnel-note').textContent = ''; $('funnel-split').replaceChildren(el('p', { className: 'muted', textContent: 'Sin datos todavía.' })); return;
  }
  const t = f.conversations;
  $('funnel').replaceChildren(bar('Conversaciones', t, t, false, 'var(--s1)'), bar('Mostraron interés', f.interested, t, false, 'var(--s1)'), bar('Se les ofreció la demostración', f.demoOffered, t, false, 'var(--s1)'),
    bar('Hicieron la demostración', f.demoDone, t, false, 'var(--s1)'), bar('Dejaron sus datos', f.leads, t, false, 'var(--s1)'));
  $('funnel-note').textContent = `Porcentajes sobre las ${n(t)} conversaciones${f.calls ? ` (${n(f.calls)} fueron llamadas de WhatsApp)` : ''}.` + (reports ? '' : ' El análisis está apagado (VISIT_REPORTS=0): "mostraron interés" solo cuenta a quienes hicieron la demostración o dejaron datos.');
  const pair = (title, s, withLabel, withoutLabel) => [el('small', { textContent: title }), bar(withLabel, s.withLeads, s.withN, true, 'var(--s3)'), bar(withoutLabel, s.withoutLeads, s.withoutN, true, 'var(--s4)')];
  $('funnel-split').replaceChildren(...pair('Demostración en vivo', f.demo, 'Con demostración', 'Sin demostración'), ...pair('Caso del portafolio', f.cases, 'Con un caso contado', 'Sin caso'),
    ...(f.interested < 20 ? [el('small', { textContent: `Con ${n(f.interested)} ${f.interested === 1 ? 'conversación' : 'conversaciones'} con interés todavía es pronto para sacar conclusiones.` })] : []));
}

// ---------- visitas ----------
let visits = [];
async function loadVisits() { ({ visits } = await json('visits')); drawVisits(); }
function drawVisits() {
  const all = $('visit-all').checked, rows = visits.filter((v) => all || Number(v.interested));
  $('visit-count').textContent = `(${rows.length}${rows.length !== visits.length ? ` de ${visits.length}` : ''})`;
  const tag = (text, on = true) => (on ? el('span', { className: 'tag', textContent: text }) : null);
  const lines = (label, text) => (text ? el('div', {}, el('small', { textContent: `${label}: ` }), text.split(' | ').join(' · ')) : null);
  $('visit-list').replaceChildren(...(rows.length ? rows.map((v) => {
    const del = el('button', { type: 'button', className: 'small danger', textContent: 'Borrar' });
    del.addEventListener('click', async () => { if (del.dataset.sure) { await api(`visits/${v.id}`, { method: 'DELETE' }); loadVisits(); } else { del.dataset.sure = '1'; del.textContent = '¿Seguro? Toca otra vez'; } });
    return el('li', {},
      el('div', { className: 'row' }, el('strong', { textContent: v.kind === 'llamada' ? 'Llamada de WhatsApp' : 'Conversación en el sitio' }), tag(pretty(v.interest), !!v.interest), tag('Dejó sus datos', !!Number(v.lead)),
        tag(Number(v.demo_done) ? 'Hizo la demostración' : 'Demostración ofrecida', !!Number(v.demo_done) || !!Number(v.demo_offered)), tag('Caso del portafolio', !!Number(v.cases)), tag('Sin interés', !Number(v.interested))),
      el('small', { textContent: `${fecha(v.at)} · ${v.seconds < 90 ? `${v.seconds} s` : `${min(v.seconds)} min`} · ${v.turns} ${v.turns === 1 ? 'intervención' : 'intervenciones'} de la persona` }),
      v.summary ? el('div', { textContent: v.summary }) : el('div', { className: 'muted', textContent: 'Sin resumen.' }), lines('Preguntó', v.asked), lines('Dudas u objeciones', v.objections), el('div', { className: 'row' }, del));
  }) : [el('p', { className: 'muted', textContent: visits.length ? 'Ninguna mostró interés todavía. Marca la casilla para verlas todas.' : 'Todavía no hay visitas registradas.' })]));
}
$('visit-all').addEventListener('change', drawVisits);

// ---------- portafolio ----------
let cases = [], editing = null;
const CASE_FIELDS = { title: 'case-title', sector: 'case-sector', client: 'case-client', problem: 'case-problem', solution: 'case-solution', result: 'case-result', tech: 'case-tech', link: 'case-link' };
/** Reduce la foto a 1600 px de lado mayor y la pasa a JPEG, para que suba rapido y no pese en la pantalla del avatar. */
async function shrink(file) {
  const img = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('no se pudo preparar la foto'))), 'image/jpeg', 0.86));
}
async function sendOk(res) { if (res.ok) return res.json(); const e = await res.json().catch(() => ({})); throw new Error(e.message || `el servidor respondió ${res.status}`); }
function editCase(c) {
  editing = c;
  for (const [k, id] of Object.entries(CASE_FIELDS)) $(id).value = c ? c[k] || '' : '';
  $('case-visible').checked = c ? c.visible : true; $('case-photo').value = ''; $('case-msg').textContent = '';
  $('case-form-title').textContent = c ? `Editar: ${c.title}` : 'Agregar un caso'; $('case-save').textContent = c ? 'Guardar cambios' : 'Guardar caso'; $('case-cancel').hidden = !c;
  if (c) $('case-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function loadCases() {
  ({ cases } = await json('portfolio'));
  $('case-count').textContent = `(${cases.length}${cases.some((c) => !c.visible) ? `, ${cases.filter((c) => !c.visible).length} ocultos` : ''})`;
  const part = (label, text) => (text ? el('div', {}, el('small', { textContent: `${label}: ` }), text) : null);
  $('case-list').replaceChildren(...(cases.length ? cases.map((c) => {
    const edit = el('button', { type: 'button', className: 'small', textContent: 'Editar' }); edit.addEventListener('click', () => editCase(c));
    const hide = el('button', { type: 'button', className: 'small', textContent: c.visible ? 'Ocultar' : 'Mostrar' });
    hide.addEventListener('click', async () => { await api(`portfolio/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: !c.visible }) }); loadCases(); });
    const del = el('button', { type: 'button', className: 'small danger', textContent: 'Borrar' });
    del.addEventListener('click', async () => { if (del.dataset.sure) { await api(`portfolio/${c.id}`, { method: 'DELETE' }); if (editing?.id === c.id) editCase(null); loadCases(); } else { del.dataset.sure = '1'; del.textContent = '¿Seguro? Toca otra vez'; } });
    const noPhoto = !c.image ? null : el('button', { type: 'button', className: 'small', textContent: 'Quitar foto' });
    noPhoto?.addEventListener('click', async () => { await api(`portfolio/${c.id}/image`, { method: 'DELETE' }); loadCases(); });
    const missing = [!c.problem && 'el problema', !c.solution && 'lo que hiciste', !c.result && 'el resultado'].filter(Boolean);
    return el('li', {},
      el('div', { className: 'row' }, el('strong', { textContent: c.title }), c.sector ? el('span', { className: 'tag', textContent: c.sector }) : null, el('span', { className: 'tag', textContent: c.visible ? 'El avatar lo cuenta' : 'Oculto' })),
      el('small', { textContent: `${c.client ? `Cliente: ${c.client}` : 'Cliente sin nombrar'} · actualizado ${fecha(c.updated_at)}` }),
      part('Problema', c.problem), part('Lo que hiciste', c.solution), part('Resultado', c.result), part('Tecnologías', c.tech),
      c.link ? el('a', { href: c.link, target: '_blank', rel: 'noopener', textContent: c.link }) : null,
      missing.length ? el('span', { style: 'color:var(--warn);font-size:14px', textContent: `Le falta ${missing.join(' y ')}: el avatar lo contará incompleto.` }) : null,
      c.image ? el('img', { className: 'case-photo', src: c.image, alt: `Foto de ${c.title}`, loading: 'lazy' }) : null,
      el('div', { className: 'row' }, edit, hide, noPhoto, del));
  }) : [el('p', { className: 'muted', textContent: 'Todavía no hay casos. Con tres o cuatro el avatar ya puede mostrar lo que haces en vez de solo describirlo.' })]));
}
$('case-cancel').addEventListener('click', () => editCase(null));
$('case-form').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const msg = $('case-msg'); msg.textContent = ''; $('case-save').disabled = true;
  try {
    const body = { visible: $('case-visible').checked }; for (const [k, id] of Object.entries(CASE_FIELDS)) body[k] = $(id).value;
    const saved = await sendOk(await api(editing ? `portfolio/${editing.id}` : 'portfolio', { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    const file = $('case-photo').files[0];
    let photo = '';
    if (file) try { await sendOk(await api(`portfolio/${saved.id}/image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: await shrink(file) })); }
      catch (e) { photo = /decod/i.test(e.message) ? 'el archivo no es una imagen que el navegador pueda abrir' : e.message; }
    editCase(null); await loadCases();
    if (photo) msg.textContent = `El caso se guardó, pero la foto no: ${photo}. Puedes subirla de nuevo con Editar.`;
  } catch (e) { msg.textContent = `No se guardó: ${e.message}`; }
  $('case-save').disabled = false;
});

// ---------- interesados ----------
let leads = [], statuses = [];
async function loadLeads() {
  ({ statuses, leads } = await json('leads'));
  const fill = (sel, values, label) => { const keep = sel.value; sel.replaceChildren(sel.firstElementChild, ...values.map((v) => el('option', { value: v, textContent: label(v) }))); sel.value = keep; };
  fill($('lead-status'), statuses, pretty); fill($('lead-source'), [...new Set(leads.map((l) => l.source || 'sin dato'))], SOURCE);
  drawLeads();
}
function drawLeads() {
  const q = $('lead-q').value.trim().toLowerCase(), st = $('lead-status').value, src = $('lead-source').value;
  const rows = leads.filter((l) => (!st || l.status === st) && (!src || (l.source || 'sin dato') === src) && (!q || `${l.name} ${l.contact} ${l.company} ${l.detail} ${l.notes}`.toLowerCase().includes(q)));
  $('lead-count').textContent = `(${rows.length}${rows.length !== leads.length ? ` de ${leads.length}` : ''})`;
  $('lead-list').replaceChildren(...(rows.length ? rows.map((l) => {
    const save = (patch) => api(`leads/${l.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const sel = el('select', {}, ...statuses.map((s) => el('option', { value: s, textContent: pretty(s), selected: s === l.status })));
    sel.addEventListener('change', async () => { await save({ status: sel.value }); l.status = sel.value; });
    const notes = el('textarea', { placeholder: 'Notas', value: l.notes || '' });
    notes.addEventListener('change', async () => { await save({ notes: notes.value }); l.notes = notes.value; });
    const del = el('button', { type: 'button', className: 'small danger', textContent: 'Borrar' });
    del.addEventListener('click', async () => { if (del.dataset.sure) { await api(`leads/${l.id}`, { method: 'DELETE' }); loadLeads(); } else { del.dataset.sure = '1'; del.textContent = '¿Seguro? Toca otra vez'; } });
    return el('li', {},
      el('div', { className: 'row' }, el('strong', { textContent: l.name + (l.company ? ` — ${l.company}` : '') }), el('span', { className: 'tag', textContent: pretty(l.interest) }), el('span', { className: 'tag', textContent: SOURCE(l.source || 'sin dato') })),
      el('small', { textContent: `${l.contact} · ${fecha(l.created_at)} · #${l.id}` }),
      l.status === 'nuevo' && Date.now() - Date.parse(l.created_at) > 2 * 86400000 ? el('span', { style: 'color:var(--warn);font-size:14px', textContent: `Sin contactar hace ${Math.floor((Date.now() - Date.parse(l.created_at)) / 86400000)} días` }) : null,
      l.detail ? el('div', { textContent: l.detail }) : null, el('div', { className: 'row' }, sel, del), notes);
  }) : [el('p', { className: 'muted', textContent: leads.length ? 'Ninguno coincide con el filtro.' : 'Todavía no hay interesados.' })]));
}
for (const id of ['lead-q', 'lead-status', 'lead-source']) $(id).addEventListener('input', drawLeads);

// ---------- conversaciones ----------
async function loadConversations() {
  const { conversations } = await json('conversations');
  $('conv-count').textContent = `(${conversations.length})`;
  $('conv-note').textContent = 'Llamadas de WhatsApp que atendió el avatar. Las conversaciones del sitio solo se guardan si activas SAVE_CONVERSATIONS=1.';
  $('conv-list').replaceChildren(...(conversations.length ? conversations.map((c) => {
    const body = el('pre', { hidden: true }), open = el('button', { type: 'button', className: 'small', textContent: 'Ver transcripción' });
    open.addEventListener('click', async () => {
      if (!body.textContent) body.textContent = (await json(`conversations/${c.id}`)).transcript || '(sin texto reconocido)';
      body.hidden = !body.hidden; open.textContent = body.hidden ? 'Ver transcripción' : 'Ocultar';
    });
    const del = el('button', { type: 'button', className: 'small danger', textContent: 'Borrar' });
    del.addEventListener('click', async () => { if (del.dataset.sure) { await api(`conversations/${c.id}`, { method: 'DELETE' }); loadConversations(); } else { del.dataset.sure = '1'; del.textContent = '¿Seguro? Toca otra vez'; } });
    return el('li', {},
      el('div', { className: 'row' }, el('strong', { textContent: c.who || 'Sin nombre' }), el('span', { className: 'tag', textContent: c.kind === 'llamada' ? 'Llamada de WhatsApp' : 'Sitio' })),
      el('small', { textContent: `${fecha(c.at)} · ${c.seconds < 90 ? `${c.seconds} s` : `${min(c.seconds)} min`} · ${c.turns} ${c.turns === 1 ? 'intervención' : 'intervenciones'} de la persona` }),
      el('div', { className: 'row' }, open, del), body);
  }) : [el('p', { className: 'muted', textContent: 'Todavía no hay conversaciones guardadas.' })]));
}

// ---------- consumo ----------
async function loadUsage() {
  const { days } = await json('usage');
  const asc = [...days].reverse(), labels = asc.map((d) => d.day), col = (f) => asc.map(f);
  barChart($('ch-listen'), labels, [{ name: 'Conversando', values: col((d) => Math.max(0, (d.deepgram_s || 0) - (d.deepgram_susp_s || 0)) / 60) }, { name: 'Suspendido', values: col((d) => (d.deepgram_susp_s || 0) / 60) }], 'min');
  barChart($('ch-tokens'), labels, [{ name: 'Desde caché', values: col((d) => d.deepseek_cache || 0) }, { name: 'Sin caché', values: col((d) => Math.max(0, (d.deepseek_in || 0) - (d.deepseek_cache || 0))) }], 'tokens');
  barChart($('ch-voice'), labels, [{ name: 'Caracteres de voz', values: col((d) => d.eleven_chars || 0) }], 'caracteres');
  barChart($('ch-claude'), labels, [{ name: 'Minutos de Claude Code', values: col((d) => (d.claude_s || 0) / 60) }], 'min');
  const cols = [
    ['Día', (d) => d.day], ['Conversaciones', (d) => n(d.sesiones)], ['Escucha (min)', (d) => min(d.deepgram_s)], ['Suspendido (min)', (d) => min(d.deepgram_susp_s)],
    ['Modelo: llamadas', (d) => n((d.deepseek_calls || 0) + (d.deepseek_sin_dato || 0))], ['Tokens leídos', (d) => n(d.deepseek_in)],
    ['En caché', (d) => (d.deepseek_in ? Math.round(((d.deepseek_cache || 0) / d.deepseek_in) * 100) + ' %' : '')], ['Tokens escritos', (d) => n(d.deepseek_out)],
    ['Voz (caracteres)', (d) => n(d.eleven_chars)], ['YouTube', (d) => n(d.youtube_searches)],
    ['Claude Code', (d) => (d.claude_jobs ? `${n(d.claude_jobs)} · ${min(d.claude_s)} min · ${(d.claude_usd || 0).toFixed(2)} USD equiv.` : '')],
    ['Estimado (USD)', (d) => (d.estimado_usd === undefined ? '' : d.estimado_usd.toFixed(2))],
  ];
  const row = (cells, tag) => el('tr', {}, ...cells.map((c) => el(tag, { textContent: c })));
  $('usage-table').replaceChildren(row(cols.map((c) => c[0]), 'th'), ...(days.length ? days.map((d) => row(cols.map((c) => c[1](d)), 'td')) : [row(['Sin datos todavía'], 'td')]));
}

// ---------- taller ----------
let projectTimer = null;
async function loadProjects() {
  const { enabled, busy, progress, projects } = await json('projects');
  $('project-count').textContent = `(${projects.length})`;
  $('project-progress').textContent = !enabled ? 'El taller no está configurado en el servidor.' : busy ? progress : 'Sin encargos en curso.';
  $('project-list').replaceChildren(...projects.map((p) => {
    const sum = el('pre', { textContent: p.lastSummary || 'Sin resultado todavía.' });
    const chk = !p.check ? null : el('div', { style: `color:${p.check.ok ? 'var(--ok)' : 'var(--warn)'};white-space:pre-wrap`, textContent: p.check.ok
      ? `✓ Sitio revisado: ${p.check.pages} páginas, ${p.check.files} archivos, sin enlaces rotos${p.repaired ? ' (tras una corrección automática)' : ''}`
      : `⚠ La revisión encontró ${p.check.issues.length} problemas:\n- ${p.check.issues.join('\n- ')}` });
    const links = el('div', { className: 'row' }, p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener', textContent: 'Abrir sitio' }) : null, el('a', { href: `./owner/projects/${p.slug}/descargar`, textContent: 'Descargar código' }));
    const files = el('details', {}, el('summary', { textContent: `Archivos (${p.files.length})` }), el('pre', { textContent: p.files.join('\n') }));
    return el('li', {}, el('div', { className: 'row' }, el('strong', { textContent: p.name }), el('span', { className: 'tag', textContent: p.status })),
      el('small', { textContent: `${fecha(p.updatedAt)} · ${p.jobs} ${p.jobs === 1 ? 'encargo' : 'encargos'} · último: ${p.lastTask || 'ninguno'}` }), sum, chk, links,
      p.qr ? el('img', { src: p.qr, alt: `Código QR de ${p.name}`, width: 160, height: 160 }) : null, files);
  }));
  const { jobs } = await json('jobs');
  const row = (cells, tag) => el('tr', {}, ...cells.map((c) => el(tag, { textContent: c })));
  $('jobs-table').replaceChildren(row(['Fecha', 'Proyecto', 'Modelo', 'Duración', 'Pasos', 'USD equiv.', 'Resultado', 'Revisión'], 'th'), ...(jobs.length ? jobs.map((j) => row([
    fecha(j.at), j.slug + (Number(j.repair) ? ' (corrección)' : ''), j.model, j.seconds < 90 ? `${j.seconds} s` : `${min(j.seconds)} min`, n(j.turns), Number(j.usd).toFixed(2),
    Number(j.ok) ? 'Terminó' : 'No terminó', j.issues === null ? 'Sin sitio' : Number(j.issues) ? `${j.issues} fallos` : 'Sin fallos'], 'td')) : [row(['Aún no hay encargos registrados (se guardan desde esta versión).'], 'td')]));
  clearTimeout(projectTimer); if (busy && !document.querySelector('[data-view="taller"]').hidden) projectTimer = setTimeout(loadProjects, 5000); // mientras trabaja, se actualiza solo
}

// ---------- dispositivos ----------
async function loadDevices() {
  const devices = await json('devices');
  $('list').replaceChildren(...devices.map((d) => {
    const btn = el('button', { type: 'button', className: 'small danger', textContent: 'Revocar' });
    btn.addEventListener('click', async () => { await api(`devices/${d.id}`, { method: 'DELETE' }); refresh(); });
    return el('li', {}, el('div', { className: 'row between' }, el('div', {}, el('strong', { textContent: d.name + (d.current ? ' (este)' : '') }), el('small', { style: 'display:block', textContent: `Registrado ${fecha(d.createdAt)} · último uso ${fecha(d.lastSeen)}` })), btn));
  }));
}

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault(); $('msg').textContent = '';
  const res = await api('register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: $('secret').value, name: $('name').value }) });
  $('secret').value = '';
  if (res.ok) { refresh(); return; }
  const err = await res.json().catch(() => ({}));
  $('msg').textContent = err.error === 'bloqueado' ? `Demasiados intentos. Espera ${Math.ceil(err.seconds / 60)} minutos.` : 'Clave incorrecta.';
});
refresh();
