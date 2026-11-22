import { createHash } from "node:crypto";

/**
 * Minimal OpenTimestamps client (stamp, upgrade, Bitcoin check) without extra dependencies.
 * File format: https://github.com/opentimestamps/python-opentimestamps (core/serialize, timestamp, op, notary).
 */

export const OTS_HEADER = Buffer.concat([
  Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex"),
]);
const OTS_MAJOR_VERSION = 1;
const TAG_PENDING = "83dfe30d2ef90c8e";
const TAG_BITCOIN = "0588960d73d71901";

export const DEFAULT_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
];
const ALLOWED_CALENDAR_HOSTS = new Set([
  "a.pool.opentimestamps.org", "b.pool.opentimestamps.org", "a.pool.eternitywall.com",
  "alice.btc.calendar.opentimestamps.org", "bob.btc.calendar.opentimestamps.org",
  "finney.calendar.eternitywall.com", "btc.calendar.catallaxy.com", "ots.btc.catallaxy.com",
]);

export type Attestation =
  | { kind: "pending"; uri: string }
  | { kind: "bitcoin"; height: number }
  | { kind: "unknown"; tag: string; payload: Buffer };

export type Op = { tag: number; arg?: Buffer };

export class Timestamp {
  msg: Buffer;
  attestations: Attestation[] = [];
  ops = new Map<string, { op: Op; stamp: Timestamp }>();
  constructor(msg: Buffer) { this.msg = msg; }
}

function opKey(op: Op): string {
  return op.tag.toString(16).padStart(2, "0") + (op.arg ? op.arg.toString("hex") : "");
}

function hashWith(alg: string, msg: Buffer): Buffer {
  return createHash(alg).update(msg).digest();
}

export function applyOp(op: Op, msg: Buffer): Buffer {
  switch (op.tag) {
    case 0xf0: return Buffer.concat([msg, op.arg!]);
    case 0xf1: return Buffer.concat([op.arg!, msg]);
    case 0xf2: return Buffer.from(msg).reverse();
    case 0xf3: return Buffer.from(msg.toString("hex"), "utf8");
    case 0x08: return hashWith("sha256", msg);
    case 0x02: return hashWith("sha1", msg);
    case 0x03: return hashWith("ripemd160", msg);
    default: throw new Error(`OTS : opération 0x${op.tag.toString(16)} non supportée.`);
  }
}

const BINARY_OPS = new Set([0xf0, 0xf1]);
const UNARY_OPS = new Set([0xf2, 0xf3, 0x08, 0x02, 0x03, 0x67]);

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("OTS : fichier tronqué.");
    return this.buf[this.pos++];
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error("OTS : fichier tronqué.");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(b);
  }
  varuint(): number {
    let value = 0, shift = 0, b: number;
    do {
      b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 49) throw new Error("OTS : varuint trop long.");
    } while (b & 0x80);
    return value;
  }
  varbytes(max = 8192): Buffer {
    const n = this.varuint();
    if (n > max) throw new Error("OTS : champ trop long.");
    return this.bytes(n);
  }
  done(): boolean { return this.pos === this.buf.length; }
}

function varuint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function varbytes(b: Buffer): Buffer {
  return Buffer.concat([varuint(b.length), b]);
}

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8).toString("hex");
  const payload = r.varbytes();
  const pr = new Reader(payload);
  if (tag === TAG_PENDING) return { kind: "pending", uri: pr.varbytes(1000).toString("utf8") };
  if (tag === TAG_BITCOIN) return { kind: "bitcoin", height: pr.varuint() };
  return { kind: "unknown", tag, payload };
}

function writeAttestation(a: Attestation): Buffer {
  if (a.kind === "pending") return Buffer.concat([Buffer.from(TAG_PENDING, "hex"), varbytes(varbytes(Buffer.from(a.uri, "utf8")))]);
  if (a.kind === "bitcoin") return Buffer.concat([Buffer.from(TAG_BITCOIN, "hex"), varbytes(varuint(a.height))]);
  return Buffer.concat([Buffer.from(a.tag, "hex"), varbytes(a.payload)]);
}

export function readTimestamp(r: Reader, msg: Buffer, depth = 0): Timestamp {
  if (depth > 256) throw new Error("OTS : profondeur excessive.");
  const ts = new Timestamp(msg);
  const handle = (tag: number) => {
    if (tag === 0x00) { ts.attestations.push(readAttestation(r)); return; }
    let op: Op;
    if (BINARY_OPS.has(tag)) op = { tag, arg: r.varbytes(4096) };
    else if (UNARY_OPS.has(tag)) op = { tag };
    else throw new Error(`OTS : tag inconnu 0x${tag.toString(16)}.`);
    const next = applyOp(op, msg);
    ts.ops.set(opKey(op), { op, stamp: readTimestamp(r, next, depth + 1) });
  };
  let tag = r.byte();
  while (tag === 0xff) { handle(r.byte()); tag = r.byte(); }
  handle(tag);
  return ts;
}

function writeOp(op: Op): Buffer {
  return op.arg ? Buffer.concat([Buffer.from([op.tag]), varbytes(op.arg)]) : Buffer.from([op.tag]);
}

export function writeTimestamp(ts: Timestamp): Buffer {
  const items: Buffer[] = [];
  for (const a of ts.attestations) items.push(Buffer.concat([Buffer.from([0x00]), writeAttestation(a)]));
  const keys = [...ts.ops.keys()].sort();
  for (const k of keys) {
    const { op, stamp } = ts.ops.get(k)!;
    items.push(Buffer.concat([writeOp(op), writeTimestamp(stamp)]));
  }
  if (items.length === 0) throw new Error("OTS : horodatage vide.");
  const parts: Buffer[] = [];
  items.forEach((it, i) => { if (i < items.length - 1) parts.push(Buffer.from([0xff])); parts.push(it); });
  return Buffer.concat(parts);
}

export function merge(into: Timestamp, other: Timestamp): void {
  if (!into.msg.equals(other.msg)) throw new Error("OTS : fusion de messages différents.");
  for (const a of other.attestations) {
    const enc = writeAttestation(a).toString("hex");
    if (!into.attestations.some((b) => writeAttestation(b).toString("hex") === enc)) into.attestations.push(a);
  }
  for (const [k, v] of other.ops) {
    const mine = into.ops.get(k);
    if (mine) merge(mine.stamp, v.stamp); else into.ops.set(k, v);
  }
}

/** Serialize a detached .ots file for a SHA-256 digest. */
export function serializeOts(ts: Timestamp): Buffer {
  return Buffer.concat([OTS_HEADER, varuint(OTS_MAJOR_VERSION), Buffer.from([0x08]), ts.msg, writeTimestamp(ts)]);
}

export function parseOts(buf: Buffer): Timestamp {
  const r = new Reader(buf);
  if (!r.bytes(OTS_HEADER.length).equals(OTS_HEADER)) throw new Error("OTS : en-tête invalide.");
  if (r.varuint() !== OTS_MAJOR_VERSION) throw new Error("OTS : version non supportée.");
  if (r.byte() !== 0x08) throw new Error("OTS : seul SHA-256 est supporté.");
  const digest = r.bytes(32);
  const ts = readTimestamp(r, digest);
  if (!r.done()) throw new Error("OTS : octets en trop.");
  return ts;
}

export type AttestationAt = { attestation: Attestation; msg: Buffer; node: Timestamp };

export function allAttestations(ts: Timestamp, out: AttestationAt[] = []): AttestationAt[] {
  for (const a of ts.attestations) out.push({ attestation: a, msg: ts.msg, node: ts });
  for (const { stamp } of ts.ops.values()) allAttestations(stamp, out);
  return out;
}

function calendarAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && ALLOWED_CALENDAR_HOSTS.has(u.hostname);
  } catch { return false; }
}

type HttpGetPost = typeof fetch;

/** Submit a 32-byte digest to calendars. At least one calendar must answer. */
export async function stampDigest(digest: Buffer, calendars = DEFAULT_CALENDARS, f: HttpGetPost = fetch): Promise<{ ts: Timestamp; calendars: string[]; errors: string[] }> {
  const ts = new Timestamp(digest);
  const okCals: string[] = [];
  const errors: string[] = [];
  await Promise.all(calendars.map(async (cal) => {
    try {
      const res = await f(`${cal.replace(/\/$/, "")}/digest`, {
        method: "POST",
        headers: { Accept: "application/vnd.opentimestamps.v1", "Content-Type": "application/x-www-form-urlencoded" },
        body: new Uint8Array(digest),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const r = new Reader(body);
      const part = readTimestamp(r, digest);
      merge(ts, part);
      okCals.push(cal);
    } catch (e) {
      errors.push(`${cal}: ${(e as Error).message}`);
    }
  }));
  if (okCals.length === 0) throw new Error("OTS : aucun calendrier n'a répondu (" + errors.join("; ") + ").");
  return { ts, calendars: okCals.sort(), errors };
}

/** Ask calendars for completed attestations. Returns true if something changed. */
export async function upgradeTimestamp(ts: Timestamp, f: HttpGetPost = fetch): Promise<boolean> {
  let changed = false;
  for (const { attestation, msg, node } of allAttestations(ts)) {
    if (attestation.kind !== "pending" || !calendarAllowed(attestation.uri)) continue;
    try {
      const res = await f(`${attestation.uri.replace(/\/$/, "")}/timestamp/${msg.toString("hex")}`, {
        headers: { Accept: "application/vnd.opentimestamps.v1" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const body = Buffer.from(await res.arrayBuffer());
      const upgraded = readTimestamp(new Reader(body), msg);
      if (allAttestations(upgraded).some((a) => a.attestation.kind === "bitcoin")) {
        merge(node, upgraded);
        node.attestations = node.attestations.filter((a) => !(a.kind === "pending" && a.uri === attestation.uri));
        changed = true;
      }
    } catch { /* still pending */ }
  }
  return changed;
}

export type BitcoinCheck = { height: number; ok: boolean; block_time?: string; detail: string };

const ESPLORA = ["https://blockstream.info/api", "https://mempool.space/api"];

/** Compare the attested message with the Bitcoin block header merkle root (via public explorers). */
export async function verifyBitcoinAttestation(height: number, msg: Buffer, f: HttpGetPost = fetch): Promise<BitcoinCheck> {
  const expected = Buffer.from(msg).reverse().toString("hex");
  for (const base of ESPLORA) {
    try {
      const h = await f(`${base}/block-height/${height}`, { signal: AbortSignal.timeout(15000) });
      if (!h.ok) continue;
      const hash = (await h.text()).trim();
      const b = await f(`${base}/block/${hash}`, { signal: AbortSignal.timeout(15000) });
      if (!b.ok) continue;
      const block = (await b.json()) as { merkle_root?: string; timestamp?: number };
      const ok = block.merkle_root === expected;
      return {
        height, ok,
        block_time: block.timestamp ? new Date(block.timestamp * 1000).toISOString() : undefined,
        detail: ok ? `Ancré dans le bloc Bitcoin ${height} (vérifié via ${new URL(base).hostname}).` : `Racine Merkle du bloc ${height} différente.`,
      };
    } catch { /* try next explorer */ }
  }
  return { height, ok: false, detail: "Explorateurs Bitcoin injoignables : ancrage non vérifié." };
}

export type OtsStatus = {
  status: "pending" | "confirmed" | "failed" | "unverified";
  digest: string;
  pending_calendars: string[];
  bitcoin: BitcoinCheck[];
  detail: string;
};

export async function otsStatus(ts: Timestamp, opts: { online: boolean; f?: HttpGetPost }): Promise<OtsStatus> {
  const atts = allAttestations(ts);
  const pending = atts.filter((a) => a.attestation.kind === "pending").map((a) => (a.attestation as { uri: string }).uri);
  const btc = atts.filter((a) => a.attestation.kind === "bitcoin");
  const base = { digest: ts.msg.toString("hex"), pending_calendars: [...new Set(pending)].sort() };
  if (btc.length === 0) {
    return { ...base, status: "pending", bitcoin: [], detail: "En attente de confirmation Bitcoin (normal pendant quelques heures)." };
  }
  if (!opts.online) {
    const heights = btc.map((b) => (b.attestation as { height: number }).height);
    return { ...base, status: "unverified", bitcoin: heights.map((h) => ({ height: h, ok: false, detail: "Vérification hors ligne." })), detail: `Attestation Bitcoin présente (bloc ${heights.join(", ")}), non vérifiée hors ligne.` };
  }
  const checks: BitcoinCheck[] = [];
  for (const b of btc) checks.push(await verifyBitcoinAttestation((b.attestation as { height: number }).height, b.msg, opts.f));
  const good = checks.find((c) => c.ok);
  if (good) return { ...base, status: "confirmed", bitcoin: checks, detail: good.detail };
  const unreachable = checks.every((c) => /injoignables/.test(c.detail));
  return { ...base, status: unreachable ? "unverified" : "failed", bitcoin: checks, detail: checks.map((c) => c.detail).join(" ") };
}
