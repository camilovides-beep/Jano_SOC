import 'reflect-metadata';
import { ConfigService } from '../config/config.service';
import { CapableModelService, PRESETS } from './capable.service';

/**
 * `npm run probar-modelo`: prueba de verdad el modelo capaz configurado (MODELO_CAPAZ_*). Hace una pregunta, luego le
 * ofrece una herramienta, le devuelve el resultado y espera la respuesta final: lo mismo que ocurre en un encargo.
 * Gasta unas pocas llamadas en ese proveedor. No muestra la clave.
 */
async function main() {
  try { process.loadEnvFile('.env'); } catch { /* sin .env: variables del entorno */ }
  const cfg = new ConfigService(), model = new CapableModelService(cfg, { add() {} } as any);
  if (!model.enabled) { console.log(`No hay modelo capaz que probar: ${model.problem || 'define MODELO_CAPAZ_PROVEEDOR, MODELO_CAPAZ y MODELO_CAPAZ_KEY'}.`); process.exit(1); }
  console.log(`Probando ${model.label}\n(${PRESETS[cfg.capableProvider].verified})\n`);
  const run = async (messages: unknown[], tools: unknown[]) => {
    const t0 = Date.now(); let first = 0, text = '', calls: { id: string; name: string; arguments: string }[] = [];
    for await (const ev of model.chat(messages, tools, AbortSignal.timeout(90_000), 2000)) { first ||= Date.now() - t0; if (ev.type === 'text') text += ev.delta; else calls = ev.calls; }
    return { first, total: Date.now() - t0, text: text.trim(), calls };
  };
  const system = { role: 'system', content: 'Eres un asistente breve. Responde en español en una frase.' };
  let ok = true;
  const step = async (name: string, fn: () => Promise<string>) => { try { console.log(` ✓ ${name}\n     ${await fn()}`); } catch (e) { ok = false; console.log(` ✗ ${name}\n     ${(e as Error).message.slice(0, 500)}`); } };

  await step('Responde una pregunta', async () => {
    const r = await run([system, { role: 'user', content: '¿Cuál es la capital de Colombia?' }], []);
    if (!/bogot/i.test(r.text)) throw new Error(`respuesta inesperada: «${r.text.slice(0, 200)}»`);
    return `primer texto a los ${r.first} ms, completo en ${r.total} ms: «${r.text.slice(0, 120)}»`;
  });
  const tools = [{ type: 'function', function: { name: 'hora_actual', description: 'Devuelve la fecha y la hora actuales.', parameters: { type: 'object', properties: {}, required: [] } } }];
  await step('Usa una herramienta y responde con su resultado', async () => {
    const history: unknown[] = [system, { role: 'user', content: '¿Qué hora es? Usa la herramienta para saberlo.' }];
    const a = await run(history, tools);
    if (!a.calls.some((c) => c.name === 'hora_actual')) throw new Error(`no pidió la herramienta; dijo: «${a.text.slice(0, 200)}»`);
    history.push({ role: 'assistant', content: a.text || null, tool_calls: a.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) });
    for (const c of a.calls) history.push({ role: 'tool', tool_call_id: c.id, content: 'Son las 3:47 de la tarde del miércoles.' });
    const b = await run(history, tools);
    if (!/3[:.]47|tres y cuarenta/i.test(b.text)) throw new Error(`no usó el resultado de la herramienta: «${b.text.slice(0, 200)}»`);
    return `pidió la herramienta a los ${a.first} ms y respondió: «${b.text.slice(0, 120)}»`;
  });
  console.log(ok ? '\nEl modelo sirve para los encargos. Enciéndelo en el panel: Decisiones → Enrutamiento.' : '\nAlgo falló. Revisa el nombre del modelo, la clave y, si hace falta, MODELO_CAPAZ_EXTRA o MODELO_CAPAZ_URL.');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('No se pudo probar:', (e as Error).message); process.exit(1); });
