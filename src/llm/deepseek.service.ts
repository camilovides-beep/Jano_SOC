import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { UsageService } from '../usage/usage.service';

export interface ToolCall { id: string; name: string; arguments: string; }
export type LlmEvent = { type: 'text'; delta: string } | { type: 'tool_calls'; calls: ToolCall[] };

/**
 * DeepSeek en streaming (API compatible con OpenAI; verificado con la documentacion el 2026-11-13):
 *  POST https://api.deepseek.com/chat/completions, "Authorization: Bearer <clave>", stream: true (SSE, termina en [DONE]).
 *  El modo de razonamiento viene activado por defecto: se desactiva con thinking {type: "disabled"} para bajar la latencia.
 *  Las tool calls llegan por fragmentos: se unen por `index`.
 *  Con stream_options {include_usage: true} el ultimo fragmento trae `usage` (prompt_tokens, completion_tokens y
 *  prompt_cache_hit_tokens). Probado el 2026-11-18. Si la llamada se corta antes (interrupcion), ese dato no llega.
 */
@Injectable()
export class DeepSeekService {
  private readonly log = new Logger(DeepSeekService.name);
  constructor(private readonly cfg: ConfigService, private readonly usage: UsageService) {}

  /** Respuesta completa en texto (sin herramientas). */
  async complete(messages: unknown[]): Promise<string> {
    let out = '';
    for await (const ev of this.chat(messages, [], AbortSignal.timeout(15_000))) if (ev.type === 'text') out += ev.delta;
    return out;
  }

  async *chat(messages: unknown[], tools: unknown[], signal?: AbortSignal, maxTokens = 400): AsyncGenerator<LlmEvent> {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.deepseekApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.deepseekModel, messages, stream: true, thinking: { type: 'disabled' },
        max_tokens: maxTokens, stream_options: { include_usage: true }, ...(tools.length ? { tools } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      this.log.error(`DeepSeek respondio ${res.status}: ${detail}`);
      throw new Error(`DeepSeek respondio ${res.status}`);
    }
    const calls: ToolCall[] = [];
    let counted = false;
    try {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let d: any; try { d = JSON.parse(data); } catch { continue; }
        if (d.usage && !counted) {
          counted = true; this.usage.add('deepseek_calls');
          this.usage.add('deepseek_in', d.usage.prompt_tokens); this.usage.add('deepseek_cache', d.usage.prompt_cache_hit_tokens); this.usage.add('deepseek_out', d.usage.completion_tokens);
        }
        const delta = d.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: 'text', delta: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: '', name: '', arguments: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name = tc.function.name;
          if (tc.function?.arguments) c.arguments += tc.function.arguments;
        }
      }
    }
    } finally { if (!counted) this.usage.add('deepseek_sin_dato'); }
    const ready = calls.filter((c) => c && c.name);
    if (ready.length) yield { type: 'tool_calls', calls: ready };
  }
}
