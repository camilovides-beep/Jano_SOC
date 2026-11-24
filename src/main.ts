import 'reflect-metadata';
import { existsSync } from 'node:fs';
// En local las claves vienen de .env; en produccion, del entorno del contenedor.
if (existsSync('.env')) process.loadEnvFile('.env');

// Los archivos que crea el avatar (interesados, dispositivos, grabaciones) son solo para su usuario.
process.umask(0o077);

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // el cuerpo crudo se usa para validar la firma del webhook
  app.useWebSocketAdapter(new WsAdapter(app));
  // Entrada de logs (POST /logs/<fuente>): ademas de JSON acepta texto, una linea por evento.
  app.useBodyParser('text', { type: ['text/plain', 'application/x-ndjson'], limit: '1mb' });
  // Consola SOC: sus respuestas llevan datos de seguridad, asi que no se guardan en cache ni se muestran dentro de otro sitio.
  app.use('/soc', (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.enableShutdownHooks();
  const cfg = app.get(ConfigService);
  await app.listen(cfg.port, '0.0.0.0');
  new Logger('main').log(`escuchando en el puerto ${cfg.port}`);
}
bootstrap().catch((e) => { console.error(`No se pudo arrancar: ${e.message}`); process.exit(1); });
