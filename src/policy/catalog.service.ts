import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { AlertsService } from '../ops/alerts.service';

export interface CatalogItem { id: number; name: string; description: string; price: number; currency: string; unit: string; active: number; updated_at: string }
export interface CatalogInput { name?: string; description?: string; price?: number; currency?: string; unit?: string; active?: boolean }
const CURRENCIES = ['COP', 'USD'];
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const NUM_WORDS = 'un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil|mill[oó]n|millones';
/** Un simbolo o codigo de moneda pegado a una cifra: "$ 1.200.000", "USD 300", "300 USD", "500€". */
const SYMBOL = /(?:\$|us\$|usd|cop|€)\s?\d[\d.,]*|\d[\d.,]*\s?(?:usd|cop|€)/gi;
/** Una cantidad (en cifras o en palabras) seguida, a pocas palabras, de una moneda: "dos millones de pesos", "800 mil pesos". */
const WORDS = new RegExp(`(?:\\d[\\d.,]*|\\b(?:${NUM_WORDS})\\b)(?:\\s+(?:${NUM_WORDS}|y|de|con))*\\s+(?:de\\s+)?(?:pesos|d[oó]lares|euros)\\b`, 'gi');

/** Los trozos de un texto que parecen un precio. Vacio = no menciona dinero. */
export function findPrices(text: string): string[] {
  const t = String(text ?? '');
  return [...new Set([...(t.match(SYMBOL) ?? []), ...(t.match(WORDS) ?? [])].map((m) => m.trim()))];
}
/** La cifra de un precio escrito con numeros ("$ 1.200.000" -> 1200000; "800 mil pesos" -> 800000). null si viene en palabras. */
export function amountOf(price: string): number | null {
  const m = price.match(/\d[\d.,]*/);
  if (!m) return null;
  let raw = m[0].replace(/[.,]+$/, '');
  // Punto o coma seguido de exactamente tres cifras = separador de miles; si no, decimales.
  raw = /^\d{1,3}([.,]\d{3})+$/.test(raw) ? raw.replace(/[.,]/g, '') : raw.replace(',', '.');
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (/\bmillones\b|\bmill[oó]n\b/i.test(price)) n *= 1_000_000; else if (/\bmil\b/i.test(price)) n *= 1000;
  return n;
}

/**
 * Catalogo de precios (etapa 2c, pedido por Javier el 2026-11-18). Es OPCIONAL y arranca vacio. Mientras este vacio,
 * minijavi no menciona precios ni envia ofertas, sin excepcion: si alguien pregunta, se le dice que Javier le prepara la
 * cotizacion. Al cargar el catalogo en el panel se habilitan esos precios, y solo esos, sin tocar codigo.
 * La regla se impone con `violation()`: un texto que trae un precio que no esta en el catalogo no sale.
 */
@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly log = new Logger(CatalogService.name);
  private items: CatalogItem[] = [];
  private lastAlert = 0;
  constructor(private readonly cfg: ConfigService, private readonly db: DbService, private readonly alerts: AlertsService) {}

  async onModuleInit() { try { await this.reload(); if (this.items.length) this.log.log(`catálogo: ${this.active().length} precios activos`); } catch (e) { this.log.warn(`no se pudo leer el catálogo: ${(e as Error).message}`); } }
  private async reload() { this.items = await this.db.query<CatalogItem>('SELECT * FROM catalog WHERE business = $1 ORDER BY name', [this.cfg.businessId]); }

  list() { return this.items; }
  active() { return this.items.filter((i) => Number(i.active)); }
  get empty() { return this.active().length === 0; }

  async save(input: CatalogInput, id?: number): Promise<CatalogItem> {
    const cur = id ? this.items.find((i) => i.id === id) : undefined;
    if (id && !cur) throw new Error('ese precio no existe');
    const name = input.name === undefined ? cur?.name ?? '' : clip(input.name, 100), description = input.description === undefined ? cur?.description ?? '' : clip(input.description, 300);
    const price = input.price === undefined ? Number(cur?.price ?? NaN) : Number(input.price), currency = (input.currency === undefined ? cur?.currency ?? 'COP' : clip(input.currency, 3)).toUpperCase();
    const unit = input.unit === undefined ? cur?.unit ?? '' : clip(input.unit, 60), active = input.active === undefined ? Number(cur?.active ?? 1) : input.active ? 1 : 0, now = new Date().toISOString();
    if (name.length < 3) throw new Error('falta el nombre de lo que se vende');
    if (!Number.isFinite(price) || price <= 0 || price > 1e12) throw new Error('el precio debe ser un número mayor que cero');
    if (!CURRENCIES.includes(currency)) throw new Error(`la moneda debe ser ${CURRENCIES.join(' o ')}`);
    if (cur) await this.db.query('UPDATE catalog SET name = $1, description = $2, price = $3, currency = $4, unit = $5, active = $6, updated_at = $7 WHERE id = $8 AND business = $9', [name, description, price, currency, unit, active, now, cur.id, this.cfg.businessId]);
    else id = (await this.db.query<{ id: number }>('INSERT INTO catalog (business, name, description, price, currency, unit, active, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [this.cfg.businessId, name, description, price, currency, unit, active, now]))[0].id;
    await this.reload();
    return this.items.find((i) => i.id === id)!;
  }
  async remove(id: number): Promise<boolean> { const ok = (await this.db.query('DELETE FROM catalog WHERE id = $1 AND business = $2 RETURNING id', [id, this.cfg.businessId])).length > 0; await this.reload(); return ok; }

  /**
   * ¿Este texto dice un precio que no se puede decir? '' = no hay problema. Con el catalogo vacio, cualquier precio es
   * una falta. Con catalogo, cada cifra debe ser el precio de algo activo; un precio escrito en palabras no se puede
   * comprobar y cuenta como falta.
   */
  violation(text: string): string {
    const found = findPrices(text);
    if (!found.length) return '';
    if (this.empty) return `menciona un precio («${found[0]}») y no hay catálogo de precios`;
    const allowed = new Set(this.active().map((i) => Number(i.price)));
    const bad = found.find((p) => { const n = amountOf(p); return n === null || !allowed.has(n); });
    return bad ? `menciona un precio que no está en el catálogo («${bad}»)` : '';
  }

  /**
   * Lo que el avatar DIJO en una conversacion. La voz sale frase por frase y no se puede frenar sin volverla lenta, asi
   * que aqui no se bloquea: si se le escapo un precio fuera del catalogo, Javier recibe un aviso (uno cada 10 minutos).
   * Devuelve la falta ('' si no hubo).
   */
  spoken(text: string, where: string): string {
    const why = this.violation(text);
    if (!why) return '';
    this.log.warn(`${where}: el avatar ${why}`);
    if (Date.now() - this.lastAlert > 600_000) { this.lastAlert = Date.now(); void Promise.resolve().then(() => this.alerts.send(`💬 En ${where} dije algo que ${why}. Revísalo: «${text.replace(/\s+/g, ' ').slice(0, 260)}»`)).catch(() => undefined); }
    return why;
  }

  /** Reglas de precios para el prompt de una conversacion. */
  prompt(): string {
    if (this.empty) return `

PRECIOS: no tienes precios autorizados. NO digas ningún precio, tarifa, rango ni cifra de dinero por tus servicios, ni aproximada ni "desde", aunque insistan. Si preguntan cuánto cuesta algo, di que Javier le prepara la cotización según lo que necesita, y usa la herramienta pedir_cotizacion para dejarlo anotado (si aún no tienes sus datos, pídelos primero como siempre).`;
    return `

PRECIOS: estos son los ÚNICOS precios que puedes decir, exactos y sin redondear ni inventar descuentos:
${this.active().slice(0, 30).map((i) => `- ${i.name}: ${Number(i.price).toLocaleString('es-CO')} ${i.currency}${i.unit ? ` ${i.unit}` : ''}${i.description ? ` (${i.description})` : ''}`).join('\n')}
Para cualquier otra cosa, o algo a la medida, di que Javier le prepara la cotización y usa la herramienta pedir_cotizacion.`;
  }
}
