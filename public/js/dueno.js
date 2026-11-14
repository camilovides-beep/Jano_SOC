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
