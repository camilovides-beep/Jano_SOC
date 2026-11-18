import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { ConfigService } from './config/config.service';
import { HealthController } from './health/health.controller';
import { SessionGateway } from './session/session.gateway';
import { DeepSeekService } from './llm/deepseek.service';
import { DeepgramService } from './stt/deepgram.service';
import { ToolsService } from './tools/tools.service';
import { OwnerController } from './owner/owner.controller';
import { OwnerService } from './owner/owner.service';
import { PlaneMcpService } from './mcp/plane-mcp.service';
import { LeadsService } from './leads/leads.service';
import { CardsService } from './cards/cards.service';
import { CallsController } from './calls/calls.controller';
import { KnowledgeService } from './knowledge/knowledge.service';
import { KnowledgeController } from './knowledge/knowledge.controller';
import { N8nController } from './n8n/n8n.controller';
import { WorkshopService } from './workshop/workshop.service';
import { MusicService } from './music/music.service';
import { SitesController } from './workshop/sites.controller';
import { WhatsAppService } from './whatsapp/whatsapp.service';
import { MemoryService } from './memory/memory.service';
import { ElevenLabsService } from './tts/elevenlabs.service';
import { UsageService } from './usage/usage.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/health', '/owner/{*path}', '/webhooks/{*path}', '/knowledge/{*path}', '/n8n/{*path}', '/p/{*path}', '/formulario'],
    }),
  ],
  controllers: [HealthController, OwnerController, CallsController, KnowledgeController, N8nController, SitesController],
  providers: [ConfigService, UsageService, WorkshopService, MusicService, ElevenLabsService, DeepgramService, DeepSeekService, ToolsService, OwnerService, PlaneMcpService, WhatsAppService, KnowledgeService, LeadsService, CardsService, MemoryService, SessionGateway],
})
export class AppModule {}
