import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string> | string;
}

/** Registro de herramientas (function calling). Para agregar una: sumarla a `tools` con su esquema y su ejecutor. */
@Injectable()
export class ToolsService {
  private readonly tools: Record<string, Tool>;
  constructor(cfg: ConfigService) {
    this.tools = {
      hora_actual: {
        description: 'Devuelve la fecha y la hora actuales. Usala cuando pregunten que hora es o que dia es hoy.',
        parameters: { type: 'object', properties: {}, required: [] },
        run: () =>
          new Intl.DateTimeFormat('es-CO', { timeZone: cfg.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date()),
      },
    };
  }
  /** Definiciones en el formato de la API (compatible con OpenAI). */
  definitions() {
    return Object.entries(this.tools).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));
  }
  async run(name: string, rawArgs: string): Promise<string> {
    const tool = this.tools[name];
    if (!tool) return `Error: la herramienta ${name} no existe.`;
    let args: Record<string, unknown> = {};
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return 'Error: argumentos invalidos.'; }
    try { return String(await tool.run(args)); } catch (e) { return `Error: ${(e as Error).message}`; }
  }
}
