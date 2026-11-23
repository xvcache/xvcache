import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument, PDFName, PDFString, PDFArray, rgb,
  type PDFFont, type RGB,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadLocale, fill, formatLocalDateTime, resolveLang, type Lang } from "./i18n.js";
import { sha256Hex, normalizeNotePath } from "./journal.js";
import { Certifier, PROOF_FORMAT, type Proof, type VerifyReport } from "./certify.js";
import { assessQualification, type Qualification } from "./tsa.js";

const NBSP = "\u00a0";
const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export type ParisTime = {
  iso: string;
  /** e.g. "22 novembre 2026 à 20 h 08 min 39 s" */
  long: string;
  /** e.g. "22 novembre 2026 à 20 h 08" */
  short: string;
  tz: "heure de Paris";
};

export function formatParisDateTime(iso: string): ParisTime {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Date illisible : ${iso}`);
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const monthIdx = Number(get("month")) - 1;
  const month = MONTHS_FR[monthIdx];
  if (!month) throw new Error(`Date illisible : ${iso}`);
  const day = String(Number(get("day")));
  const year = get("year");
  const hour = String(Number(get("hour")));
  const minute = get("minute").padStart(2, "0");
  const second = get("second").padStart(2, "0");
  const short = `${day} ${month} ${year} à ${hour}${NBSP}h${NBSP}${minute}`;
  const long = `${short} min${NBSP}${second}${NBSP}s`;
  return { iso, long, short, tz: "heure de Paris" };
}

export function formatGroupedHex(hex: string, group = 4): string {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  return clean.replace(new RegExp(`.{1,${group}}`, "g"), `$& `).trim();
}

export function otsHuman(status?: string | null, detail?: string | null): string {
  switch (status) {
    case "confirmed":
      return detail && detail.trim() ? detail : "Confirmé sur le réseau Bitcoin.";
    case "pending":
      return "En attente de confirmation sur le réseau Bitcoin (cela peut prendre quelques heures).";
    case "unverified":
      return "Présent, non vérifié pour le moment (vérification hors ligne).";
    case "failed":
      return "Ancrage public non confirmé.";
    default:
      return "Aucun ancrage public dans cette preuve.";
  }
}

export type HumanVerdict = {
  glyph: "V" | "X";
  kind: "intact" | "modifie" | "invalide" | "signature_unverified";
  title: string;
  sentence: string;
  since: string | null;
};

/** Intact only when the fingerprint matches (V) and the token signature is verified. */
export function kindWhenFingerprintMatches(signature: string | null | undefined): "intact" | "signature_unverified" {
  return signature === "verified" ? "intact" : "signature_unverified";
}

export function humanVerdict(report: VerifyReport): HumanVerdict {
  const when = report.gen_time ? formatParisDateTime(report.gen_time) : null;
  const since = when ? when.short : null;
  const noteChanged = report.checks.note?.ok === false;
  if (report.glyph === "V") {
    if (kindWhenFingerprintMatches(report.signature) === "intact") {
      return {
        glyph: "V",
        kind: "intact",
        title: "Intact",
        sentence: when
          ? `Intact — ce document est identique à celui horodaté le ${when.short} (${when.tz}).`
          : "Intact — ce document est identique à la version certifiée.",
        since,
      };
    }
    return {
      glyph: "V",
      kind: "signature_unverified",
      title: "Empreinte conforme — signature non vérifiée",
      sentence: when
        ? `Empreinte conforme — signature non vérifiée. Ce document a la même empreinte que celui horodaté le ${when.short} (${when.tz}), mais la signature du jeton n'a pas pu être vérifiée.`
        : "Empreinte conforme — signature non vérifiée.",
      since,
    };
  }
  if (noteChanged && when) {
    return {
      glyph: "X",
      kind: "modifie",
      title: "Modifié",
      sentence: `Modifié depuis le ${when.short} (${when.tz}).`,
      since,
    };
  }
  return {
    glyph: "X",
    kind: "invalide",
    title: "Preuve invalide",
    sentence: "Cette preuve ne peut pas être validée. Le fichier, la date ou le jeton ne correspondent plus.",
    since,
  };
}

export type StoredProof = { file: string; proof: Proof };

export async function loadProofs(proofsDir: string): Promise<StoredProof[]> {
  const out: StoredProof[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.endsWith(".json")) {
        try {
          const proof = JSON.parse(await fs.readFile(full, "utf8")) as Proof;
          if (proof?.format === PROOF_FORMAT && typeof proof.path === "string") out.push({ file: full, proof });
        } catch { /* ignore unreadable proof files */ }
      }
    }
  }
  await walk(proofsDir);
  return out;
}

function newerProof(a: StoredProof, b: StoredProof): StoredProof {
  const ta = a.proof.tsa?.gen_time ?? a.proof.batch_created_at ?? a.proof.batch_id;
  const tb = b.proof.tsa?.gen_time ?? b.proof.batch_created_at ?? b.proof.batch_id;
  return ta >= tb ? a : b;
}

export function matchProof(
  proofs: StoredProof[],
  opts: { relPath?: string; sha?: string; filename?: string },
): StoredProof | null {
  if (opts.relPath) {
    const want = normalizeNotePath(opts.relPath.replace(/\\/g, "/")).replace(/^\.\//, "");
    const same = proofs.filter((p) => p.proof.path === want);
    if (same.length) return same.reduce(newerProof);
  }
  if (opts.sha) {
    const same = proofs.filter((p) => p.proof.note_sha256 === opts.sha);
    if (same.length) return same.reduce(newerProof);
  }
  if (opts.filename) {
    const base = path.basename(opts.filename);
    const same = proofs.filter((p) => path.basename(p.proof.path) === base);
    if (same.length) return same.reduce(newerProof);
  }
  return null;
}

export type Attachment = { name: string; path: string; description: string };

export type CertificatePack = {
  dir: string;
  pdf: string;
  attachments: Attachment[];
};

export function certificatePackDir(dataDir: string, proof: Proof): string {
  return path.join(dataDir, "certificates", ...proof.path.split("/"), proof.batch_id);
}

async function copyIfPresent(src: string, dest: string): Promise<boolean> {
  try {
    await fs.copyFile(src, dest);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export async function writeCertificatePack(opts: {
  proof: Proof;
  dataDir: string;
  batchesDir: string;
  proofFile?: string | null;
  otsStatus?: string | null;
  otsDetail?: string | null;
  lang?: string;
  tz?: string;
  /** Qualification recomputed from the token (certifier.verify). Omitted → recomputed here (bundled Certigna chain). */
  qualification?: Qualification | null;
}): Promise<CertificatePack> {
  const { proof } = opts;
  const dir = certificatePackDir(opts.dataDir, proof);
  await fs.mkdir(dir, { recursive: true });
  const attachments: Attachment[] = [];

  const tstDest = path.join(dir, "jeton.tst");
  const otsDest = path.join(dir, "ancrage.ots");
  const batchDir = path.join(opts.batchesDir, proof.batch_id);
  if (await copyIfPresent(path.join(batchDir, "root.tst"), tstDest)) {
    attachments.push({ name: "jeton.tst", path: tstDest, description: "Jeton d'horodatage" });
  } else if (proof.tsa?.token_base64) {
    await fs.writeFile(tstDest, Buffer.from(proof.tsa.token_base64, "base64"));
    attachments.push({ name: "jeton.tst", path: tstDest, description: "Jeton d'horodatage" });
  }
  if (await copyIfPresent(path.join(batchDir, "root.ots"), otsDest)) {
    attachments.push({ name: "ancrage.ots", path: otsDest, description: "Ancrage public OpenTimestamps" });
  } else if (proof.ots?.ots_base64) {
    await fs.writeFile(otsDest, Buffer.from(proof.ots.ots_base64, "base64"));
    attachments.push({ name: "ancrage.ots", path: otsDest, description: "Ancrage public OpenTimestamps" });
  }

  const merklePath = path.join(dir, "chemin-de-preuve.json");
  const merkle = {
    format: "xvcache-chemin-de-preuve/1",
    fichier: proof.path,
    empreinte_sha256: proof.note_sha256,
    racine: proof.merkle.root,
    index: proof.merkle.leaf_index,
    feuilles: proof.merkle.leaf_count,
    chemin: proof.merkle.path,
    lot: proof.batch_id,
    preuve: opts.proofFile ?? null,
  };
  await fs.writeFile(merklePath, JSON.stringify(merkle, null, 2) + "\n", "utf8");
  attachments.push({ name: "chemin-de-preuve.json", path: merklePath, description: "Lien entre ce fichier et le jeton" });

  const lang = opts.lang ?? "fr";
  const pdfPath = path.join(dir, lang === "fr" ? "certificat.pdf" : `certificate-${lang}.pdf`);
  const bytes = await buildCertificatePdf({
    proof,
    qualification: opts.qualification,
    otsText: otsHuman(opts.otsStatus ?? proof.ots?.status, opts.otsDetail ?? proof.ots?.detail),
    attachments,
    lang,
    tz: opts.tz,
  });
  await fs.writeFile(pdfPath, bytes);
  return { dir, pdf: pdfPath, attachments };
}

export type DocumentResult = {
  ok: boolean;
  error?: string;
  glyph?: "V" | "X";
  verdict?: HumanVerdict;
  path?: string | null;
  pdf?: string | null;
  pack?: string | null;
  attachments?: Attachment[];
  stamped: boolean;
  provider?: string | null;
  qualified?: boolean;
  qualified_confirmed?: boolean;
  gen_time?: string | null;
  gen_time_paris?: string | null;
  batch_id?: string | null;
  proof_id?: string | null;
  lang?: Lang;
  verdict_localized?: string;
};

function fromReport(
  report: VerifyReport,
  extra: Partial<DocumentResult> = {},
): DocumentResult {
  const verdict = humanVerdict(report);
  const when = report.gen_time ? formatParisDateTime(report.gen_time) : null;
  return {
    ok: true,
    glyph: report.glyph,
    verdict,
    path: report.path,
    pdf: null,
    pack: null,
    attachments: [],
    stamped: false,
    provider: report.provider,
    qualified: report.qualified,
    qualified_confirmed: report.qualified_confirmed,
    gen_time: report.gen_time,
    gen_time_paris: when ? `${when.long} (${when.tz})` : null,
    batch_id: report.batch_id,
    ...extra,
  };
}

/**
 * Reuse an existing proof when possible. Stamp only if `stamp` is true and no proof exists.
 * A V result writes a one-page PDF certificate and copies the technical files next to it.
 */
export async function handleDocument(
  certifier: Certifier,
  input: {
    path?: string;
    content?: Buffer | Uint8Array;
    filename?: string;
    stamp?: boolean;
    online?: boolean;
    /** PDF and verdict language (24 EU codes). Default "fr" for backward compatibility; unknown → "en". */
    lang?: string;
    tz?: string;
  },
): Promise<DocumentResult> {
  const lang = input.lang === undefined ? "fr" : resolveLang(input.lang).lang;
  const online = input.online === true;
  const content = input.content !== undefined ? Buffer.from(input.content) : undefined;
  const sha = content ? sha256Hex(content) : undefined;
  const proofs = await loadProofs(certifier.proofsDir());
  let found = matchProof(proofs, { relPath: input.path, sha, filename: input.filename });
  let stamped = false;

  if (!found) {
    if (!input.stamp) {
      return { ok: false, stamped: false, error: "Ce document n'a pas encore été horodaté." };
    }
    if (!input.path) {
      return { ok: false, stamped: false, error: "Indiquer le chemin de la note dans le coffre pour l'horodater." };
    }
    const q = await certifier.enqueue(input.path);
    if ("error" in q) return { ok: false, stamped: false, error: q.error };
    const b = await certifier.runBatch();
    if ("error" in b) return { ok: false, stamped: false, error: b.error };
    const mine = b.proofs.find((p) => p.path === q.path);
    if (!mine) return { ok: false, stamped: false, error: "La certification a réussi, mais la preuve est introuvable." };
    found = { file: certifier.proofFile(mine.path, b.batch_id), proof: mine };
    stamped = true;
  }

  const report = await certifier.verify({
    proof: found.proof,
    path: input.path,
    content,
    online,
  });

  const localized = (r: VerifyReport): string => {
    const k = humanVerdict(r).kind;
    return localizedVerdict(k, lang, r.gen_time, input.tz);
  };
  if (report.glyph !== "V") {
    return fromReport(report, { stamped, path: found.proof.path, proof_id: localProofId(found.proof), lang, verdict_localized: localized(report) });
  }

  const pack = await writeCertificatePack({
    proof: JSON.parse(await fs.readFile(found.file, "utf8")) as Proof,
    dataDir: certifier.cfg.dataDir,
    batchesDir: certifier.batchesDir(),
    proofFile: found.file,
    otsStatus: report.ots?.status ?? found.proof.ots?.status,
    otsDetail: report.ots?.detail ?? found.proof.ots?.detail,
    lang,
    tz: input.tz,
    qualification: report.qualified ? report.qualification : report.qualification ? { ...report.qualification, qualified: false } : null,
  });
  return fromReport(report, {
    proof_id: localProofId(found.proof),
    lang,
    verdict_localized: localized(report),
    stamped,
    path: found.proof.path,
    pdf: pack.pdf,
    pack: pack.dir,
    attachments: pack.attachments,
  });
}

/**
 * Reissue the PDF of an existing local proof in another language. Never stamps, never spends a token.
 * The proof is re-verified against the current note first: a modified note gives X and no PDF.
 */
export async function reissueCertificate(
  certifier: Certifier,
  input: { proof_id: string; lang?: string; tz?: string; online?: boolean },
): Promise<DocumentResult> {
  const lang = resolveLang(input.lang).lang;
  const proofs = await loadProofs(certifier.proofsDir());
  const found = proofs.find((p) => localProofId(p.proof) === input.proof_id);
  if (!found) return { ok: false, stamped: false, error: `PROOF_NOT_FOUND: ${input.proof_id}` };
  const report = await certifier.verify({ proof: found.proof, path: found.proof.path, online: input.online === true });
  const verdict_localized = localizedVerdict(humanVerdict(report).kind, lang, report.gen_time, input.tz);
  if (report.glyph !== "V") return fromReport(report, { path: found.proof.path, proof_id: input.proof_id, lang, verdict_localized });
  const pack = await writeCertificatePack({
    proof: found.proof,
    dataDir: certifier.cfg.dataDir,
    batchesDir: certifier.batchesDir(),
    proofFile: found.file,
    otsStatus: report.ots?.status ?? found.proof.ots?.status,
    otsDetail: report.ots?.detail ?? found.proof.ots?.detail,
    lang,
    tz: input.tz,
    qualification: report.qualified ? report.qualification : report.qualification ? { ...report.qualification, qualified: false } : null,
  });
  return fromReport(report, { path: found.proof.path, proof_id: input.proof_id, lang, verdict_localized, pdf: pack.pdf, pack: pack.dir, attachments: pack.attachments });
}

/* -------------------------------------------------------------------------- */
/* PDF (one page, 24 EU languages, embedded DejaVu fonts)                      */
/* -------------------------------------------------------------------------- */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 50;
const MARGIN_TOP = 44;
const MARGIN_BOTTOM = 34;
const INK = rgb(0.12, 0.12, 0.11);
const MUTED = rgb(0.38, 0.37, 0.35);
const RULE = rgb(0.78, 0.76, 0.72);
const GREEN = rgb(0.06, 0.42, 0.28);
const GREEN_SOFT = rgb(0.93, 0.96, 0.94);
const RED = rgb(0.62, 0.12, 0.1);
const AMBER = rgb(0.6, 0.38, 0.05);
const WARN_BG = rgb(0.99, 0.95, 0.88);
const WARN_INK = rgb(0.42, 0.25, 0.05);
const CONTENT_W = PAGE_W - 2 * MARGIN_X;

export function fontsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");
}

const FONT_FILES = {
  serif: "DejaVuSerif.ttf",
  serifBold: "DejaVuSerif-Bold.ttf",
  sans: "DejaVuSans.ttf",
  sansBold: "DejaVuSans-Bold.ttf",
} as const;
type FontKey = keyof typeof FONT_FILES;

const fontBytesCache = new Map<FontKey, Uint8Array>();
async function fontBytes(key: FontKey): Promise<Uint8Array> {
  let b = fontBytesCache.get(key);
  if (!b) {
    b = new Uint8Array(await fs.readFile(path.join(fontsDir(), FONT_FILES[key])));
    fontBytesCache.set(key, b);
  }
  return b;
}

type GlyphChecker = { hasGlyphForCodePoint(cp: number): boolean };
const glyphCheckers = new Map<FontKey, GlyphChecker>();
async function glyphChecker(key: FontKey): Promise<GlyphChecker> {
  let g = glyphCheckers.get(key);
  if (!g) {
    g = (fontkit as unknown as { create(b: Uint8Array): GlyphChecker }).create(await fontBytes(key));
    glyphCheckers.set(key, g);
  }
  return g;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (words.length === 0) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) { line = trial; continue; }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue; }
      let chunk = "";
      for (const ch of word) {
        const next = chunk + ch;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) chunk = next;
        else { if (chunk) lines.push(chunk); chunk = ch; }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

type Fonts = Record<FontKey, PDFFont>;
type Page = ReturnType<PDFDocument["addPage"]>;

/** Draws text, records every line (for snapshots) and every code point per font (for glyph checks). */
class Canvas {
  readonly lines: string[] = [];
  readonly used = new Map<FontKey, Set<number>>();
  constructor(readonly page: Page, readonly fonts: Fonts, public y: number, readonly scale: number) {}

  private keyOf(font: PDFFont): FontKey {
    return (Object.keys(this.fonts) as FontKey[]).find((k) => this.fonts[k] === font) ?? "sans";
  }

  draw(text: string, x: number, y: number, size: number, font: PDFFont, color: RGB = INK): void {
    const key = this.keyOf(font);
    let set = this.used.get(key);
    if (!set) { set = new Set(); this.used.set(key, set); }
    for (const ch of text) set.add(ch.codePointAt(0)!);
    this.lines.push(text);
    this.page.drawText(text, { x, y, size, font, color });
  }

  rule(color: RGB = RULE, thickness = 0.6): void {
    this.page.drawLine({ start: { x: MARGIN_X, y: this.y }, end: { x: PAGE_W - MARGIN_X, y: this.y }, thickness, color });
    this.y -= 10 * this.scale;
  }

  gap(n: number): void { this.y -= n * this.scale; }

  text(raw: string, o: { font: PDFFont; size: number; color?: RGB; x?: number; width?: number; lineGap?: number }): void {
    const size = o.size * this.scale;
    const x = o.x ?? MARGIN_X;
    const width = o.width ?? CONTENT_W;
    const lineGap = (o.lineGap ?? o.size * 0.3) * this.scale;
    for (const line of wrapText(raw, o.font, size, width)) {
      this.draw(line, x, this.y - size, size, o.font, o.color ?? INK);
      this.y -= size + lineGap;
    }
  }

  field(label: string, value: string): void {
    this.text(label.toUpperCase(), { font: this.fonts.sans, size: 6.8, color: MUTED, lineGap: 2 });
    this.text(value, { font: this.fonts.serif, size: 9.6, lineGap: 2.6 });
    this.gap(6);
  }
}

export type CertificateVerdict = "V" | "X" | "pending";

/** Everything the one-page certificate shows. Hashes and labels only, never document content. */
export type CertificateModel = {
  lang?: string;
  tz?: string;
  kind?: "timestamp" | "verification";
  verdict: CertificateVerdict;
  label: string;
  sha256: string;
  gen_time: string | null;
  /**
   * `qualified` must come from the token (see assessQualification). `policy` is the OID read in the token
   * (null/undefined = absent, then never qualified). `signature` must be "verified" for a qualified PDF.
   */
  tsa: null | { provider: string; label: string; qualified: boolean; policy?: string | null; serial?: string; signature?: "verified" | "failed" | "unavailable" | "not_checked" | null };
  /** true when a qualified (Certigna) token is expected but still missing (pending_qualified). */
  pending_qualified?: boolean;
  ots_status?: string | null;
  ots_detail?: string | null;
  /** Overrides the localized OpenTimestamps sentence (legacy French callers). */
  ots_text?: string | null;
  proof_id?: string | null;
  attachments: { name: string; description: string; path?: string; bytes?: Uint8Array }[];
  /** Deterministic output for snapshot tests. */
  fixed_date?: string;
};

export type RenderedCertificate = {
  bytes: Uint8Array;
  pages: number;
  overflow: boolean;
  scale: number;
  lang: Lang;
  lines: string[];
  missing_glyphs: string[];
};

export function localizedOts(lang: string, status?: string | null, detail?: string | null): string {
  const L = loadLocale(lang).cert;
  switch (status) {
    case "confirmed": return lang === "fr" && detail && detail.trim() ? detail : L.ots_confirmed;
    case "pending": return L.ots_pending;
    case "unverified": return L.ots_unverified;
    case "failed": return L.ots_failed;
    default: return L.ots_none;
  }
}

/** Localized one-line verdict for the AI to show (no question, no advice). */
export function localizedVerdict(kind: "intact" | "modifie" | "invalide" | "pending" | "signature_unverified", lang: string, genTime: string | null, tz?: string): string {
  const L = loadLocale(lang).cert;
  const when = genTime ? formatLocalDateTime(genTime, loadLocale(lang).lang, tz) : null;
  const date = when ? `${when.local} (${when.tz}) — ${when.utc} UTC` : "?";
  if (kind === "intact") return fill(L.verdict_intact, { date });
  if (kind === "signature_unverified") return fill(L.verdict_signature_unverified, { date });
  if (kind === "modifie") return fill(L.verdict_modified, { date });
  if (kind === "pending") return L.verdict_pending;
  return L.verdict_invalid;
}

function drawBadge(c: Canvas, cx: number, cy: number, r: number, verdict: CertificateVerdict): void {
  const color = verdict === "V" ? GREEN : verdict === "X" ? RED : AMBER;
  c.page.drawCircle({ x: cx, y: cy, size: r + 4, color: GREEN_SOFT });
  c.page.drawCircle({ x: cx, y: cy, size: r, color });
  const g = verdict === "pending" ? "…" : verdict;
  const size = 13;
  const w = c.fonts.serifBold.widthOfTextAtSize(g, size);
  c.draw(g, cx - w / 2, cy - 4.5, size, c.fonts.serifBold, rgb(1, 1, 1));
}

function attachFiles(doc: PDFDocument, files: { name: string; bytes: Uint8Array; description: string }[]): void {
  if (files.length === 0) return;
  const names = PDFArray.withContext(doc.context);
  const af = PDFArray.withContext(doc.context);
  for (const f of files) {
    const stream = doc.context.flateStream(f.bytes, { Type: "EmbeddedFile", Params: { Size: f.bytes.length } });
    const streamRef = doc.context.register(stream);
    const spec = doc.context.obj({
      Type: "Filespec",
      F: PDFString.of(f.name),
      UF: PDFString.of(f.name),
      Desc: PDFString.of(f.description),
      EF: { F: streamRef },
    });
    const specRef = doc.context.register(spec);
    names.push(PDFString.of(f.name));
    names.push(specRef);
    af.push(specRef);
  }
  const embeddedFiles = doc.context.register(doc.context.obj({ Names: names }));
  doc.catalog.set(PDFName.of("Names"), doc.context.obj({ EmbeddedFiles: embeddedFiles }));
  doc.catalog.set(PDFName.of("AF"), af);
}

async function renderOnce(model: CertificateModel, scale: number): Promise<RenderedCertificate> {
  const locale = loadLocale(model.lang);
  const lang = locale.lang;
  const L = locale.cert;
  const EN = loadLocale("en").cert;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = {} as Fonts;
  for (const k of Object.keys(FONT_FILES) as FontKey[]) fonts[k] = await doc.embedFont(await fontBytes(k), { subset: true });
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const c = new Canvas(page, fonts, PAGE_H - MARGIN_TOP, scale);

  const tokenPolicy = model.tsa?.policy || null;
  const sigVerified = model.tsa?.signature === "verified";
  // Qualified only if the caller derived it from the token AND the token's OID is present AND the
  // signature was verified. No default OID, no "qualified" without a verified signature.
  const qualified = !!model.tsa?.qualified && !!tokenPolicy && sigVerified && !model.pending_qualified && model.verdict !== "pending";
  const sigUnverified = !!model.tsa && !sigVerified;
  const isFreeTsa = model.tsa?.provider === "freetsa";
  const verification = model.kind === "verification";
  const accent = qualified && model.verdict === "V" ? GREEN : RULE;

  // ---- footer (legal notice) is laid out first: content must stay above it ----
  const legalSize = 6.4 * scale;
  const legalGap = 1.6 * scale;
  const legalOwn = [L.legal_art41, L.legal_not_qtsp, L.legal_not, L.legal_hash_only, L.legal_court].join(" ");
  const footerBlocks: { text: string; font: PDFFont; color: RGB }[] = [
    { text: L.legal_title.toUpperCase(), font: fonts.sansBold, color: MUTED },
    { text: legalOwn, font: fonts.sans, color: MUTED },
  ];
  if (lang !== "en" || !locale.reviewed) {
    if (!locale.reviewed) footerBlocks.push({ text: L.mt_notice + (lang !== "en" ? ` — ${EN.mt_notice}` : ""), font: fonts.sansBold, color: WARN_INK });
    if (lang !== "en") {
      footerBlocks.push({ text: [EN.legal_art41, EN.legal_not_qtsp, EN.legal_not, EN.legal_hash_only, EN.legal_court].join(" "), font: fonts.sans, color: MUTED });
    }
  }
  const footerLines: { line: string; font: PDFFont; color: RGB }[] = [];
  for (const b of footerBlocks) for (const line of wrapText(b.text, b.font, legalSize, CONTENT_W)) footerLines.push({ line, font: b.font, color: b.color });
  const footerH = footerLines.length * (legalSize + legalGap);
  const footerTop = MARGIN_BOTTOM + footerH + 6;

  // ---- header ----
  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: qualified ? GREEN : rgb(0.35, 0.34, 0.32) });
  c.draw("XVcache", MARGIN_X, c.y - 16, 13, fonts.serifBold);
  const rightTitle = verification ? L.header_verification : L.header;
  const rw = fonts.sans.widthOfTextAtSize(rightTitle, 7.5);
  c.draw(rightTitle, PAGE_W - MARGIN_X - rw, c.y - 14, 7.5, fonts.sans, MUTED);
  c.y -= 26;
  c.rule(accent, qualified ? 1.2 : 0.6);
  c.gap(6);

  // ---- verdict ----
  const unverifiedV = model.verdict === "V" && model.tsa?.signature !== "verified";
  const title = model.verdict === "X" ? L.title_modified
    : model.verdict === "pending" ? L.title_pending
    : unverifiedV ? L.title_signature_unverified
    : L.title_intact;
  const subtitle = model.verdict === "X" ? L.subtitle_modified
    : model.verdict === "pending" ? L.subtitle_pending
    : unverifiedV ? L.subtitle_signature_unverified
    : L.subtitle_intact;
  const badgeY = c.y - 16;
  drawBadge(c, MARGIN_X + 16, badgeY, 14, model.verdict);
  const titleX = MARGIN_X + 42;
  const titleSize = 18 * scale;
  c.y = badgeY + 2 + titleSize;
  c.text(title, { font: fonts.serifBold, size: 18, x: titleX, width: CONTENT_W - 42, lineGap: 2 });
  c.gap(3);
  c.text(subtitle, { font: fonts.sans, size: 8.2, color: MUTED, x: titleX, width: CONTENT_W - 42, lineGap: 2 });
  c.y = Math.min(c.y, badgeY - 20) - 6;

  // ---- NOT QUALIFIED banner ----
  if (!qualified) {
    const warn = model.pending_qualified || (model.verdict === "pending") ? L.warn_pending
      : isFreeTsa ? L.warn_freetsa
      : sigUnverified ? L.warn_signature_unverified
      : L.warn_other;
    const head = L.banner_not_qualified;
    const warnLines = wrapText(warn, fonts.sans, 8.4 * scale, CONTENT_W - 20);
    const boxH = (warnLines.length + 1) * (8.4 * scale + 3) + 12;
    const boxTop = c.y;
    page.drawRectangle({ x: MARGIN_X, y: boxTop - boxH, width: CONTENT_W, height: boxH, color: WARN_BG });
    c.y = boxTop - 6;
    c.text(head, { font: fonts.sansBold, size: 8.4, color: WARN_INK, x: MARGIN_X + 10, width: CONTENT_W - 20, lineGap: 3 });
    c.text(warn, { font: fonts.sans, size: 8.4, color: WARN_INK, x: MARGIN_X + 10, width: CONTENT_W - 20, lineGap: 3 });
    c.y = boxTop - boxH - 10;
  }

  // ---- fields ----
  c.field(L.field_document, model.label);
  c.field(L.field_sha256, formatGroupedHex(model.sha256));
  if (model.gen_time) {
    const when = formatLocalDateTime(model.gen_time, lang, model.tz);
    c.field(L.field_date, `${when.local} (${L.local_time}, ${when.tz})\n${when.utc} ${L.utc}`);
  } else {
    c.field(L.field_date, L.no_token);
  }
  if (model.tsa) {
    const providerName = (model.tsa.label || "Certigna").replace(/\s*\([^)]*\)\s*$/, "").trim() || "Certigna";
    const sep = lang === "fr" ? " : " : ": ";
    const policyLine = `${L.policy}${sep}${tokenPolicy ?? L.policy_absent}`;
    const lines = qualified
      ? `${providerName}\n${L.provider_qualified}\n${policyLine}`
      : isFreeTsa ? `${L.freetsa_line}\n${L.not_qualified_line}` : `${providerName}\n${L.not_qualified_line}\n${policyLine}`;
    c.field(L.field_provider, lines);
    if (sigUnverified) c.field(L.field_signature, L.signature_unverified_line);
    if (model.tsa.serial) c.field(L.field_serial, formatGroupedHex(model.tsa.serial));
  } else {
    c.field(L.field_provider, model.pending_qualified ? `Certigna — ${L.verdict_pending}` : L.no_provider);
  }
  c.field(L.field_qualified, qualified ? L.yes : L.no);
  c.field(L.field_ots, model.ots_text ?? localizedOts(lang, model.ots_status, model.ots_detail));
  if (model.proof_id) c.field(L.field_proof_id, model.proof_id);
  c.rule();

  // ---- how to verify again ----
  c.text(L.reverify_title, { font: fonts.serifBold, size: 10.5, lineGap: 4 });
  const since = model.gen_time ? formatLocalDateTime(model.gen_time, lang, model.tz).local : "…";
  for (const [i, step] of [L.reverify_1, L.reverify_2, fill(L.reverify_3, { date: since })].entries()) {
    c.text(`${i + 1}.  ${step}`, { font: fonts.serif, size: 9.2, lineGap: 2.4 });
  }
  c.gap(4);
  c.rule();

  // ---- attachments ----
  c.text(L.attachments_title, { font: fonts.serifBold, size: 10.5, lineGap: 4 });
  if (model.attachments.length === 0) c.text(L.attachments_none, { font: fonts.serif, size: 9.2, lineGap: 2.4 });
  for (const a of model.attachments) c.text(`${a.name}  —  ${a.description}`, { font: fonts.serif, size: 9.2, lineGap: 2.4 });

  const overflow = c.y < footerTop;

  // ---- draw footer ----
  page.drawLine({ start: { x: MARGIN_X, y: footerTop - 2 }, end: { x: PAGE_W - MARGIN_X, y: footerTop - 2 }, thickness: 0.5, color: RULE });
  let fy = footerTop - 4;
  for (const f of footerLines) {
    c.draw(f.line, MARGIN_X, fy - legalSize, legalSize, f.font, f.color);
    fy -= legalSize + legalGap;
  }

  doc.setTitle(`XVcache — ${model.label}`);
  doc.setAuthor("XVcache");
  doc.setSubject(qualified ? "Qualified eIDAS electronic timestamp certificate" : "Timestamp certificate (not qualified)");
  doc.setCreator("XVcache");
  doc.setProducer("XVcache");
  doc.setLanguage(lang);
  const created = model.fixed_date ?? model.gen_time;
  if (created) { doc.setCreationDate(new Date(created)); doc.setModificationDate(new Date(created)); }
  doc.setKeywords(["XVcache", lang, qualified ? "eIDAS" : "not-qualified", model.label]);

  const embedded: { name: string; bytes: Uint8Array; description: string }[] = [];
  for (const a of model.attachments) {
    if (a.bytes) embedded.push({ name: a.name, bytes: a.bytes, description: a.description });
    else if (a.path) {
      try { embedded.push({ name: a.name, bytes: await fs.readFile(a.path), description: a.description }); } catch { /* skip missing */ }
    }
  }
  attachFiles(doc, embedded);

  const missing: string[] = [];
  for (const [key, cps] of c.used) {
    const g = await glyphChecker(key);
    for (const cp of cps) {
      if (cp === 0x20 || cp === 0x0a) continue;
      if (!g.hasGlyphForCodePoint(cp)) missing.push(`${FONT_FILES[key]}:U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pages: doc.getPageCount(), overflow, scale, lang, lines: c.lines, missing_glyphs: missing };
}

/** Render a one-page certificate. Shrinks the type slightly if a long language would overflow. */
export async function renderCertificate(model: CertificateModel): Promise<RenderedCertificate> {
  let last: RenderedCertificate | null = null;
  for (const scale of [1, 0.94, 0.88, 0.82]) {
    last = await renderOnce(model, scale);
    if (!last.overflow) return last;
  }
  return last!;
}

/** Stable proof identifier for a local proof: `<batch_id>.<leaf_index>`. */
export function localProofId(proof: Proof): string {
  return `${proof.batch_id}.${proof.merkle.leaf_index}`;
}

export function modelFromProof(proof: Proof, opts: { lang?: string; tz?: string; otsText?: string | null; otsStatus?: string | null; otsDetail?: string | null; attachments: Attachment[]; qualification?: Qualification | null }): CertificateModel {
  const q = opts.qualification ?? null;
  return {
    lang: opts.lang,
    tz: opts.tz,
    kind: "timestamp",
    verdict: "V",
    label: proof.path,
    sha256: proof.note_sha256,
    gen_time: proof.tsa?.gen_time ?? null,
    // Qualification, OID and signature status come from the token assessment, never from the stored JSON.
    tsa: proof.tsa ? { provider: proof.tsa.provider, label: proof.tsa.label, qualified: !!q?.qualified, policy: q ? q.policy : null, serial: proof.tsa.serial, signature: q ? q.signature : "not_checked" } : null,
    ots_status: opts.otsStatus ?? proof.ots?.status ?? null,
    ots_detail: opts.otsDetail ?? proof.ots?.detail ?? null,
    ots_text: opts.otsText ?? null,
    proof_id: localProofId(proof),
    attachments: opts.attachments,
  };
}

/** Backward-compatible entry point (French by default, as before). */
export async function buildCertificatePdf(opts: {
  proof: Proof;
  otsText?: string;
  attachments: Attachment[];
  lang?: string;
  tz?: string;
  /** Token assessment; omitted → recomputed from the token against the bundled Certigna chain. */
  qualification?: Qualification | null;
}): Promise<Uint8Array> {
  const lang = opts.lang ?? "fr";
  let qualification = opts.qualification;
  if (qualification === undefined) {
    qualification = opts.proof.tsa ? await assessQualification(Buffer.from(opts.proof.tsa.token_base64, "base64"), opts.proof.merkle.root) : null;
  }
  const r = await renderCertificate(modelFromProof(opts.proof, { lang, tz: opts.tz, otsText: lang === "fr" ? opts.otsText : null, attachments: opts.attachments, qualification }));
  return r.bytes;
}
