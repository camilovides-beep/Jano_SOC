/**
 * Lector de capturas .pcap (formato clasico de tcpdump y Wireshark; no pcapng). Convierte cada paquete en una linea
 * con la forma de `tcpdump -nn`, que es lo que entiende el analizador. Solo mira cabeceras (Ethernet, ARP, IPv4, IPv6,
 * TCP, UDP, ICMP y la pregunta de DNS): el contenido de los paquetes nunca sale de aqui.
 */
const TCP_FLAGS: [number, string][] = [[0x01, 'F'], [0x02, 'S'], [0x04, 'R'], [0x08, 'P'], [0x10, '.'], [0x20, 'U'], [0x40, 'E'], [0x80, 'W']];
const DNS_TYPES: Record<number, string> = { 1: 'A', 5: 'CNAME', 10: 'NULL', 15: 'MX', 16: 'TXT', 28: 'AAAA', 255: 'ANY' };
const v4 = (b: Buffer, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const v6 = (b: Buffer, o: number) => Array.from({ length: 8 }, (_, i) => b.readUInt16BE(o + i * 2).toString(16)).join(':');
const mac = (b: Buffer, o: number) => Array.from(b.subarray(o, o + 6), (x) => x.toString(16).padStart(2, '0')).join(':');

/** Pregunta de DNS ("4242+ A? ejemplo.com. (29)") o '' si no es una pregunta legible. */
function dnsQuery(b: Buffer, o: number, len: number): string {
  if (len < 17 || o + len > b.length || b[o + 2] & 0x80 || b.readUInt16BE(o + 4) < 1) return '';
  const labels: string[] = []; let p = o + 12;
  while (p < o + len && b[p] > 0 && b[p] < 64 && labels.length < 40) { labels.push(b.toString('latin1', p + 1, p + 1 + b[p]).replace(/[^\w-]/g, '?')); p += b[p] + 1; }
  if (b[p] !== 0 || p + 3 > o + len) return '';
  return `${b.readUInt16BE(o)}+ ${DNS_TYPES[b.readUInt16BE(p + 1)] ?? 'Type' + b.readUInt16BE(p + 1)}? ${labels.join('.')}. (${len})`;
}

/** Lo que va despues de "IP origen > destino:" segun el protocolo de transporte. */
function transport(b: Buffer, o: number, proto: number, len: number, six: boolean): { sport: string; dport: string; text: string } {
  const none = { sport: '', dport: '' };
  if (proto === 6 && o + 14 <= b.length) {
    const flags = TCP_FLAGS.filter(([bit]) => b[o + 13] & bit).map(([, c]) => c).join('') || 'none';
    return { sport: `.${b.readUInt16BE(o)}`, dport: `.${b.readUInt16BE(o + 2)}`, text: `Flags [${flags}], length ${Math.max(0, len - (b[o + 12] >> 4) * 4)}` };
  }
  if (proto === 17 && o + 8 <= b.length) {
    const sport = b.readUInt16BE(o), dport = b.readUInt16BE(o + 2), n = Math.max(0, len - 8);
    return { sport: `.${sport}`, dport: `.${dport}`, text: (dport === 53 && dnsQuery(b, o + 8, Math.min(n, b.length - o - 8))) || `UDP, length ${n}` };
  }
  if (proto === 1 && o + 8 <= b.length) return { ...none, text: b[o] === 8 ? `ICMP echo request, id ${b.readUInt16BE(o + 4)}, seq ${b.readUInt16BE(o + 6)}, length ${len}` : b[o] === 0 ? `ICMP echo reply, length ${len}` : `ICMP type ${b[o]}, length ${len}` };
  if (proto === 58 && six && o + 4 <= b.length) return { ...none, text: b[o] === 128 ? `ICMP6, echo request, length ${len}` : `ICMP6, type ${b[o]}, length ${len}` };
  return { ...none, text: `proto ${proto}, length ${len}` };
}

function packet(b: Buffer, link: number, le: boolean): string {
  let o = 0, type = 0;
  if (link === 1) { if (b.length < 14) return ''; type = b.readUInt16BE(12); o = 14; while ((type === 0x8100 || type === 0x88a8) && o + 4 <= b.length) { type = b.readUInt16BE(o + 2); o += 4; } }
  else if (link === 113) { if (b.length < 16) return ''; type = b.readUInt16BE(14); o = 16; } // Linux cooked (tcpdump -i any, antiguo)
  else if (link === 276) { if (b.length < 20) return ''; type = b.readUInt16BE(0); o = 20; } // Linux cooked v2
  else if (link === 0 || link === 108) { if (b.length < 4) return ''; type = (le ? b.readUInt32LE(0) : b.readUInt32BE(0)) === 2 ? 0x0800 : 0x86dd; o = 4; } // loopback de BSD
  else if (link === 101 || link === 12 || link === 228 || link === 229) type = b.length && b[0] >> 4 === 6 ? 0x86dd : 0x0800; // IP sin capa de enlace
  else return '';
  if (type === 0x0806 && o + 28 <= b.length) {
    const op = b.readUInt16BE(o + 6);
    return op === 2 ? `ARP, Reply ${v4(b, o + 14)} is-at ${mac(b, o + 8)}, length 28` : `ARP, Request who-has ${v4(b, o + 24)} tell ${v4(b, o + 14)}, length 28`;
  }
  if (type === 0x0800 && o + 20 <= b.length) {
    const ihl = (b[o] & 15) * 4, total = b.readUInt16BE(o + 2), frag = b.readUInt16BE(o + 6) & 0x1fff;
    const t = frag ? { sport: '', dport: '', text: `fragmento, length ${Math.max(0, total - ihl)}` } : transport(b, o + ihl, b[o + 9], Math.max(0, total - ihl), false);
    return `IP ${v4(b, o + 12)}${t.sport} > ${v4(b, o + 16)}${t.dport}: ${t.text}`;
  }
  if (type === 0x86dd && o + 40 <= b.length) {
    const t = transport(b, o + 40, b[o + 6], b.readUInt16BE(o + 4), true);
    return `IP6 ${v6(b, o + 8)}${t.sport} > ${v6(b, o + 24)}${t.dport}: ${t.text}`;
  }
  return '';
}

/** Devuelve los ultimos `max` paquetes como lineas de tcpdump. Lanza un error con texto claro si el archivo no es un pcap clasico. */
export function pcapToLines(buf: Buffer, max = 60_000): string[] {
  if (buf.length < 24) throw new Error('el archivo no es una captura pcap');
  const magic = buf.readUInt32LE(0), le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d, be = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
  if (magic === 0x0a0d0d0a) throw new Error('la captura está en formato pcapng; conviértela con: tcpdump -r archivo.pcapng -w archivo.pcap');
  if (!le && !be) throw new Error('el archivo no es una captura pcap');
  const nano = magic === 0xa1b23c4d || magic === 0x4d3cb2a1, u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)), link = u32(20) & 0x0fffffff;
  const out: string[] = [];
  for (let o = 24; o + 16 <= buf.length;) {
    const sec = u32(o), frac = u32(o + 4), len = u32(o + 8);
    if (len > 262144 || o + 16 + len > buf.length) break; // registro cortado o corrupto
    const text = packet(buf.subarray(o + 16, o + 16 + len), link, le);
    if (text) out.push(`${new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ')}.${String(nano ? Math.floor(frac / 1000) : frac).padStart(6, '0')} ${text}`);
    o += 16 + len;
  }
  return out.slice(-max);
}
