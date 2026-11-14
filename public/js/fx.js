// Efectos de pantalla: lluvia de emojis por reaccion y fondos animados por tema.
const EMOJIS = {
  sorpresa: ['⚠️', '🚨', '😳'],
  alegria: ['❤️', '💖', '😍', '💕'],
  risa: ['😂', '🤣', '😆'],
  pena: ['🥺', '💙', '😢'],
  pensativo: ['🤔', '💭'],
  celebracion: ['🎉', '🥳', '🎊', '✨'],
  despedida: ['👋', '✨', '🙌'],
  dinero: ['💵', '💰', '🤑', '💸'],
};

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
}

/** Fondo animado detras del avatar. show('matrix' | 'estrellas' | 'atardecer' | 'soleado' | 'nublado' | 'lluvia' | 'tormenta' | null). */
export function createBackdrop(canvas) {
  const ctx = canvas.getContext('2d');
  const GLYPHS = 'アイウエオカキクケコサシスセソ01{}<>/=;λπ∑01'.split('');
  let current = null, timer = null, W = 0, H = 0, size = 18, cols = [], stars = [], t = 0, drops = [], clouds = [], flash = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(window.innerWidth * dpr); H = canvas.height = Math.floor(window.innerHeight * dpr);
    size = Math.round(18 * dpr);
    cols = Array.from({ length: Math.ceil(W / size) }, () => Math.random() * -40);
    drops = Array.from({ length: 220 }, () => ({ x: Math.random() * 1.3, y: Math.random(), v: 0.035 + Math.random() * 0.03, l: 0.02 + Math.random() * 0.03 }));
    clouds = Array.from({ length: 9 }, (_, i) => ({ x: Math.random(), y: 0.08 + (i % 4) * 0.2 + Math.random() * 0.08, r: 0.14 + Math.random() * 0.12, v: 0.0006 + Math.random() * 0.0008 }));
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
  function sky(top, bottom) { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, top); g.addColorStop(1, bottom); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  function drawClouds(color) {
    for (const c of clouds) {
      c.x += c.v; if (c.x > 1.3) c.x = -0.3;
      const cx = c.x * W, cy = c.y * H, r = c.r * Math.min(W, H) * 1.3;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.6, r * 0.75, 0, 0, 6.283); ctx.fill();
    }
  }
  function drawRain(alpha) {
    ctx.strokeStyle = `rgba(190, 215, 255, ${alpha})`; ctx.lineWidth = Math.max(1, size * 0.08); ctx.beginPath();
    for (const d of drops) {
      d.y += d.v; d.x -= d.v * 0.25; if (d.y > 1.05) { d.y = -0.05; d.x = Math.random() * 1.3; }
      ctx.moveTo(d.x * W, d.y * H); ctx.lineTo((d.x - d.l * 0.25) * W, (d.y + d.l) * H);
    }
    ctx.stroke();
  }
  // Fondos del clima: los elige el servidor segun el dato real de la consulta.
  draw.soleado = () => {
    t += 0.01; sky('#3fa9f5', '#bfe6ff');
    const cx = W * 0.82, cy = H * 0.16, r = Math.min(W, H) * 0.11;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t); ctx.strokeStyle = 'rgba(255, 236, 150, 0.75)'; ctx.lineWidth = r * 0.14; ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(r * 1.35, 0); ctx.lineTo(r * (1.75 + 0.12 * Math.sin(t * 6 + i)), 0); ctx.stroke(); }
    ctx.restore();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3.2); g.addColorStop(0, 'rgba(255, 250, 205, 1)'); g.addColorStop(0.3, 'rgba(255, 224, 110, 0.95)'); g.addColorStop(0.34, 'rgba(255, 224, 110, 0.35)'); g.addColorStop(1, 'rgba(255, 224, 110, 0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  draw.nublado = () => { sky('#7d8894', '#c3cad2'); drawClouds('rgba(240, 243, 247, 0.6)'); };
  draw.lluvia = () => { sky('#2c3947', '#5c6b7a'); drawClouds('rgba(120, 132, 146, 0.5)'); drawRain(0.55); };
  draw.tormenta = () => {
    sky('#161c26', '#3a4350'); drawClouds('rgba(70, 78, 92, 0.6)'); drawRain(0.6);
    if (flash <= 0 && Math.random() < 0.012) flash = 1;      // relampago ocasional
    if (flash > 0) { ctx.fillStyle = `rgba(235, 240, 255, ${0.5 * flash})`; ctx.fillRect(0, 0, W, H); flash -= 0.18; }
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
