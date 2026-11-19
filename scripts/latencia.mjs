// Mide la latencia de voz de punta a punta contra un servidor en marcha: desde que la persona termina de hablar hasta el
// primer audio de la respuesta. Envia frases grabadas (PCM 16 kHz) por el WebSocket como si fueran el microfono.
// Uso: npm run latencia -- [ws://localhost:3000/ws] [pasadas] [--guardar base|ultima]   (guarda el resultado en data/latencia)
// Las frases se generan una vez con ElevenLabs y quedan en data/latencia (fuera de git). Lee el .env sin mostrar claves.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), WebSocket = createRequire(import.meta.url)('ws');
try { process.loadEnvFile(join(root, '.env')); } catch { /* sin .env: solo sirve si las frases ya existen */ }
const args = process.argv.slice(2), gi = args.indexOf('--guardar'), saveAs = gi >= 0 ? args.splice(gi, 2)[1] : '';
const url = args[0] || `ws://localhost:${process.env.PORT || 3000}/ws`, passes = Number(args[1]) || 2, dir = join(root, 'data', 'latencia');
export const PHRASES = {
  charla1: ['charla', 'Hola, ¿cómo estás hoy?'],
  charla2: ['charla', 'Cuéntame, ¿quién eres tú?'],
  sencilla1: ['sencilla', '¿Qué servicios ofrece Javier para un negocio pequeño?'],
  sencilla2: ['sencilla', '¿Me puedes explicar qué es un agente de voz?'],
  herramienta1: ['herramienta', '¿Qué hora es en este momento?'],
  herramienta2: ['herramienta', '¿Cómo está el clima hoy en Sincelejo?'],
};
mkdirSync(dir, { recursive: true });
for (const [k, [, text]] of Object.entries(PHRASES)) {
  if (existsSync(join(dir, `${k}.pcm`))) continue;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}?output_format=pcm_16000`, { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '', 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_v4_turbo', language_code: 'es' }) });
  if (!r.ok) { console.error(`No se pudo generar la frase "${k}" (ElevenLabs respondió ${r.status}).`); process.exit(2); }
  writeFileSync(join(dir, `${k}.pcm`), Buffer.from(await r.arrayBuffer()));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(url);
let queue = Buffer.alloc(0), spoke = 0, onFirst = null, speaking = false, heard = '';
const pump = setInterval(() => { // 20 ms de audio cada 20 ms, como el microfono; silencio cuando no hay frase
  if (ws.readyState !== 1) return;
  const had = queue.length > 0, c = had ? queue.subarray(0, 640) : Buffer.alloc(640);
  queue = queue.subarray(Math.min(640, queue.length));
  ws.send(c.length < 640 ? Buffer.concat([c, Buffer.alloc(640 - c.length)]) : c);
  if (had && !queue.length) spoke = Date.now(); // se envio la ultima muestra con voz
}, 20);
ws.on('message', (m, bin) => {
  if (bin) return; let d; try { d = JSON.parse(m.toString()); } catch { return; }
  if (d.type === 'user_final') heard = d.text;
  else if (d.type === 'audio' || d.type === 'say') { if (onFirst) { onFirst(Date.now()); onFirst = null; } }
  else if (d.type === 'speech_start') speaking = true;
  else if (d.type === 'speech_end') { speaking = false; ws.send(JSON.stringify({ type: 'playback', playing: false })); }
  else if (d.type === 'error') { console.error('El servidor avisó:', d.reason); process.exit(2); }
});
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', () => rej(new Error(`no hay servidor en ${url}`))); }).catch((e) => { console.error(e.message); process.exit(2); });
ws.send(JSON.stringify({ type: 'hello' }));
await sleep(1500); const t0 = Date.now(); while (speaking || Date.now() - t0 < 2500) await sleep(200); // deja pasar el saludo
ws.send(JSON.stringify({ type: 'playback', playing: false })); await sleep(1500);
const rows = [];
for (let p = 0; p < passes; p++) for (const [k, [kind]] of Object.entries(PHRASES)) {
  heard = ''; spoke = 0;
  const first = new Promise((r) => { onFirst = r; setTimeout(() => r(0), 15000); });
  queue = readFileSync(join(dir, `${k}.pcm`));
  const t = await first, ms = t && spoke ? t - spoke : null;
  rows.push({ k, kind, ms });
  console.log(`${k.padEnd(13)} ${ms === null ? 'sin respuesta' : String(ms).padStart(5) + ' ms'}  «${heard.slice(0, 60)}»`);
  const w = Date.now(); while (speaking && Date.now() - w < 20000) await sleep(200);
  await sleep(2500);
}
clearInterval(pump); ws.close();
const stat = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? { n: s.length, mediana: s[Math.floor((s.length - 1) / 2)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))], min: s[0], max: s[s.length - 1] } : { n: 0 }; };
const out = { cuando: new Date().toISOString(), todas: stat(rows.map((r) => r.ms)) };
for (const kind of ['charla', 'sencilla', 'herramienta']) out[kind] = stat(rows.filter((r) => r.kind === kind).map((r) => r.ms));
console.log('\nLATENCIA (fin de la frase → primer audio), ms'); console.table(out);
console.log('RESULTADO ' + JSON.stringify(out));
if (/^[a-z]+$/.test(saveAs) && out.todas.n === rows.length) { writeFileSync(join(dir, `${saveAs}.json`), JSON.stringify(out)); console.log(`Guardado en data/latencia/${saveAs}.json`); }
process.exit(out.todas.n === rows.length ? 0 : 1);
