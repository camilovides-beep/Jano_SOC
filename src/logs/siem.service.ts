import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ConfigService } from '../config/config.service';
import { safe, Sev } from './log-analysis';

const RANK: Record<Sev, number> = { baja: 0, media: 1, alta: 2, critica: 3 };
/** Lee "a.b.c" de un documento, venga anidado o con el punto en el nombre del campo. */
const get = (o: any, path: string): unknown => o?.[path] ?? path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
const first = (o: any, ...paths: string[]) => { for (const p of paths) { const v = get(o, p); if (v !== undefined && v !== null && v !== '') return Array.isArray(v) ? v[0] : v; } return undefined; };
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} (${c})`).join(', ');

/** Gravedad de un evento segun de donde venga: nivel de Wazuh (0 a 15), severidad de Suricata (1 a 3) o texto de Elastic. */
export function siemSeverity(doc: any): Sev {
  const wazuh = Number(get(doc, 'rule.level'));
  if (Number.isFinite(wazuh) && get(doc, 'rule.level') !== undefined) return wazuh >= 13 ? 'critica' : wazuh >= 10 ? 'alta' : wazuh >= 7 ? 'media' : 'baja';
  const suri = Number(get(doc, 'alert.severity'));
  if (suri >= 1) return suri === 1 ? 'alta' : suri === 2 ? 'media' : 'baja';
  const text = String(first(doc, 'kibana.alert.severity', 'signal.rule.severity', 'event.severity_label', 'severity', 'level') ?? '').toLowerCase();
  if (/crit/.test(text)) return 'critica'; if (/high|alta|alto/.test(text)) return 'alta'; if (/med|warn/.test(text)) return 'media';
  const ecs = Number(get(doc, 'event.severity'));
  return ecs >= 90 ? 'critica' : ecs >= 70 ? 'alta' : ecs >= 40 ? 'media' : 'baja';
}

/** Resume los eventos de un SIEM: cuantos, por gravedad, las reglas que mas se repiten, equipos y origenes. */
export function summarize(docs: any[], total: number, hours: number): string {
  if (!docs.length) return `El SIEM no tiene eventos en las últimas ${hours} horas con ese filtro.`;
  const sev = new Map<string, number>(), hosts = new Map<string, number>(), srcs = new Map<string, number>();
  const rules = new Map<string, { n: number; sev: Sev; srcs: Map<string, number> }>();
  for (const d of docs) {
    const s = siemSeverity(d), name = safe(first(d, 'rule.description', 'rule.name', 'alert.signature', 'kibana.alert.rule.name', 'signal.rule.name', 'event.action', 'message', 'full_log') ?? 'evento sin nombre', 90);
    const host = safe(first(d, 'agent.name', 'host.name', 'host.hostname', 'observer.name', 'host') ?? '', 40), src = safe(first(d, 'data.srcip', 'source.ip', 'src_ip', 'data.src_ip', 'client.ip') ?? '', 45);
    sev.set(s, (sev.get(s) ?? 0) + 1);
    if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
    if (src) srcs.set(src, (srcs.get(src) ?? 0) + 1);
    let r = rules.get(name); if (!r) rules.set(name, (r = { n: 0, sev: s, srcs: new Map() }));
    r.n++; if (RANK[s] > RANK[r.sev]) r.sev = s; if (src) r.srcs.set(src, (r.srcs.get(src) ?? 0) + 1);
  }
  const ordered = [...rules.entries()].sort((a, b) => RANK[b[1].sev] - RANK[a[1].sev] || b[1].n - a[1].n).slice(0, 8);
  return [`SIEM, últimas ${hours} horas: ${total} eventos${total > docs.length ? ` (se resumen los ${docs.length} más recientes)` : ''}.`,
    `Por gravedad: ${(['critica', 'alta', 'media', 'baja'] as Sev[]).filter((s) => sev.get(s)).map((s) => `${s} ${sev.get(s)}`).join(', ')}.`,
    hosts.size ? `Equipos con más eventos: ${top(hosts, 4)}.` : '', srcs.size ? `Orígenes con más eventos: ${top(srcs, 4)}.` : '',
    'Reglas, de la más grave a la menos grave:', ...ordered.map(([name, r]) => `- [${r.sev}] ${name} · ${r.n} ${r.n === 1 ? 'vez' : 'veces'}${r.srcs.size ? ` · desde ${top(r.srcs, 2)}` : ''}`)].filter(Boolean).join('\n');
}

/**
 * Consulta de solo lectura a un SIEM con API de busqueda de OpenSearch o Elasticsearch: Wazuh (su indexador), Elastic
 * Security, OpenSearch y Security Onion. Se configura con SIEM_URL y una credencial; SIEM_INDEX dice donde buscar.
 * Para un SIEM con otra API (Splunk, Graylog, QRadar), que el SIEM envie sus alertas a POST /logs/<fuente> o por syslog.
 * Lo que devuelve es texto de terceros (nombres de reglas, equipos, mensajes): quien lo use debe envolverlo como datos.
 */
@Injectable()
export class SiemService {
  constructor(private readonly cfg: ConfigService) {}
  get enabled() { return !!this.cfg.siemUrl; }

  /** Eventos mas recientes (hasta 500) de las ultimas `hours` horas, con un filtro de texto opcional. */
  async search(hours: number, text = ''): Promise<{ total: number; docs: any[] }> {
    const field = this.cfg.siemTimeField, must = text.trim() ? [{ simple_query_string: { query: text.trim().slice(0, 200), default_operator: 'and', lenient: true } }] : [];
    const body = JSON.stringify({ size: 500, track_total_hits: true, sort: [{ [field]: { order: 'desc' } }], query: { bool: { filter: [{ range: { [field]: { gte: `now-${hours}h` } } }], must } } });
    const url = new URL(`${this.cfg.siemUrl.replace(/\/+$/, '')}/${encodeURIComponent(this.cfg.siemIndex).replace(/%2C/gi, ',').replace(/%2A/gi, '*')}/_search`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    if (this.cfg.siemApiKey) headers.Authorization = `ApiKey ${this.cfg.siemApiKey}`;
    else if (this.cfg.siemUser) headers.Authorization = `Basic ${Buffer.from(`${this.cfg.siemUser}:${this.cfg.siemPassword}`).toString('base64')}`;
    const tls = url.protocol === 'https:' ? { rejectUnauthorized: !this.cfg.siemTlsInsecure, ca: this.cfg.siemCaFile ? readFileSync(this.cfg.siemCaFile) : undefined } : {};
    const raw = await new Promise<string>((ok, fail) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'POST', headers, timeout: 10_000, ...tls }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('la respuesta del SIEM es demasiado grande')); else chunks.push(c); });
        res.on('end', () => ((res.statusCode ?? 500) < 300 ? ok(Buffer.concat(chunks).toString('utf8')) : fail(new Error(res.statusCode === 401 || res.statusCode === 403 ? 'el SIEM rechazó la credencial' : `el SIEM respondió ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error('el SIEM no respondió a tiempo')));
      req.on('error', (e) => fail(new Error(/certificate|self.signed/i.test(e.message) ? 'no se pudo validar el certificado del SIEM (define SIEM_CA_FILE)' : e.message)));
      req.end(body);
    });
    const j = JSON.parse(raw), hits: any[] = j?.hits?.hits ?? [];
    return { total: Number(j?.hits?.total?.value ?? j?.hits?.total ?? hits.length), docs: hits.map((h) => h._source ?? {}) };
  }
}
