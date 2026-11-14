// Efectos de pantalla: lluvia de emojis por reaccion y fondo tipo Matrix.
const EMOJIS = {
  sorpresa: ['⚠️', '🚨', '😳', '⚠️', '🚨'],
  alegria: ['❤️', '💖', '😍', '❤️', '💕'],
  risa: ['😂', '🤣', '😆', '😂'],
  pena: ['🥺', '💙', '😢', '💙'],
  pensativo: ['🤔', '💭', '🤔', '💭'],
};

export function emojiBurst(layer, name) {
  const set = EMOJIS[name]; if (!set) return;
  const count = 14;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('span');
    el.className = 'emoji'; el.textContent = set[i % set.length];
    const side = i % 2 ? 1 : -1; // a los lados de la cabeza, no encima de la cara
    el.style.left = `${50 + side * (16 + Math.random() * 24)}%`;
    el.style.top = `${30 + Math.random() * 40}%`;
    el.style.fontSize = `${28 + Math.random() * 30}px`;
    el.style.setProperty('--dx', `${side * (10 + Math.random() * 50)}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 50}deg`);
    el.style.animationDelay = `${Math.random() * 0.5}s`;
    el.addEventListener('animationend', () => el.remove());
    layer.appendChild(el);
  }
}

/** Lluvia de caracteres verdes detras del avatar. show(true/false) la enciende o apaga con un fundido. */
export function createMatrix(canvas) {
  const ctx = canvas.getContext('2d');
  const GLYPHS = 'アイウエオカキクケコサシスセソ01{}<>/=;λπ∑01'.split('');
  let cols = [], size = 18, on = false, timer = null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr); canvas.height = Math.floor(window.innerHeight * dpr);
    size = Math.round(18 * dpr);
    cols = Array.from({ length: Math.ceil(canvas.width / size) }, () => Math.random() * -40);
  }
  function tick() {
    ctx.fillStyle = 'rgba(6, 10, 8, 0.16)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${size}px ui-monospace, Menlo, monospace`;
    for (let i = 0; i < cols.length; i++) {
      const y = cols[i] * size;
      ctx.fillStyle = Math.random() < 0.08 ? '#d6ffe0' : '#27d06a';
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * size, y);
      cols[i] = y > canvas.height && Math.random() > 0.975 ? 0 : cols[i] + 1;
    }
  }
  window.addEventListener('resize', () => { if (on) resize(); });
  return {
    show(value) {
      if (value === on) return;
      on = value; canvas.classList.toggle('on', on);
      if (on) { resize(); ctx.clearRect(0, 0, canvas.width, canvas.height); timer = setInterval(tick, 55); }
      else { setTimeout(() => { if (!on) { clearInterval(timer); timer = null; } }, 1400); } // sigue animando durante el fundido
    },
    get on() { return on; },
  };
}
