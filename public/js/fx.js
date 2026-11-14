// Efectos de pantalla: lluvia de emojis y confeti por reaccion, y fondos animados por tema.
const EMOJIS = {
  sorpresa: ['⚠️', '🚨', '😳'],
  alegria: ['❤️', '💖', '😍', '💕'],
  risa: ['😂', '🤣', '😆'],
  pena: ['🥺', '💙', '😢'],
  pensativo: ['🤔', '💭'],
  celebracion: ['🎉', '🥳', '🎊', '✨'],
  despedida: ['👋', '✨', '🙌'],
};
const CONFETTI = new Set(['celebracion', 'despedida']);
const COLORS = ['#ff5a5f', '#ffb400', '#00c2a8', '#4f8cff', '#b86bff', '#ffffff'];

export function emojiBurst(layer, name) {
  const set = EMOJIS[name]; if (!set) return;
  for (let i = 0; i < 14; i++) {
    const el = document.createElement('span');
    el.className = 'emoji'; el.textContent = set[(Math.random() * set.length) | 0];
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
  if (CONFETTI.has(name)) confetti(layer);
}

function confetti(layer) {
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('span');
    el.className = 'confetti';
    el.style.left = `${Math.random() * 100}%`;
    el.style.background = COLORS[i % COLORS.length];
    el.style.width = `${6 + Math.random() * 6}px`; el.style.height = `${10 + Math.random() * 10}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 1080}deg`);
    el.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
    el.style.animationDelay = `${Math.random() * 0.6}s`;
    el.addEventListener('animationend', () => el.remove());
    layer.appendChild(el);
  }
}

/** Fondo animado detras del avatar. show('matrix' | 'estrellas' | 'atardecer' | null) lo cambia con un fundido. */
export function createBackdrop(canvas) {
  const ctx = canvas.getContext('2d');
  const GLYPHS = 'アイウエオカキクケコサシスセソ01{}<>/=;λπ∑01'.split('');
  let current = null, timer = null, W = 0, H = 0, size = 18, cols = [], stars = [], t = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(window.innerWidth * dpr); H = canvas.height = Math.floor(window.innerHeight * dpr);
    size = Math.round(18 * dpr);
    cols = Array.from({ length: Math.ceil(W / size) }, () => Math.random() * -40);
    stars = Array.from({ length: 160 }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() }));
  }
  const draw = {
    matrix() {
      ctx.fillStyle = 'rgba(6, 10, 8, 0.16)'; ctx.fillRect(0, 0, W, H);
      ctx.font = `${size}px ui-monospace, Menlo, monospace`;
      for (let i = 0; i < cols.length; i++) {
        const y = cols[i] * size;
        ctx.fillStyle = Math.random() < 0.08 ? '#d6ffe0' : '#27d06a';
        ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], i * size, y);
        cols[i] = y > H && Math.random() > 0.975 ? 0 : cols[i] + 1;
      }
    },
    estrellas() { // campo de estrellas que se acercan
      ctx.fillStyle = 'rgba(6, 8, 22, 0.35)'; ctx.fillRect(0, 0, W, H);
      for (const s of stars) {
        s.z -= 0.006; if (s.z <= 0.02) { s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; s.z = 1; }
        const px = W / 2 + (s.x / s.z) * W * 0.5, py = H / 2 + (s.y / s.z) * H * 0.5, r = (1 - s.z) * size * 0.16 + 0.6;
        ctx.fillStyle = `rgba(210, 225, 255, ${Math.min(1, 1.2 - s.z)})`;
        ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill();
      }
    },
    atardecer() { // cielo calido con un sol bajo y un brillo que respira
      t += 0.02;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2a1b4d'); g.addColorStop(0.5, '#b8456b'); g.addColorStop(0.82, '#ff9a4d'); g.addColorStop(1, '#ffd27a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const r = Math.min(W, H) * (0.28 + Math.sin(t) * 0.01);
      const sun = ctx.createRadialGradient(W / 2, H * 0.86, 0, W / 2, H * 0.86, r * 2.2);
      sun.addColorStop(0, 'rgba(255, 240, 190, 0.95)'); sun.addColorStop(0.35, 'rgba(255, 190, 110, 0.55)'); sun.addColorStop(1, 'rgba(255, 150, 80, 0)');
      ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);
    },
  };
  window.addEventListener('resize', () => { if (current) resize(); });
  return {
    show(name) {
      if (!draw[name]) name = null;
      if (name === current) return;
      current = name; canvas.classList.toggle('on', !!name);
      if (name) { clearInterval(timer); resize(); ctx.clearRect(0, 0, W, H); timer = setInterval(draw[name], 55); }
      else setTimeout(() => { if (!current) { clearInterval(timer); timer = null; } }, 1400); // sigue animando durante el fundido
    },
    get current() { return current; },
  };
}
