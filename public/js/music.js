// Mini reproductor de musica de fondo: el reproductor oficial de YouTube (IFrame API), siempre visible y sin nada encima,
// como piden sus politicas (minimo 200x200 px; no se reproduce oculto ni se extrae el audio).
// El servidor decide la cola; aqui se reproduce, se pasa sola a la siguiente y se baja el volumen cuando alguien habla.
const DUCK = 4; // volumen mientras alguien habla

export function createMusic(box, onChange) {
  const label = box.querySelector('.music-title'), vol = box.querySelector('.music-vol');
  let player = null, ready = null, queue = [], index = 0, volume = 15, ducked = false, errors = 0;

  function load() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => {
        player = new window.YT.Player('music-player', {
          width: 240, height: 200, playerVars: { playsinline: 1, origin: location.origin },
          events: { onReady: () => resolve(), onStateChange, onError },
        });
      };
      const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { ready = null; reject(new Error('no se pudo cargar YouTube')); };
      document.head.append(s);
    });
    return ready;
  }
  const applyVolume = () => { try { player?.setVolume(ducked ? Math.min(volume, DUCK) : volume); } catch { /* aun no esta listo */ } vol.textContent = `vol ${volume}%`; };
  function show() { const t = queue[index]; label.textContent = t ? `♪ ${t.title} — ${t.channel}` : ''; label.title = label.textContent; }
  function start() { show(); applyVolume(); player.loadVideoById(queue[index].id); }
  function step(n) { if (!queue.length) return; index = (index + n + queue.length) % queue.length; start(); onChange({ index, playing: true }); }
  function onStateChange(ev) {
    if (ev.data === 1) { errors = 0; applyVolume(); onChange({ index, playing: true }); }  // reproduciendo
    else if (ev.data === 2) onChange({ index, playing: false });                            // pausa (tambien si se pauso en el reproductor)
    else if (ev.data === 0) step(1);                                                        // termino: la siguiente de la cola
  }
  // Video borrado, privado o que no permite insertarse: se pasa al siguiente (sin dar vueltas si fallan todos).
  function onError() { if (++errors < queue.length) step(1); else { onChange({ index, playing: false }); label.textContent = 'No se pudo reproducir esa música.'; } }

  return {
    async play(q, i, v) {
      queue = q || []; index = i || 0; if (Number.isFinite(v)) volume = v; errors = 0;
      if (!queue.length) return;
      box.hidden = false; show(); // visible antes de reproducir
      try { await load(); start(); } catch (e) { label.textContent = e.message; onChange({ index, playing: false }); }
    },
    pause() { player?.pauseVideo(); },
    resume() { if (queue.length) { box.hidden = false; player?.playVideo(); } },
    stop() { try { player?.stopVideo(); } catch { /* sin reproductor */ } queue = []; box.hidden = true; },
    setVolume(v) { volume = Math.max(0, Math.min(100, v)); applyVolume(); },
    /** Baja la musica mientras alguien habla (el avatar o la persona) y la devuelve a su volumen despues. */
    duck(on) { if (on !== ducked) { ducked = on; if (player && queue.length) applyVolume(); } },
    get active() { return queue.length > 0; },
  };
}
