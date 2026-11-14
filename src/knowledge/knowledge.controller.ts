import { Body, Controller, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ConfigService } from '../config/config.service';
import { KnowledgeService } from './knowledge.service';

/**
 * Busqueda en la base de conocimiento para sistemas externos (n8n). Solo devuelve contenido PUBLICO.
 * Se protege con la cabecera X-Forward-Secret = N8N_SECRET. Existe porque los embeddings de NVIDIA exigen `input_type`
 * y el nodo de embeddings de n8n no lo envia: el avatar hace la consulta con el modelo correcto.
 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly cfg: ConfigService, private readonly kb: KnowledgeService) {}

  @Post('search')
  @HttpCode(200)
  async search(@Req() req: Request, @Body() body: { query?: string }) {
    const got = Buffer.from(String(req.headers['x-forward-secret'] ?? '')), want = Buffer.from(this.cfg.n8nSecret);
    if (!this.cfg.n8nSecret || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpException('no autorizado', 401);
    const query = String(body?.query ?? '').trim().slice(0, 1000);
    if (!query || !this.kb.enabled) return { context: '', hits: [] };
    const hits = await this.kb.search(query, false).catch(() => []);
    return {
      context: hits.map((h) => `- ${h.text.replace(/\s+/g, ' ')}`).join('\n'),
      hits: hits.map((h) => ({ text: h.text, source: h.source, score: Number(h.score.toFixed(3)) })),
    };
  }
}
