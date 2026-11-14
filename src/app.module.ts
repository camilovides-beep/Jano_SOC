import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { ConfigService } from './config/config.service';
import { HealthController } from './health/health.controller';
import { SessionGateway } from './session/session.gateway';
import { DeepSeekService } from './llm/deepseek.service';
import { DeepgramService } from './stt/deepgram.service';
import { ToolsService } from './tools/tools.service';
import { ElevenLabsService } from './tts/elevenlabs.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/health'],
    }),
  ],
  controllers: [HealthController],
  providers: [ConfigService, ElevenLabsService, DeepgramService, DeepSeekService, ToolsService, SessionGateway],
})
export class AppModule {}
