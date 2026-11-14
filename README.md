# minijavi

Avatar 3D de Javier que conversa por voz en español: escucha por el micrófono (Deepgram), piensa (DeepSeek),
responde hablando (ElevenLabs) y mueve la boca sincronizada con el audio. Un solo servicio NestJS sirve la página
(Three.js), `/health` y el WebSocket.

## Correr en local
```
cp .env.example .env    # completar las claves
npm install
npm run dev             # http://localhost:3000
```
El micrófono solo funciona en `localhost` o bajo HTTPS.

## Variables de entorno
Todas están documentadas en `.env.example`. Obligatorias: `DEEPGRAM_API_KEY`, `DEEPSEEK_API_KEY`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`. Las claves viven solo en el backend.

## Desplegar en Easypanel (servicio App desde GitHub)
1. Crear un servicio **App** y en **Source** elegir **GitHub**: repositorio `jadaheto/minijavi`, rama `main`.
2. En **Build** elegir **Dockerfile** (ruta `Dockerfile`).
3. En **Environment** cargar las variables de `.env.example` con sus valores (`PORT=3000`).
4. En **Domains** asignar el dominio con HTTPS apuntando al puerto `3000`. El WebSocket usa la misma URL (`wss`).
5. **Deploy** y verificar: `https://<dominio>/health` responde `{"status":"ok"}` y la página carga el avatar.

## Estructura
- `src/session` gateway WebSocket y orquestación de cada turno · `src/stt` Deepgram · `src/llm` DeepSeek ·
  `src/tts` ElevenLabs · `src/tools` herramientas (function calling) · `src/config` variables.
- `public/` página estática: visor (`avatar.js`), lip sync (`lipsync.js`), audio (`audio.js`), micrófono (`mic.js`).
- `prompts/system.md` personalidad por defecto.
