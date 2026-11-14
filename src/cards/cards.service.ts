import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as QRCode from 'qrcode';
import { ConfigService } from '../config/config.service';

export interface Card { title: string; lines: string[]; qr?: string; caption?: string; }

/**
 * Tarjetas que el avatar muestra en pantalla mientras habla: una por servicio (content/tarjetas.json) y una de contacto
 * con codigo QR (CONTACT_URL). El modelo las pide con la etiqueta [c:id].
 */
@Injectable()
export class CardsService {
  private readonly log = new Logger(CardsService.name);
  private readonly cards: Record<string, { titulo: string; puntos: string[] }> = {};
  private qr = '';

  constructor(private readonly cfg: ConfigService) {
    const file = cfg.cardsFile;
    try { if (existsSync(file)) this.cards = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { this.log.error(`No se pudo leer ${file}: ${(e as Error).message}`); }
    if (cfg.contactUrl) {
      QRCode.toDataURL(cfg.contactUrl, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
        .then((d) => (this.qr = d)).catch((e) => this.log.error(`No se pudo generar el QR: ${e.message}`));
    }
  }

  /** Identificadores que el modelo puede usar (incluye "contacto" solo si hay direccion configurada). */
  ids(): string[] { return this.cfg.cardsEnabled ? [...Object.keys(this.cards), ...(this.cfg.contactUrl ? ['contacto'] : [])] : []; }

  get(id: string): Card | null {
    if (!this.cfg.cardsEnabled) return null;
    if (id === 'contacto') {
      if (!this.qr) return null;
      return { title: this.cfg.contactTitle, lines: [], qr: this.qr, caption: this.cfg.contactCaption };
    }
    const c = this.cards[id];
    if (!c) return null;
    return { title: c.titulo, lines: c.puntos ?? [], qr: this.qr || undefined, caption: this.qr ? this.cfg.contactCaption : undefined };
  }
}
