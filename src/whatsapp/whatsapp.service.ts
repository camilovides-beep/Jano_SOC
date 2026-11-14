import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

/** Texto de la variable {{2}} de la plantilla segun el interes guardado. */
const INTEREST_TEXT: Record<string, string> = {
  chatbots: 'un chatbot con inteligencia artificial',
  agentes_de_voz: 'un agente de voz',
  bots_de_whatsapp: 'un bot de WhatsApp para pedidos y ventas',
  automatizacion: 'automatizar procesos de tu negocio',
  dashboards: 'un dashboard con tus indicadores',
  despliegue_y_servidores: 'el despliegue de tus sistemas',
  desarrollo_de_software: 'un desarrollo de software a la medida',
  otro: 'una solución a la medida',
};

/**
 * Convierte el contacto dictado en un numero internacional. Devuelve '' si no es un telefono (por ejemplo un correo).
 * Un celular colombiano de 10 digitos (empieza por 3) recibe el indicativo +57.
 */
export function toPhone(contact: string, defaultCountry: string): string {
  if (contact.includes('@')) return '';
  const plus = contact.trim().startsWith('+');
  const digits = contact.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  if (plus) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith('3')) return `+${defaultCountry}${digits}`;
  if (digits.length > 10) return `+${digits}`; // ya trae indicativo
  return '';
}

/**
 * Envio de la plantilla de bienvenida por la API de WhatsApp Cloud (Meta). Verificado con la documentacion el 2026-11-13:
 *  POST https://graph.facebook.com/{version}/{phone-number-id}/messages, "Authorization: Bearer <token>",
 *  type "template", language.code, components: header (imagen por enlace) y body (parametros de texto en orden).
 *  Respuesta 200 = Meta acepto el envio (no garantiza entrega). Errores en error.code / error.error_data.details.
 */
@Injectable()
export class WhatsAppService {
  private readonly log = new Logger(WhatsAppService.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled() { return !!(this.cfg.whatsappToken && this.cfg.whatsappPhoneNumberId && this.cfg.whatsappTemplate); }

  /** Envia la plantilla. Devuelve '' si Meta la acepto, o el motivo por el que no se envio. */
  async sendWelcome(contact: string, name: string, interest: string): Promise<string> {
    if (!this.enabled) return 'WhatsApp no está configurado';
    const to = toPhone(contact, this.cfg.whatsappDefaultCountry);
    if (!to) return 'el contacto no es un número de WhatsApp';
    const components: unknown[] = [];
    if (this.cfg.whatsappHeaderImageUrl) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: this.cfg.whatsappHeaderImageUrl } }] });
    components.push({ type: 'body', parameters: [{ type: 'text', text: name.split(/\s+/)[0] || name }, { type: 'text', text: INTEREST_TEXT[interest] ?? INTEREST_TEXT.otro }] });
    try {
      const res = await fetch(`https://graph.facebook.com/${this.cfg.whatsappApiVersion}/${this.cfg.whatsappPhoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.whatsappToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name: this.cfg.whatsappTemplate, language: { code: this.cfg.whatsappTemplateLang }, components } }),
        signal: AbortSignal.timeout(8000),
      });
      const d: any = await res.json().catch(() => ({}));
      if (res.ok && d.messages?.[0]?.id) { this.log.log(`plantilla de WhatsApp aceptada por Meta`); return ''; }
      const e = d.error ?? {};
      const why = `Meta respondió ${res.status}${e.code ? ` (código ${e.code})` : ''}: ${e.error_data?.details ?? e.message ?? 'sin detalle'}`;
      this.log.warn(`plantilla de WhatsApp no enviada: ${why}`);
      return why;
    } catch (e) { return `no se pudo conectar con WhatsApp: ${(e as Error).name}`; }
  }
}
