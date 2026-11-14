import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { checkN8nSecret } from '../n8n/n8n.controller';
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
    checkN8nSecret(req, this.cfg.n8nSecret);
    const query = String(body?.query ?? '').trim().slice(0, 1000);
    if (!query || !this.kb.enabled) return { context: '', hits: [] };
    // tope de 3 s: si NVIDIA o Qdrant tardan, se responde sin contexto en vez de dejar esperando a n8n
    const hits = await this.kb.search(query, false, AbortSignal.timeout(3000)).catch(() => []);
    return {
      context: hits.map((h) => `- ${h.text.replace(/\s+/g, ' ')}`).join('\n'),
      hits: hits.map((h) => ({ text: h.text, source: h.source, score: Number(h.score.toFixed(3)) })),
    };
  }
}
