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
import { MusicService } from './music/music.service';
import { WhatsAppService } from './whatsapp/whatsapp.service';
import { WaChatService } from './whatsapp/wa-chat.service';
import { SettingsService } from './settings/settings.service';
import { DecisionsService } from './decisions/decisions.service';
import { CapableModelService } from './llm/capable.service';
import { PolicyService } from './policy/policy.service';
import { ActionsService } from './policy/actions.service';
import { ApprovalsService } from './policy/approvals.service';
import { CatalogService } from './policy/catalog.service';
import { TelegramService } from './ops/telegram.service';
import { OptOutService } from './security/optout.service';
import { InjectionGuard } from './security/injection.guard';
import { SecurityAlertsService } from './security/security-alerts.service';
import { AlertsController } from './security/alerts.controller';
import { LogsService } from './logs/logs.service';
import { IngestController } from './logs/ingest.controller';
import { SyslogService } from './logs/syslog.service';
import { LogWatchService } from './logs/log-watch.service';
import { LogDbService } from './logs/log-db.service';
import { SiemService } from './logs/siem.service';
import { MemoryService } from './memory/memory.service';
import { ElevenLabsService } from './tts/elevenlabs.service';
import { UsageService } from './usage/usage.service';
import { DbService } from './db/db.service';
import { AlertsService } from './ops/alerts.service';
import { OpsService } from './ops/ops.service';
import { PortfolioService } from './portfolio/portfolio.service';
import { PortfolioImagesController } from './portfolio/images.controller';
import { VisitsService } from './visits/visits.service';
import { SocController } from './soc/soc.controller';
import { SocAuthService } from './soc/soc-auth.service';

// La consola SOC no carga nada de otros sitios: ni scripts, ni estilos, ni marcos.
const SOC_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveStaticOptions: { setHeaders: (res: any, path: string) => {
        if (!/[\\/]soc\.html$/.test(path)) return;
        res.setHeader('Content-Security-Policy', SOC_CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-cache');
      } },
      exclude: ['/soc', '/soc/{*path}', '/health', '/owner/{*path}', '/webhooks/{*path}', '/knowledge/{*path}', '/n8n/{*path}', '/imagenes/{*path}', '/alertas', '/alertas/{*path}', '/logs', '/logs/{*path}'],
    }),
  ],
  controllers: [HealthController, OwnerController, CallsController, KnowledgeController, N8nController, PortfolioImagesController, AlertsController, IngestController, SocController],
  providers: [ConfigService, DbService, AlertsService, OpsService, UsageService, PortfolioService, MusicService, ElevenLabsService, DeepgramService, DeepSeekService, ToolsService, OwnerService, PlaneMcpService, WhatsAppService, KnowledgeService, LeadsService, VisitsService, CardsService, MemoryService, SessionGateway, WaChatService, SettingsService, DecisionsService, CapableModelService, PolicyService, ActionsService, ApprovalsService, CatalogService, TelegramService, OptOutService, InjectionGuard, SecurityAlertsService, LogDbService, LogsService, SyslogService, SiemService, LogWatchService, SocAuthService],
})
export class AppModule {}
