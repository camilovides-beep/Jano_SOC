import { createAvatar } from './avatar.js';
import { SpeechPlayer, base64ToBytes } from './audio.js';
import { LipSync, VISEMES } from './lipsync.js';
import { startMic } from './mic.js';
import { connect } from './socket.js';
import { createBackdrop, emojiBurst } from './fx.js';

const $ = (id) => document.getElementById(id);
const STATE_TEXT = { idle: 'En espera', listening: 'Escuchando', thinking: 'Pensando', speaking: 'Hablando' };
const REQUIRED = [...VISEMES, 'mouthSmile', 'eyeBlink', 'browUp'];
const STANDBY_TEXT = 'Háblame o toca la pantalla para conversar';
const ERRORS = {
  codigo: 'Escribe el código de acceso.', ocupado: 'Estoy ocupado con otra persona. Intenta en un momento.',
  tiempo: 'Llegamos al tiempo máximo. Háblame para empezar otra conversación.', inactividad: '',
  escucha: 'Se perdió la conexión con el servicio de escucha. Háblame para reintentar.',
};

const avatar = await createAvatar($('stage'));
const missing = REQUIRED.filter((n) => !avatar.morphNames.includes(n));
if (missing.length) console.warn('Al modelo le faltan morph targets:', missing);
if (new URLSearchParams(location.search).get('subs') === '0') $('subtitles').classList.add('off'); // subtitulos opcionales: ?subs=0

const lips = new LipSync();
const backdrop = createBackdrop($('backdrop'));
let audioCtx = null, player = null, socket = null, mic = null;
let state = 'idle', live = false, connecting = false, speechId = -1, subChars = [], subShown = 0, wasPlaying = false, closeReason = '';
// Modo espera: tras el primer toque el microfono queda abierto en el navegador (sin enviar nada). Cuando alguien habla,
// la conversacion arranca sola y lo que dijo mientras se conectaba se envia desde este pequeno buffer.
let armed = false, loud = 0, retryAt = 0;
const prebuffer = [];

// Identificador al azar de este navegador, para que el avatar reconozca a quien vuelve. En un kiosco compartido se
// desactiva con ?kiosco=1 (todas las personas usarian el mismo navegador).
const KIOSK = new URLSearchParams(location.search).get('kiosco') === '1';
function visitorId() {
  if (KIOSK) return undefined;
  try {
    let id = localStorage.getItem('minijavi_visitor');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('minijavi_visitor', id); }
    return id;
  } catch { return undefined; }
}
let cardTimer = null;
function showCard(card) {
  $('card-title').textContent = card.title || '';
  $('card-lines').replaceChildren(...(card.lines || []).map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  $('card-qr').hidden = !card.qr; if (card.qr) $('card-qr').src = card.qr;
  $('card-caption').textContent = card.caption || '';
  $('card').hidden = false;
  clearTimeout(cardTimer); cardTimer = setTimeout(hideCard, card.qr ? 30000 : 14000); // el QR se queda mas tiempo para alcanzar a escanearlo
}
function hideCard() { clearTimeout(cardTimer); $('card').hidden = true; }

function setState(s) {
  if (s === state) return;
  state = s; avatar.setState(s);
  $('status').dataset.state = s; $('status-text').textContent = STATE_TEXT[s];
}
function stopSpeech() { player?.stop(); lips.reset(); speechId = -1; subChars = []; }

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      live = true; connecting = false; $('gate').hidden = true; $('mic').hidden = false; setState('listening');
      $('owner').hidden = !msg.owner; // aviso visible de que esta sesion tiene las herramientas privadas
      for (const b of prebuffer.splice(0)) socket.sendAudio(b);
      break;
    case 'error':
      closeReason = ERRORS[msg.reason] ?? 'Ocurrió un problema. Háblame para reintentar.';
      if (msg.reason === 'codigo') { $('code').hidden = false; armed = false; }
      if (msg.reason === 'ocupado') retryAt = performance.now() + 15000;
      break;
    case 'user_partial':
      if (state !== 'speaking') { $('sub-user').textContent = msg.text; }
      break;
    case 'user_final':
      $('sub-user').textContent = msg.text; $('sub-avatar').textContent = ''; hideCard(); setState('thinking'); break;
    case 'speech_start':
      stopSpeech(); speechId = msg.id; subShown = 0; player.begin(msg.sampleRate); backdrop.show(null); break;
    case 'audio':
      if (msg.id !== speechId) break;
      if (msg.align) { lips.add(msg.align.chars, msg.align.starts, msg.align.ends); for (let i = 0; i < msg.align.chars.length; i++) subChars.push({ c: msg.align.chars[i], t: msg.align.starts[i] }); }
      if (state !== 'speaking') { setState('speaking'); avatar.raiseBrows(); }
      player.push(base64ToBytes(msg.audio));
      break;
    case 'speech_end':
      if (msg.id === speechId) player.end();
      break;
    case 'reaction': // gesto del avatar + emojis
      avatar.react(msg.name); emojiBurst($('fx'), msg.name); break;
    case 'scene':
      backdrop.show(msg.name); break;
    case 'card':
      showCard(msg); break;
    case 'interrupt': // el usuario hablo encima: se corta el audio y la boca vuelve a reposo
      stopSpeech(); $('sub-avatar').textContent = ''; backdrop.show(null); setState('listening'); break;
  }
}

/** Fin de la conversacion: vuelve al modo espera (o a la tarjeta inicial si aun no hay microfono). */
function shutdown(message) {
  live = false; connecting = false; prebuffer.length = 0; loud = 0;
  retryAt = Math.max(retryAt, performance.now() + 2500);
  stopSpeech(); backdrop.show(null); hideCard(); setState('idle');
  $('sub-user').textContent = ''; $('sub-avatar').textContent = '';
  $('mic').hidden = true; $('owner').hidden = true; $('gate').hidden = false;
  $('gate').classList.toggle('standby', armed);
  $('gate-text').textContent = armed ? (message || STANDBY_TEXT) : 'Toca para empezar a conversar. El navegador te pedirá permiso para usar el micrófono.';
  $('gate-error').textContent = armed ? '' : (message || '');
  if (armed && message) setTimeout(() => { if (!live && !connecting) $('gate-text').textContent = STANDBY_TEXT; }, 6000);
}

function startSession() {
  if (live || connecting) return;
  connecting = true; closeReason = '';
  socket?.close();
  socket = connect($('code').value, visitorId(), { onMessage, onClose: ({ wasReady }) => shutdown(closeReason || (wasReady ? '' : 'No pude conectar. Intenta de nuevo.')) });
}

function onMicChunk(buffer) {
  if (live) { socket.sendAudio(buffer); return; }
  if (!armed) return;
  prebuffer.push(buffer); if (prebuffer.length > 50) prebuffer.shift(); // ~2 s
  if (connecting || performance.now() < retryAt) { loud = 0; return; }
  // Deteccion simple de voz por volumen: ~0,25 s seguidos por encima del umbral.
  const pcm = new Int16Array(buffer); let sum = 0;
  for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / (pcm.length / 4)) / 32768;
  loud = rms > 0.03 ? loud + 1 : Math.max(0, loud - 1);
  if (loud >= 6) { loud = 0; startSession(); }
}

async function begin() {
  $('gate-error').textContent = '';
  try {
    // El gesto del usuario habilita el audio y el microfono del navegador.
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    player ??= new SpeechPlayer(audioCtx);
    if (!mic) mic = await startMic(audioCtx, onMicChunk);
    armed = true; retryAt = 0;
    startSession();
  } catch (e) {
    armed = false;
    shutdown(e?.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono.' : 'No pude activar el micrófono.');
  }
}
$('gate-form').addEventListener('submit', (ev) => { ev.preventDefault(); begin(); });
$('gate').addEventListener('click', (ev) => { if ($('gate').classList.contains('standby') && ev.target.id !== 'code') begin(); });

// Bucle de animacion: la boca sigue el tiempo real del audio.
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const playing = !!player && player.active;
  if (wasPlaying !== playing) { wasPlaying = playing; socket?.send({ type: 'playback', playing }); } // el servidor sabe cuando termina de sonar
  if (state === 'speaking' && !playing) { lips.reset(); setState(live ? 'listening' : 'idle'); setTimeout(() => { if (state !== 'speaking') backdrop.show(null); }, 2500); }
  const t = playing ? player.time() : -1;
  const w = lips.update(state === 'speaking' ? t : -1, dt);
  for (const v of VISEMES) avatar.setMorph(v, Math.max(w[v], avatar.exprMouth[v] || 0));
  if (state === 'speaking' && subChars.length) { // subtitulos que avanzan con la voz
    let n = subShown;
    while (n < subChars.length && subChars[n].t <= t + 0.25) n++;
    if (n !== subShown) { subShown = n; $('sub-avatar').textContent = subChars.slice(0, n).map((x) => x.c).join(''); }
  }
  avatar.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__avatarDebug = {
  react: (n) => { avatar.react(n); emojiBurst($('fx'), n); }, scene: (n) => backdrop.show(n), card: showCard,
  standby: () => { armed = true; shutdown(''); },
  get weights() { return { ...lips.weights }; }, get state() { return state; }, get time() { return player ? player.time() : -1; }, morphNames: avatar.morphNames, missing,
};
