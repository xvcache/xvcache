/** Minimal DER reader/writer, just enough for RFC 3161 requests and tokens. */

export type DerNode = {
  tag: number;
  constructed: boolean;
  start: number;
  headerLength: number;
  length: number;
  end: number;
  children?: DerNode[];
};

export function parseDer(buf: Buffer, start = 0, end = buf.length, depth = 0): DerNode {
  if (depth > 40) throw new Error("DER : profondeur excessive.");
  if (start + 2 > end) throw new Error("DER : données tronquées.");
  const tag = buf[start];
  if ((tag & 0x1f) === 0x1f) throw new Error("DER : tag long non supporté.");
  let pos = start + 1;
  let length = buf[pos++];
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER : longueur invalide.");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[pos++];
  }
  const headerLength = pos - start;
  const nodeEnd = pos + length;
  if (nodeEnd > end) throw new Error("DER : longueur hors limites.");
  const constructed = (tag & 0x20) !== 0;
  const node: DerNode = { tag, constructed, start, headerLength, length, end: nodeEnd };
  if (constructed) {
    node.children = [];
    let p = pos;
    while (p < nodeEnd) {
      const child = parseDer(buf, p, nodeEnd, depth + 1);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

export function derValue(buf: Buffer, n: DerNode): Buffer {
  return buf.subarray(n.start + n.headerLength, n.end);
}

export function derRaw(buf: Buffer, n: DerNode): Buffer {
  return buf.subarray(n.start, n.end);
}

export function decodeOid(v: Buffer): string {
  if (v.length === 0) throw new Error("DER : OID vide.");
  const parts: number[] = [];
  const first = v[0];
  parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join(".");
}

export function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

export function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map((x) => Number(x));
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

/** Unsigned big-endian bytes as a positive DER INTEGER. */
export function encodePositiveInteger(bytes: Buffer): Buffer {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

/** GeneralizedTime (YYYYMMDDHHMMSS[.fff]Z) to ISO 8601. */
export function generalizedTimeToIso(s: string): string {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d+))?Z$/);
  if (!m) throw new Error("DER : GeneralizedTime invalide.");
  const frac = m[7] ? "." + (m[7] + "000").slice(0, 3) : ".000";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}Z`;
}
