import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const GENESIS_PREV_HASH = "0".repeat(64);

export type JournalArgs = {
  path?: string;
  query?: string;
  mode?: string;
};

export type JournalResult = "ok" | "erreur";

/** Ligne de journal sans le champ hash (base du calcul). */
export type JournalPayload = {
  seq: number;
  ts: string;
  tool: string;
  args: JournalArgs;
  client: string | null;
  result: JournalResult;
  note_sha256: string | null;
  prev_hash: string;
};

export type JournalEntry = JournalPayload & { hash: string };

export type AppendInput = {
  tool: string;
  args: JournalArgs;
  client: string | null;
  result: JournalResult;
  note_sha256: string | null;
};

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}

/** JSON canonique : clés triées, pas d'espaces superflus. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function computeEntryHash(entry: JournalPayload): string {
  return sha256Hex(entry.prev_hash + canonicalJson(entry));
}

export function normalizeNotePath(rel: string): string {
  let p = rel.replace(/\\/g, "/");
  if (!p.toLowerCase().endsWith(".md")) p += ".md";
  return p;
}

export type ChainIssue = {
  seq: number | null;
  line: number;
  reason: string;
};

export type ChainVerification = {
  ok: boolean;
  entries: number;
  lastTs?: string;
  lastHash?: string;
  lastSeq?: number;
  issue?: ChainIssue;
};

export function parseEntry(line: string): JournalEntry | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(line); }
  catch { return { error: "JSON invalide" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "JSON invalide" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq)) return { error: "seq invalide" };
  if (typeof o.ts !== "string") return { error: "ts invalide" };
  if (typeof o.tool !== "string") return { error: "tool invalide" };
  if (typeof o.prev_hash !== "string") return { error: "prev_hash invalide" };
  if (typeof o.hash !== "string") return { error: "hash invalide" };
  if (o.result !== "ok" && o.result !== "erreur") return { error: "result invalide" };
  if (o.client !== null && typeof o.client !== "string") return { error: "client invalide" };
  if (o.note_sha256 !== null && typeof o.note_sha256 !== "string") return { error: "note_sha256 invalide" };
  if (!o.args || typeof o.args !== "object" || Array.isArray(o.args)) return { error: "args invalide" };
  const a = o.args as Record<string, unknown>;
  const args: JournalArgs = {};
  if (typeof a.path === "string") args.path = a.path;
  if (typeof a.query === "string") args.query = a.query;
  if (typeof a.mode === "string") args.mode = a.mode;
  return {
    seq: o.seq,
    ts: o.ts,
    tool: o.tool,
    args,
    client: o.client as string | null,
    result: o.result,
    note_sha256: o.note_sha256 as string | null,
    prev_hash: o.prev_hash,
    hash: o.hash,
  };
}

export function verifyChain(lines: string[]): ChainVerification {
  let prevHash = GENESIS_PREV_HASH;
  let prevSeq = 0;
  let lastTs: string | undefined;
  let lastHash: string | undefined;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const parsed = parseEntry(line);
    if ("error" in parsed) {
      return {
        ok: false,
        entries: count,
        lastTs,
        lastHash,
        lastSeq: prevSeq || undefined,
        issue: { seq: null, line: lineNo, reason: parsed.error },
      };
    }
    if (parsed.seq !== prevSeq + 1) {
      return {
        ok: false,
        entries: count,
        lastTs,
        lastHash,
        lastSeq: prevSeq || undefined,
        issue: { seq: parsed.seq, line: lineNo, reason: "seq inattendu" },
      };
    }
    if (parsed.prev_hash !== prevHash) {
      return {
        ok: false,
        entries: count,
        lastTs,
        lastHash,
        lastSeq: prevSeq || undefined,
        issue: { seq: parsed.seq, line: lineNo, reason: "prev_hash inattendu" },
      };
    }
    const { hash: _ignored, ...payload } = parsed;
    const expected = computeEntryHash(payload);
    if (parsed.hash !== expected) {
      return {
        ok: false,
        entries: count,
        lastTs,
        lastHash,
        lastSeq: prevSeq || undefined,
        issue: { seq: parsed.seq, line: lineNo, reason: "hash invalide" },
      };
    }
    prevHash = parsed.hash;
    prevSeq = parsed.seq;
    lastTs = parsed.ts;
    lastHash = parsed.hash;
    count++;
  }

  return { ok: true, entries: count, lastTs, lastHash, lastSeq: prevSeq || undefined };
}

export function formatChainMessage(v: ChainVerification): string {
  if (v.ok) {
    if (v.entries === 0) return "Journal intact : 0 entrée.";
    const n = v.entries === 1 ? "1 entrée" : `${v.entries} entrées`;
    return `Journal intact : ${n}, dernière à ${v.lastTs}.`;
  }
  const issue = v.issue!;
  const where = issue.seq != null ? `seq=${issue.seq}` : `ligne ${issue.line}`;
  return `Journal altéré : première ligne cassée à ${where} (${issue.reason}).`;
}

export async function readJournalText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "ENOENT") {
      return "";
    }
    throw e;
  }
}

/** Découpe un JSONL en lignes complètes (sans la ligne traînante s'il manque le \\n final). */
export function splitCompleteLines(text: string): { lines: string[]; incomplete: boolean } {
  if (text === "") return { lines: [], incomplete: false };
  const incomplete = !text.endsWith("\n");
  const parts = text.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  else if (incomplete) parts.pop();
  return { lines: parts.filter((l, i, arr) => l.length > 0 || i < arr.length), incomplete };
}

export async function readCompleteJournalLines(filePath: string): Promise<string[]> {
  const text = await readJournalText(filePath);
  return splitCompleteLines(text).lines.filter((l) => l.length > 0);
}

export async function verifyJournalFile(filePath: string): Promise<ChainVerification> {
  const lines = await readCompleteJournalLines(filePath);
  return verifyChain(lines);
}

export function lastNoteRecord(entries: JournalEntry[], notePath: string): JournalEntry | undefined {
  const want = normalizeNotePath(notePath);
  let found: JournalEntry | undefined;
  for (const e of entries) {
    if (e.note_sha256 && e.args.path && normalizeNotePath(e.args.path) === want) {
      found = e;
    }
  }
  return found;
}

export type LoadState = {
  nextSeq: number;
  prevHash: string;
  truncated: boolean;
};

/**
 * Charge l'état de la chaîne. Si le fichier se termine par une ligne incomplète
 * (écriture interrompue avant le saut de ligne + fsync), cette queue est tronquée.
 */
export async function loadJournalState(filePath: string): Promise<LoadState> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "ENOENT") {
      return { nextSeq: 1, prevHash: GENESIS_PREV_HASH, truncated: false };
    }
    throw e;
  }
  if (text === "") return { nextSeq: 1, prevHash: GENESIS_PREV_HASH, truncated: false };

  const { lines, incomplete } = splitCompleteLines(text);
  const complete = lines.filter((l) => l.length > 0);
  if (incomplete) {
    const kept = complete.join("\n") + (complete.length ? "\n" : "");
    await fs.writeFile(filePath, kept, "utf8");
  }
  if (complete.length === 0) return { nextSeq: 1, prevHash: GENESIS_PREV_HASH, truncated: incomplete };

  const lastLine = complete[complete.length - 1];
  const parsed = parseEntry(lastLine);
  if ("error" in parsed) {
    // On reprend quand même sur le hash stocké s'il est lisible, sinon on échoue au chargement.
    throw new Error(`Journal illisible à la dernière ligne : ${parsed.error}`);
  }
  return { nextSeq: parsed.seq + 1, prevHash: parsed.hash, truncated: incomplete };
}

export class JournalWriter {
  private readonly filePath: string;
  private nextSeq = 1;
  private prevHash = GENESIS_PREV_HASH;
  private ready: Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ready = this.init();
  }

  get path(): string {
    return this.filePath;
  }

  private async init(): Promise<void> {
    const state = await loadJournalState(this.filePath);
    this.nextSeq = state.nextSeq;
    this.prevHash = state.prevHash;
  }

  async append(input: AppendInput): Promise<JournalEntry> {
    await this.ready;
    let release!: () => void;
    const prev = this.queue;
    this.queue = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      const payload: JournalPayload = {
        seq: this.nextSeq,
        ts: new Date().toISOString(),
        tool: input.tool,
        args: input.args,
        client: input.client,
        result: input.result,
        note_sha256: input.note_sha256,
        prev_hash: this.prevHash,
      };
      const entry: JournalEntry = { ...payload, hash: computeEntryHash(payload) };
      const fh = await fs.open(this.filePath, "a");
      try {
        await fh.write(JSON.stringify(entry) + "\n", undefined, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      this.nextSeq = entry.seq + 1;
      this.prevHash = entry.hash;
      return entry;
    } finally {
      release();
    }
  }
}


export type NoteGlyph = "V" | "X";

export type NoteVerdict = {
  glyph: NoteGlyph;
  message: string;
};

/** Compare a note's current sha256 to the last journaled fingerprint. */
export function formatNoteVerdict(relMd: string, rec: JournalEntry, currentSha: string): NoteVerdict {
  const shown = relMd.replace(/\\/g, "/");
  const client = rec.client ?? "client inconnu";
  if (currentSha === rec.note_sha256) {
    return {
      glyph: "V",
      message: `V  intacte — Note ${shown} intacte depuis ${rec.ts} par ${client}.`,
    };
  }
  return {
    glyph: "X",
    message: `X  MODIFIÉE hors XVcache — Note ${shown} MODIFIÉE hors XVcache après ${rec.ts}.`,
  };
}
