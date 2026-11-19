// Carga el GLB y anima todo lo que no es la boca: estados, parpadeo, mirada, cabeza y cejas.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const rnd = (a, b) => a + Math.random() * (b - a);

// Modelo: casco corintio con ojos de luz y una llama en un ojo (lo genera scripts/avatar-casco.py en Blender).
const MODEL = '../models/avatar-casco.glb';
const PHONES = { x: 1.08, top: 0.62, earY: -0.25, z: -0.1 }; // proporciones de los audifonos respecto a la caja del modelo (la cresta la agranda)

// Ojo en llamas: una llama azul animada (shader) que nace en un ojo y sale hacia el lado, mas chispas que flotan.
// Va en el mismo grupo que la cabeza, asi gira con ella. Medidas en unidades del modelo (el casco mide unos 2 de ancho).
// angle: hacia donde apunta la llama, en grados desde la vertical hacia afuera (0 = arriba, 90 = de lado).
// lean: cuanto se curva la punta (negativo = hacia arriba, como fuego que empuja el viento).
// alertEye: el otro ojo, que se enciende con su propia llama (en espejo) solo mientras haya una alerta abierta.
const FLAME = { eye: 'Eye_L', alertEye: 'Eye_R', width: 0.82, height: 1.35, base: 0.14, ahead: 0.17, angle: 80, lean: -0.45, embers: 60 };

const FLAME_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FLAME_FRAG = /* glsl */`
uniform float uTime, uPower, uBase, uLean, uAlert, uShow;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  float y = vUv.y, x = (vUv.x - 0.5) * 2.0, t = uTime;
  // Envolvente: redonda alrededor del ojo y se afila hacia la punta (y = a lo largo de la llama), curvada segun uLean.
  float wob = (fbm(vec2(x * 1.5, y * 2.0 - t * 1.4)) - 0.5) * 0.9 * y;
  float lean = uLean * y * y + wob;
  float w = y < uBase ? sqrt(max(0.0, 1.0 - pow((uBase - y) / uBase, 2.0))) : pow(max(0.0, 1.0 - (y - uBase) / (1.0 - uBase)), 0.9);
  w *= 0.8 * uPower;
  float env = 1.0 - smoothstep(w * 0.35, w, abs(x - lean));
  // Fuego: ruido que sube; arriba se rompe en lenguas sueltas.
  float f = fbm(vec2((x - lean) * 3.0, y * 3.8 - t * 3.2));
  float fire = env * (f * 1.7 - y * 1.05 + 0.42);
  float body = smoothstep(0.18, 0.42, fire), core = smoothstep(0.5, 0.85, fire);
  body *= smoothstep(0.0, 0.08, y);
  // Azul en calma; rojo mientras haya una alerta de seguridad abierta (uAlert 0..1, con fundido).
  vec3 deep = mix(vec3(0.0, 0.12, 0.85), vec3(0.75, 0.0, 0.02), uAlert), mid = mix(vec3(0.05, 0.42, 1.0), vec3(1.0, 0.16, 0.04), uAlert), hot = mix(vec3(0.55, 0.85, 1.0), vec3(1.0, 0.72, 0.5), uAlert);
  vec3 col = mix(deep, mid, smoothstep(0.1, 0.6, body));
  col = mix(col, hot, core * clamp(1.2 - y * 1.5, 0.0, 1.0));
  gl_FragColor = vec4(col, body * 0.92 * uShow);
}`;

/** Llama de un ojo. `side`: 1 = ojo izquierdo del casco (sale hacia la derecha de la pantalla), -1 = el otro, en espejo. */
function createFlame(root, pivot, eyeName, side) {
  const eye = root.getObjectByName(eyeName); if (!eye) return null;
  root.updateMatrixWorld(true);
  const at = eye.getWorldPosition(new THREE.Vector3());
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 1 }, uBase: { value: FLAME.base }, uLean: { value: FLAME.lean * side }, uAlert: { value: 0 }, uShow: { value: 1 } },
    vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,   // mezcla normal: sobre el oro se ve azul, no blanco
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(FLAME.width, FLAME.height), mat);
  // El plano se gira para que la llama apunte segun FLAME.angle; su base (uBase) queda justo sobre el ojo y va un poco
  // por delante del casco.
  const ang = THREE.MathUtils.degToRad(FLAME.angle), dir = new THREE.Vector2(Math.sin(ang) * side, Math.cos(ang));
  const along = FLAME.height / 2 - FLAME.height * FLAME.base;
  plane.position.set(at.x + dir.x * along, at.y + dir.y * along, at.z + FLAME.ahead); plane.rotation.z = -ang * side;
  plane.renderOrder = 20; pivot.add(plane);

  // Chispas: puntos que nacen a lo largo de la llama, salen en su direccion subiendo un poco y se apagan.
  const N = FLAME.embers, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), life = new Float32Array(N), vel = [];
  const spawn = (i, first) => {
    const s = Math.random() * FLAME.height * (first ? 0.8 : 0.35), side = (Math.random() - 0.5) * FLAME.width * 0.35;
    pos[i * 3] = at.x + dir.x * s + dir.y * side; pos[i * 3 + 1] = at.y + dir.y * s - dir.x * side;
    pos[i * 3 + 2] = at.z + FLAME.ahead + (Math.random() - 0.5) * 0.15;
    const sp = 0.3 + Math.random() * 0.45, up = 0.05 + Math.random() * 0.15;
    vel[i] = [dir.x * sp, dir.y * sp + up]; life[i] = first ? Math.random() : 1;
  };
  for (let i = 0; i < N; i++) spawn(i, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const dot = document.createElement('canvas'); dot.width = dot.height = 32;
  const g = dot.getContext('2d'), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  const sparks = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.07, map: new THREE.CanvasTexture(dot), vertexColors: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sparks.renderOrder = 21; pivot.add(sparks);

  return {
    /** `show` (0..1): cuanto se ve; la llama del segundo ojo entra y sale con la alerta. */
    update(dt, time, power, alert = 0, show = 1) {
      plane.visible = sparks.visible = show > 0.01; if (!plane.visible) return;
      mat.uniforms.uShow.value = show; mat.uniforms.uTime.value = time; mat.uniforms.uAlert.value = alert; mat.uniforms.uPower.value += (power - mat.uniforms.uPower.value) * Math.min(1, dt * 4);
      for (let i = 0; i < N; i++) {
        life[i] -= dt * (0.45 + (i % 5) * 0.08);
        if (life[i] <= 0) spawn(i, false);
        pos[i * 3] += vel[i][0] * dt; pos[i * 3 + 1] += vel[i][1] * dt;
        const k = show * Math.max(0, Math.min(1, life[i] * 1.6)) * (0.6 + 0.4 * Math.sin(time * 9 + i)); // titila al apagarse
        col[i * 3] = (0.3 + 0.7 * alert) * k; col[i * 3 + 1] = (0.75 - 0.6 * alert) * k; col[i * 3 + 2] = (1.0 - 0.92 * alert) * k;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    },
  };
}

export async function createAvatar(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(14, 1, 0.1, 100); // campo de vision muy angosto: casi sin perspectiva, como el Memoji

  // Luz casi frontal y pareja, mas un entorno de estudio para que el oro y el acero del casco tengan reflejos.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-1.2, 1.6, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(2, 1.5, -3); scene.add(rim);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.8; pmrem.dispose();

  const gltf = await new GLTFLoader().loadAsync(new URL(MODEL, import.meta.url).href);
  const root = gltf.scene; const pivot = new THREE.Group(); pivot.add(root); scene.add(pivot);

  // Los morph targets estan repartidos en varias mallas: se indexa cada nombre con todas las mallas que lo tienen.
  const morphs = new Map();
  let lensMesh = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material?.name === 'Lens') { o.material.depthWrite = false; o.renderOrder = 10; lensMesh = o; } // cristal de las gafas
    const dict = o.morphTargetDictionary; if (!dict) return;
    for (const [name, index] of Object.entries(dict)) {
      if (!morphs.has(name)) morphs.set(name, []);
      morphs.get(name).push({ mesh: o, index });
    }
  });
  const setMorph = (name, value) => { const list = morphs.get(name); if (list) for (const m of list) m.mesh.morphTargetInfluences[m.index] = value; };
  const eyeL = root.getObjectByName('Eye_L'), eyeR = root.getObjectByName('Eye_R');

  // Alerta de seguridad: los ojos (luz, nucleo y halo) y la cresta pasan a rojo con un fundido, y vuelven al resolverla.
  // Se guarda el color original de cada material y se mezcla con su version roja segun alertK (0 = azul, 1 = rojo).
  const ALERT_RED = { Luz: 0xff1408, Nucleo: 0xffa898, Halo: 0xff1a06, CrestaA: 0x4a0306, CrestaB: 0x6e060a, CrestaC: 0x94100e };
  const tinted = []; // { m, glow (cambia la emision, no el color base), from, to }
  root.traverse((o) => {
    for (const m of o.isMesh ? [o.material].flat() : []) {
      if (!(m?.name in ALERT_RED) || tinted.some((t) => t.m === m)) continue;
      const glow = !!m.emissive && m.emissive.getHex() !== 0;
      tinted.push({ m, glow, from: (glow ? m.emissive : m.color).clone(), to: new THREE.Color(ALERT_RED[m.name]) });
    }
  });
  let alertOn = false, alertK = 0, alertShown = -1;
  function paintAlert() {
    for (const t of tinted) (t.glow ? t.m.emissive : t.m.color).lerpColors(t.from, t.to, alertK);
    alertShown = alertK;
  }

  // Reflejo de pantalla en el cristal de los ojos: cuando "lee" en suspension, unas lineas de codigo suben por el cristal.
  // El cristal del modelo no trae coordenadas de textura: se proyectan aqui, cada lente por separado.
  const lens = { k: 0, lines: [], scroll: 0, mat: null, tex: null, ctx: null, at: 0 };
  if (lensMesh) {
    const geo = lensMesh.geometry.clone(), pos = geo.attributes.position, uv = new Float32Array(pos.count * 2);
    const b = [[Infinity, -Infinity], [Infinity, -Infinity]]; let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), s = x < 0 ? 0 : 1; b[s][0] = Math.min(b[s][0], x); b[s][1] = Math.max(b[s][1], x); y0 = Math.min(y0, pos.getY(i)); y1 = Math.max(y1, pos.getY(i)); }
    for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), s = x < 0 ? 0 : 1; uv[i * 2] = (x - b[s][0]) / (b[s][1] - b[s][0] || 1); uv[i * 2 + 1] = (pos.getY(i) - y0) / (y1 - y0 || 1); }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 192;
    lens.ctx = cv.getContext('2d'); lens.tex = new THREE.CanvasTexture(cv); lens.tex.colorSpace = THREE.SRGBColorSpace;
    lens.mat = new THREE.MeshBasicMaterial({ map: lens.tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    const glow = new THREE.Mesh(geo, lens.mat); glow.renderOrder = 11; glow.visible = false; glow.position.z = 0.002;
    lensMesh.add(glow); lens.mesh = glow;
  }
  const flame = createFlame(root, pivot, FLAME.eye, 1), flame2 = createFlame(root, pivot, FLAME.alertEye, -1);
  // Audifonos para cuando escucha musica en suspension: diadema y dos copas, hechos aqui (el modelo no los trae).
  const phones = new THREE.Group(); phones.visible = false;
  // Actividades del modo suspension: dormir, leer y musica.
  let act = null, actT = 0, sleepK = 0, musicK = 0, readK = 0;
  const LENS_COLORS = ['#8fe3ff', '#b6ffb0', '#ffe08a', '#d7c2ff', '#ffffff'];
  function drawLens(dt) {
    const c = lens.ctx, W = 256, H = 192, lh = 15;
    lens.scroll += dt * 26;                       // el texto sube como en una terminal
    while (lens.scroll >= lh && lens.lines.length > 1) { lens.scroll -= lh; lens.lines.push(lens.lines.shift()); }
    c.clearRect(0, 0, W, H); c.fillStyle = 'rgba(40, 120, 190, 0.12)'; c.fillRect(0, 0, W, H); // brillo azulado de pantalla
    c.font = '11px ui-monospace, Menlo, Consolas, monospace'; c.textBaseline = 'top';
    for (let i = 0; i * lh - lens.scroll < H && lens.lines.length; i++) {
      const line = lens.lines[i % lens.lines.length];
      c.fillStyle = LENS_COLORS[(line.length + i) % LENS_COLORS.length]; c.fillText(line, 8, i * lh - lens.scroll);
    }
    lens.tex.needsUpdate = true;
  }

  // Encuadre: la cabeza completa cabe tanto en horizontal como en vertical (kiosco).
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(size.y / 2 / t, size.x / 2 / (t * camera.aspect)) * 1.2;
    camera.position.set(0, center.y + size.y * 0.02, center.z + dist); camera.lookAt(0, center.y - size.y * 0.02, center.z);
    camera.updateProjectionMatrix();
  }
  {
    const dark = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.55 }), color = new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.4 });
    const rx = size.x * 0.5 * PHONES.x, top = size.y * 0.5 * PHONES.top, earY = center.y + size.y * PHONES.earY, zc = center.z + size.z * PHONES.z;
    const band = new THREE.Mesh(new THREE.TorusGeometry(rx, size.x * 0.035, 10, 40, Math.PI), dark);
    band.scale.y = (center.y + top - earY) / rx; band.position.set(0, earY, zc);
    phones.add(band);
    for (const side of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(size.y * 0.13, size.y * 0.13, size.x * 0.09, 28), color);
      cup.rotation.z = Math.PI / 2; cup.scale.z = 0.8; cup.position.set(side * rx, earY, zc);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(size.y * 0.145, size.y * 0.145, size.x * 0.04, 28), dark);
      pad.rotation.z = Math.PI / 2; pad.scale.z = 0.8; pad.position.set(side * (rx - size.x * 0.05), earY, zc);
      phones.add(cup, pad);
    }
    pivot.add(phones);
  }
  resize(); window.addEventListener('resize', resize); window.addEventListener('orientationchange', resize);

  let state = 'idle', clock = 0;
  let blinkAt = rnd(1, 3), blinkT = -1;
  let gazeAt = 0; const gaze = { x: 0, y: 0 }, gazeGoal = { x: 0, y: 0 };
  let browPulse = 0, brow = 0, smile = 0;
  const head = { x: 0, y: 0, z: 0 };
  // Reaccion del momento (sorpresa, alegria, risa, pena, pensativo): dura unos segundos y se mezcla con lo demas.
  const expr = { name: '', t: 0, dur: 2.8 }; let exprK = 0;
  const exprMouth = {};
  // Seguimiento del puntero (mouse o dedo), como el Memoji: la cabeza y los ojos giran hacia donde esta.
  const pointer = { x: 0, y: 0, at: -100 }, follow = { x: 0, y: 0 };
  const onPointer = (ev) => {
    pointer.x = Math.max(-1, Math.min(1, (ev.clientX / window.innerWidth) * 2 - 1));
    pointer.y = Math.max(-1, Math.min(1, 1 - (ev.clientY / window.innerHeight) * 2));
    pointer.at = clock;
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });

  function update(dt) {
    clock += dt;
    // Parpadeo a intervalos irregulares (a veces doble).
    if (blinkT < 0 && clock >= blinkAt) blinkT = 0;
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt; const d = 0.16;
      blink = blinkT < d ? Math.sin((blinkT / d) * Math.PI) : 0;
      if (blinkT >= d) { blinkT = -1; blinkAt = clock + (Math.random() < 0.18 ? rnd(0.12, 0.25) : rnd(1.8, 5.5)); }
    }

    // Mirada: hacia la camara, con pequenos saltos; al pensar se va hacia arriba y a un lado.
    if (clock >= gazeAt) {
      gazeAt = clock + rnd(0.7, 2.6);
      if (state === 'thinking') { gazeGoal.x = rnd(-0.22, -0.12); gazeGoal.y = rnd(0.18, 0.3) * (Math.random() < 0.5 ? -1 : 1); }
      else if (state === 'idle') { gazeGoal.x = rnd(-0.08, 0.06); gazeGoal.y = rnd(-0.3, 0.3); } // en espera: mira alrededor
      else { gazeGoal.x = rnd(-0.025, 0.025); gazeGoal.y = rnd(-0.04, 0.04); }
    }
    const kg = 1 - Math.exp(-dt / 0.05); gaze.x += (gazeGoal.x - gaze.x) * kg; gaze.y += (gazeGoal.y - gaze.y) * kg;

    // Cabeza: respiracion lenta siempre; cada estado agrega su gesto. Nunca queda inmovil.
    const speaking = state === 'speaking', listening = state === 'listening', thinking = state === 'thinking';
    const goal = {
      x: Math.sin(clock * 0.9) * 0.012 + (speaking ? Math.sin(clock * 3.1) * 0.02 : 0) + (listening ? 0.035 : 0) + (thinking ? -0.04 : 0),
      y: Math.sin(clock * 0.43) * 0.035 + (speaking ? Math.sin(clock * 1.7) * 0.03 : 0) + (thinking ? 0.09 : 0),
      z: Math.sin(clock * 0.31) * 0.012 + (listening ? 0.03 : 0) + (thinking ? -0.035 : 0),
    };
    if (state === 'idle') { goal.y += Math.sin(clock * 0.23) * 0.2; goal.x += Math.sin(clock * 0.17) * 0.04; } // en espera: gira despacio buscando a alguien
    // Actividades de la suspension: cada una entra y sale con un fundido.
    actT += dt;
    const ease = (v, to, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
    sleepK = ease(sleepK, act === 'dormir' && !expr.name ? 1 : 0, act === 'dormir' && !expr.name ? 0.7 : 0.12); // un sobresalto le abre los ojos
    musicK = ease(musicK, act === 'musica' ? 1 : 0, 0.35);
    readK = ease(readK, act === 'leer' ? 1 : 0, 0.4);
    if (sleepK > 0.01) { const nod = (actT * 0.2) % 1; goal.x += (0.09 + nod * nod * 0.17) * sleepK; goal.z += 0.1 * sleepK; goal.y *= 1 - 0.7 * sleepK; } // cabecea: cae despacio y se endereza
    if (musicK > 0.01) { goal.x += Math.sin(actT * 9.4) * 0.045 * musicK; goal.z += Math.sin(actT * 4.7) * 0.06 * musicK; }            // lleva el ritmo
    if (readK > 0.01) { goal.x += 0.11 * readK; goal.y *= 1 - 0.6 * readK; gazeGoal.x = 0.1 * readK; gazeGoal.y = (0.13 - ((actT % 2.4) / 2.4) * 0.26) * readK; } // recorre los renglones
    phones.visible = musicK > 0.03; phones.scale.setScalar(0.6 + 0.4 * musicK);
    // Si el puntero lleva un rato quieto, vuelve a mirar al frente.
    const active = clock - pointer.at < 4 ? 1 : 0;
    const kf = 1 - Math.exp(-dt / 0.12);
    follow.x += (pointer.x * active - follow.x) * kf; follow.y += (pointer.y * active - follow.y) * kf;
    goal.y += follow.x * 0.5; goal.x += -follow.y * 0.32; goal.z += -follow.x * 0.06;
    // Reaccion: entra rapido, se sostiene y sale suave.
    if (expr.name) { expr.t += dt; if (expr.t >= expr.dur) expr.name = ''; }
    const env = expr.name ? Math.min(1, expr.t / 0.18) * Math.min(1, (expr.dur - expr.t) / 0.6) : 0;
    exprK += (env - exprK) * (1 - Math.exp(-dt / 0.07));
    const e = expr.name, k = exprK;
    let exBrow = 0, exSmile = 0, exBlink = 0, exSad = 0, exFrown = 0, back = 0, lift = 0; exprMouth.viseme_O = 0;
    if (e === 'sorpresa') { exBrow = 1; exprMouth.viseme_O = 0.55 * k; back = 0.16; goal.x += -0.07 * k; }
    else if (e === 'alegria') { exSmile = 1; exBrow = 0.35; goal.z += 0.07 * k; lift = Math.abs(Math.sin(expr.t * 7)) * 0.035; }
    else if (e === 'risa') { exSmile = 1; exBlink = 0.4; goal.x += Math.sin(expr.t * 16) * 0.05 * k; lift = Math.abs(Math.sin(expr.t * 16)) * 0.02; }
    else if (e === 'celebracion') { exSmile = 1; exBrow = 0.7; lift = Math.abs(Math.sin(expr.t * 9)) * 0.06; goal.z += Math.sin(expr.t * 9) * 0.05 * k; }
    else if (e === 'despedida') { exSmile = 0.9; exBrow = 0.3; goal.z += Math.sin(expr.t * 6) * 0.09 * k; goal.x += 0.05 * k; }
    else if (e === 'dinero') { exBrow = 0.6; exSmile = 0.6; }
    else if (e === 'pena') { exSad = 1; exBlink = 0.22; goal.x += 0.11 * k; goal.z += -0.05 * k; }
    else if (e === 'pensativo') { exFrown = 0.35; exBrow = 0.3; goal.z += 0.08 * k; goal.y += 0.1 * k; gazeGoal.x = -0.2; gazeGoal.y = 0.22; }
    pivot.position.set(0, lift * k, -back * k);
    setMorph('mouthSad', exSad * k); setMorph('browSad', exSad * k); setMorph('browDown', exFrown * k); // expresiones agregadas al modelo
    const kh = 1 - Math.exp(-dt / 0.14);
    head.x += (goal.x - head.x) * kh; head.y += (goal.y - head.y) * kh; head.z += (goal.z - head.z) * kh;
    pivot.rotation.set(head.x, head.y, head.z);
    // Los ojos compensan el giro de la cabeza para seguir mirando a la camara.
    for (const e of [eyeL, eyeR]) if (e) e.rotation.set(gaze.x - follow.y * 0.16, gaze.y + follow.x * 0.26, 0);

    // Cejas: pulso al iniciar una frase; algo levantadas al escuchar.
    browPulse = Math.max(0, browPulse - dt / 0.6);
    const browGoal = Math.max(browPulse > 0 ? Math.sin(Math.min(1, browPulse) * Math.PI) * 0.8 : 0, listening ? 0.22 : 0, thinking ? 0.12 : 0);
    brow += (browGoal - brow) * (1 - Math.exp(-dt / 0.08)); setMorph('browUp', Math.max(brow, exBrow * k));
    setMorph('eyeBlink', Math.min(1, Math.max(blink * 1.05, exBlink * k, sleepK, musicK * 0.3)));
    exprMouth.viseme_aa = 0.1 * sleepK; // duerme con la boca un poco abierta
    const smileGoal = listening ? 0.25 : (state === 'idle' ? 0.15 : 0);
    smile += (smileGoal - smile) * (1 - Math.exp(-dt / 0.3)); setMorph('mouthSmile', Math.max(smile * (1 - exSad * k), exSmile * k, musicK * 0.5));

    if (lens.mat) { // el reflejo entra y sale con un fundido
      lens.k += ((readK > 0.5 ? 1 : 0) - lens.k) * (1 - Math.exp(-dt / 0.5));
      lens.mesh.visible = lens.k > 0.01; lens.mat.opacity = lens.k * (0.62 + Math.sin(clock * 7) * 0.04);
      if (lens.mesh.visible && clock - lens.at > 1 / 15) { drawLens(clock - lens.at); lens.at = clock; }
    }
    // Alerta: fundido de ~0,6 s hacia el rojo (o de vuelta al azul); solo se repintan los materiales mientras cambia.
    alertK += ((alertOn ? 1 : 0) - alertK) * (1 - Math.exp(-dt / 0.25));
    if (Math.abs(alertK - alertShown) > 0.002) paintAlert();
    // La llama crece un poco al hablar (y con una alerta abierta) y se apaga casi del todo al dormir.
    const firePower = (speaking ? 1.12 : 1) * (1 + 0.15 * alertK) * (1 - 0.45 * sleepK);
    flame?.update(dt, clock, firePower, alertK);
    flame2?.update(dt, clock + 7.3, firePower, alertK, alertK); // el otro ojo se enciende solo con la alerta (desfasado para que no sea un calco)
    renderer.render(scene, camera);
  }

  return {
    update, setMorph,
    setState(s) { if (s !== state) { state = s; gazeAt = 0; } },
    raiseBrows() { browPulse = 1; },
    react(name) { expr.name = name; expr.t = 0; },
    /** Alerta de seguridad abierta (true) o resuelta (false): ojos, llama y cresta en rojo o en azul. */
    setAlert(on) { alertOn = !!on; },
    /** Actividad del modo suspension: 'dormir' | 'leer' | 'musica' | null. */
    setActivity(name) {
      if (name !== act) { act = name; actT = 0; }
      if (name === 'leer' && !lens.lines.length) lens.lines = ['function descansar() {', '  while (!meLlaman) {', '    leer(unPoco);', '  }', '}', '// no molestar', 'const idea = pensar();'];
    },
    /** Mirar hacia un punto de la pantalla (-1..1), igual que si fuera el puntero. */
    look(x, y) { pointer.x = x; pointer.y = y; pointer.at = clock; },
    /** Forma de boca que pide la reaccion (se combina con el lip sync). */
    exprMouth,
    morphNames: [...morphs.keys()],
  };
}
