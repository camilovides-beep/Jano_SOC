// Pagina privada: registra este dispositivo como del dueño y permite revocar otros.
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(new URL(`owner/${path}`, window.location.href), { credentials: 'same-origin', ...opts });
const fecha = (iso) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

async function refresh() {
  const st = await (await api('status')).json();
  if (!st.enabled) { $('msg').textContent = 'El modo dueño está desactivado en el servidor.'; $('form').hidden = true; return; }
  $('devices').hidden = !st.registered;
  if (!st.registered) return;
  $('me').textContent = `Este dispositivo está autorizado como "${st.device}".`;
  const devices = await (await api('devices')).json();
  $('list').replaceChildren(...devices.map((d) => {
    const li = document.createElement('li'), info = document.createElement('div'), btn = document.createElement('button');
    const name = document.createElement('strong'); name.textContent = d.name + (d.current ? ' (este)' : '');
    const meta = document.createElement('small'); meta.textContent = `Registrado ${fecha(d.createdAt)} · último uso ${fecha(d.lastSeen)}`;
    info.append(name, meta);
    btn.type = 'button'; btn.textContent = 'Revocar';
    btn.addEventListener('click', async () => { await api(`devices/${d.id}`, { method: 'DELETE' }); refresh(); });
    li.append(info, btn); return li;
  }));
  loadLeads();
  loadProjects();
}

async function loadLeads() {
  const { statuses, leads } = await (await api('leads')).json();
  $('leads').hidden = false; $('lead-count').textContent = `(${leads.length})`;
  $('lead-list').replaceChildren(...leads.map((l) => {
    const li = document.createElement('li'); li.className = 'lead';
    const head = document.createElement('div'); head.className = 'row';
    const name = document.createElement('strong'); name.textContent = l.name + (l.company ? ` · ${l.company}` : '');
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = l.interest.replaceAll('_', ' ');
    head.append(name, tag);
    const contact = document.createElement('div'); contact.textContent = l.contact;
    const detail = document.createElement('small'); detail.textContent = `${fecha(l.created_at)} — ${l.detail || 'sin detalle'}`;
    const row = document.createElement('div'); row.className = 'row';
    const sel = document.createElement('select');
    for (const s of statuses) { const o = document.createElement('option'); o.value = s; o.textContent = s.replaceAll('_', ' '); o.selected = s === l.status; sel.append(o); }
    const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Borrar';
    const notes = document.createElement('textarea'); notes.placeholder = 'Notas'; notes.value = l.notes;
    const save = (patch) => api(`leads/${l.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    sel.addEventListener('change', () => save({ status: sel.value }));
    notes.addEventListener('change', () => save({ notes: notes.value }));
    del.addEventListener('click', async () => { if (del.dataset.sure) { await api(`leads/${l.id}`, { method: 'DELETE' }); loadLeads(); } else { del.dataset.sure = '1'; del.textContent = '¿Seguro? Toca otra vez'; } });
    row.append(sel, del); li.append(head, contact, detail, row, notes); return li;
  }));
}

// Proyectos del taller (Claude Code): estado, ultimo informe, enlace, QR y descarga.
let projectTimer = null;
async function loadProjects() {
  const res = await api('projects'); if (!res.ok) return;
  const { enabled, busy, progress, projects } = await res.json();
  $('projects').hidden = !enabled; if (!enabled) return;
  $('project-count').textContent = `(${projects.length})`;
  $('project-progress').textContent = progress;
  $('project-list').replaceChildren(...projects.map((p) => {
    const li = document.createElement('li'); li.className = 'lead';
    const head = document.createElement('div'); head.className = 'row';
    const name = document.createElement('strong'); name.textContent = p.name;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = p.status;
    head.append(name, tag);
    const task = document.createElement('small'); task.textContent = `${fecha(p.updatedAt)} — encargo: ${p.lastTask || 'ninguno'}`;
    const sum = document.createElement('div'); sum.textContent = p.lastSummary || 'Sin resultado todavía.'; sum.style.whiteSpace = 'pre-wrap';
    const row = document.createElement('div'); row.className = 'row';
    if (p.url) { const a = document.createElement('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Abrir sitio'; row.append(a); }
    const dl = document.createElement('a'); dl.href = `./owner/projects/${p.slug}/descargar`; dl.textContent = 'Descargar código'; row.append(dl);
    li.append(head, task, sum, row);
    if (p.qr) { const img = document.createElement('img'); img.src = p.qr; img.alt = `Código QR de ${p.name}`; img.width = 160; img.height = 160; li.append(img); }
    const files = document.createElement('details'), fs = document.createElement('summary'), pre = document.createElement('pre');
    fs.textContent = `Archivos (${p.files.length})`; pre.textContent = p.files.join('\n'); files.append(fs, pre); li.append(files);
    return li;
  }));
  clearTimeout(projectTimer); if (busy) projectTimer = setTimeout(loadProjects, 5000); // mientras trabaja, se actualiza solo
}

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault(); $('msg').textContent = '';
  const res = await api('register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: $('secret').value, name: $('name').value }) });
  $('secret').value = '';
  if (res.ok) { $('msg').textContent = ''; refresh(); return; }
  const err = await res.json().catch(() => ({}));
  $('msg').textContent = err.error === 'bloqueado' ? `Demasiados intentos. Espera ${Math.ceil(err.seconds / 60)} minutos.` : 'Clave incorrecta.';
});
refresh();
