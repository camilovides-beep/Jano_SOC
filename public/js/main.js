import { createAvatar } from './avatar.js';
import { SpeechPlayer, base64ToBytes } from './audio.js';
import { LipSync, VISEMES } from './lipsync.js';
import { startMic } from './mic.js';
import { connect } from './socket.js';
import { createMatrix, emojiBurst } from './fx.js';

const $ = (id) => document.getElementById(id);
const STATE_TEXT = { idle: 'En reposo', listening: 'Escuchando', thinking: 'Pensando', speaking: 'Hablando' };
const REQUIRED = [...VISEMES, 'mouthSmile', 'eyeBlink', 'browUp'];
const ERRORS = {
  codigo: 'Escribe el código de acceso.', ocupado: 'El avatar está ocupado con otra persona. Intenta en un momento.',
  tiempo: 'La conversación llegó a su tiempo máximo. Toca para empezar otra.', inactividad: 'Cerré la conversación por inactividad. Toca para volver a hablar.',
  escucha: 'Se perdió la conexión con el servicio de escucha. Toca para reintentar.',
};

const avatar = await createAvatar($('stage'));
const missing = REQUIRED.filter((n) => !avatar.morphNames.includes(n));
if (missing.length) console.warn('Al modelo le faltan morph targets:', missing);
if (new URLSearchParams(location.search).get('subs') === '0') $('subtitles').classList.add('off'); // subtitulos opcionales: ?subs=0

const lips = new LipSync();
const matrix = createMatrix($('matrix'));
let audioCtx = null, player = null, socket = null, mic = null;
let state = 'idle', live = false, speechId = -1, subChars = [], subShown = 0, wasPlaying = false, closeReason = '';

function setState(s) {
  if (s === state) return;
  state = s; avatar.setState(s);
  $('status').dataset.state = s; $('status-text').textContent = STATE_TEXT[s];
}
function stopSpeech() { player?.stop(); lips.reset(); speechId = -1; subChars = []; }

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      live = true; $('gate').hidden = true; $('mic').hidden = false; setState('listening'); break;
    case 'error':
      closeReason = ERRORS[msg.reason] || 'Ocurrió un problema. Toca para reintentar.';
      if (msg.reason === 'codigo') $('code').hidden = false;
      break;
    case 'user_partial':
      if (state !== 'speaking') { $('sub-user').textContent = msg.text; }
      break;
    case 'user_final':
      $('sub-user').textContent = msg.text; $('sub-avatar').textContent = ''; setState('thinking'); break;
    case 'speech_start':
      stopSpeech(); speechId = msg.id; subShown = 0; player.begin(msg.sampleRate); matrix.show(false); break;
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
      if (msg.name === 'matrix') matrix.show(true);
      break;
    case 'interrupt': // el usuario hablo encima: se corta el audio y la boca vuelve a reposo
      stopSpeech(); $('sub-avatar').textContent = ''; matrix.show(false); setState('listening'); break;
  }
}

function shutdown(message) {
  matrix.show(false);
  live = false; mic?.stop(); mic = null; stopSpeech(); setState('idle');
  $('mic').hidden = true; $('gate').hidden = false; $('gate-error').textContent = message || '';
}

$('gate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault(); $('gate-error').textContent = ''; closeReason = '';
  try {
    // El gesto del usuario habilita el audio y el microfono del navegador.
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    player ??= new SpeechPlayer(audioCtx);
    socket?.close();
    socket = connect($('code').value, { onMessage, onClose: ({ wasReady }) => shutdown(closeReason || (wasReady ? 'Se perdió la conexión. Toca para volver a hablar.' : 'No pude conectar. Intenta de nuevo.')) });
    mic?.stop();
    mic = await startMic(audioCtx, (buffer) => socket?.sendAudio(buffer));
  } catch (e) {
    socket?.close();
    shutdown(e?.name === 'NotAllowedError' ? 'Necesito permiso para usar el micrófono.' : 'No pude activar el micrófono.');
  }
});

// Bucle de animacion: la boca sigue el tiempo real del audio.
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const playing = !!player && player.active;
  if (wasPlaying !== playing) { wasPlaying = playing; socket?.send({ type: 'playback', playing }); } // el servidor sabe cuando termina de sonar
  if (state === 'speaking' && !playing) { lips.reset(); setState(live ? 'listening' : 'idle'); setTimeout(() => { if (state !== 'speaking') matrix.show(false); }, 2500); }
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
window.__avatarDebug = { react: (n) => { avatar.react(n); emojiBurst($('fx'), n); }, matrix: (v) => matrix.show(v), get weights() { return { ...lips.weights }; }, get state() { return state; }, get time() { return player ? player.time() : -1; }, morphNames: avatar.morphNames, missing };
