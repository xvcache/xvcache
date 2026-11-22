import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PDFDocument, PDFName, PDFString, PDFArray, StandardFonts, rgb,
  type PDFFont, type RGB,
} from "pdf-lib";
import { sha256Hex, normalizeNotePath } from "./journal.js";
import { Certifier, PROOF_FORMAT, type Proof, type VerifyReport } from "./certify.js";

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
  kind: "intact" | "modifie" | "invalide";
  title: string;
  sentence: string;
  since: string | null;
};

export function humanVerdict(report: VerifyReport): HumanVerdict {
  const when = report.gen_time ? formatParisDateTime(report.gen_time) : null;
  const since = when ? when.short : null;
  const noteChanged = report.checks.note?.ok === false;
  if (report.glyph === "V") {
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

  const pdfPath = path.join(dir, "certificat.pdf");
  const bytes = await buildCertificatePdf({
    proof,
    otsText: otsHuman(opts.otsStatus ?? proof.ots?.status, opts.otsDetail ?? proof.ots?.detail),
    attachments,
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
  },
): Promise<DocumentResult> {
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

  if (report.glyph !== "V") return fromReport(report, { stamped, path: found.proof.path });

  const pack = await writeCertificatePack({
    proof: JSON.parse(await fs.readFile(found.file, "utf8")) as Proof,
    dataDir: certifier.cfg.dataDir,
    batchesDir: certifier.batchesDir(),
    proofFile: found.file,
    otsStatus: report.ots?.status ?? found.proof.ots?.status,
    otsDetail: report.ots?.detail ?? found.proof.ots?.detail,
  });
  return fromReport(report, {
    stamped,
    path: found.proof.path,
    pdf: pack.pdf,
    pack: pack.dir,
    attachments: pack.attachments,
  });
}

/* -------------------------------------------------------------------------- */
/* PDF                                                                        */
/* -------------------------------------------------------------------------- */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 42;
const INK = rgb(0.12, 0.12, 0.11);
const MUTED = rgb(0.38, 0.37, 0.35);
const RULE = rgb(0.78, 0.76, 0.72);
const GREEN = rgb(0.06, 0.42, 0.28);
const GREEN_SOFT = rgb(0.93, 0.96, 0.94);
const WARN_BG = rgb(0.99, 0.95, 0.88);
const WARN_INK = rgb(0.42, 0.25, 0.05);
const CONTENT_W = PAGE_W - 2 * MARGIN_X;

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const ch of word) {
        const next = chunk + ch;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) chunk = next;
        else {
          if (chunk) lines.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

type Fonts = { times: PDFFont; timesBold: PDFFont; helv: PDFFont; helvBold: PDFFont; helvOblique: PDFFont };

class Pen {
  constructor(
    private page: ReturnType<PDFDocument["addPage"]>,
    private fonts: Fonts,
    public y: number,
  ) {}

  rule(color: RGB = RULE, thickness = 0.6): void {
    this.page.drawLine({
      start: { x: MARGIN_X, y: this.y },
      end: { x: PAGE_W - MARGIN_X, y: this.y },
      thickness,
      color,
    });
    this.y -= 14;
  }

  gap(n: number): void { this.y -= n; }

  text(raw: string, opts: { font: PDFFont; size: number; color?: RGB; x?: number; width?: number; lineGap?: number; align?: "left" | "right" }): number {
    const color = opts.color ?? INK;
    const x = opts.x ?? MARGIN_X;
    const width = opts.width ?? CONTENT_W;
    const lineGap = opts.lineGap ?? opts.size * 0.35;
    const lines = wrapText(raw, opts.font, opts.size, width);
    for (const line of lines) {
      const w = opts.font.widthOfTextAtSize(line, opts.size);
      const tx = opts.align === "right" ? x + width - w : x;
      this.page.drawText(line, { x: tx, y: this.y - opts.size, size: opts.size, font: opts.font, color });
      this.y -= opts.size + lineGap;
    }
    return lines.length;
  }

  field(label: string, value: string): void {
    this.text(label.toUpperCase(), { font: this.fonts.helv, size: 7.5, color: MUTED, lineGap: 3 });
    this.text(value, { font: this.fonts.times, size: 11, color: INK, lineGap: 3.5 });
    this.gap(10);
  }
}

function drawBadge(page: ReturnType<PDFDocument["addPage"]>, fonts: Fonts, cx: number, cy: number, r: number): void {
  page.drawCircle({ x: cx, y: cy, size: r + 4, color: GREEN_SOFT });
  page.drawCircle({ x: cx, y: cy, size: r, color: GREEN });
  const v = "V";
  const size = 13;
  const w = fonts.timesBold.widthOfTextAtSize(v, size);
  page.drawText(v, { x: cx - w / 2, y: cy - 4.5, size, font: fonts.timesBold, color: rgb(1, 1, 1) });
}

function attachFiles(doc: PDFDocument, files: { name: string; bytes: Uint8Array; description: string }[]): void {
  if (files.length === 0) return;
  const names = PDFArray.withContext(doc.context);
  const af = PDFArray.withContext(doc.context);
  for (const f of files) {
    const stream = doc.context.flateStream(f.bytes, {
      Type: "EmbeddedFile",
      Params: { Size: f.bytes.length },
    });
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

export async function buildCertificatePdf(opts: {
  proof: Proof;
  otsText: string;
  attachments: Attachment[];
}): Promise<Uint8Array> {
  const { proof } = opts;
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    times: await doc.embedFont(StandardFonts.TimesRoman),
    timesBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    helv: await doc.embedFont(StandardFonts.Helvetica),
    helvBold: await doc.embedFont(StandardFonts.HelveticaBold),
    helvOblique: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const pen = new Pen(page, fonts, PAGE_H - MARGIN_TOP);

  const qualified = !!proof.tsa?.qualified;
  const providerId = proof.tsa?.provider ?? "";
  const isFreeTsa = providerId === "freetsa";
  const when = proof.tsa?.gen_time ? formatParisDateTime(proof.tsa.gen_time) : null;
  const fileName = proof.path;
  const accent = qualified ? GREEN : RULE;

  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: qualified ? GREEN : rgb(0.35, 0.34, 0.32) });

  const brand = "XVcache";
  page.drawText(brand, { x: MARGIN_X, y: pen.y - 16, size: 13, font: fonts.timesBold, color: INK });
  const rightTitle = "CERTIFICAT D'HORODATAGE";
  const rw = fonts.helv.widthOfTextAtSize(rightTitle, 8);
  page.drawText(rightTitle, { x: PAGE_W - MARGIN_X - rw, y: pen.y - 14, size: 8, font: fonts.helv, color: MUTED });
  pen.y -= 28;
  pen.rule(accent, qualified ? 1.2 : 0.6);
  pen.gap(8);

  const badgeY = pen.y - 16;
  drawBadge(page, fonts, MARGIN_X + 16, badgeY, 14);
  const titleX = MARGIN_X + 42;
  page.drawText("Document intact", { x: titleX, y: badgeY + 2, size: 20, font: fonts.timesBold, color: INK });
  page.drawText("Verdict V  —  l'empreinte n'a pas changé depuis l'horodatage.", {
    x: titleX, y: badgeY - 14, size: 9, font: fonts.helv, color: MUTED,
  });
  pen.y = badgeY - 32;

  if (!qualified) {
    const boxTop = pen.y;
    const warn = isFreeTsa
      ? "Attention : ceci n'est PAS un horodatage qualifié eIDAS. Le jeton provient de FreeTSA et sert uniquement aux essais. Il n'a pas de présomption légale."
      : "Attention : ceci n'est PAS un horodatage qualifié eIDAS. Le prestataire n'est pas un service de confiance qualifié.";
    const warnLines = wrapText(warn, fonts.helv, 9, CONTENT_W - 20);
    const boxH = warnLines.length * 12 + 16;
    page.drawRectangle({ x: MARGIN_X, y: boxTop - boxH, width: CONTENT_W, height: boxH, color: WARN_BG });
    pen.y = boxTop - 10;
    pen.text(warn, { font: fonts.helv, size: 9, color: WARN_INK, x: MARGIN_X + 10, width: CONTENT_W - 20, lineGap: 3 });
    pen.y = boxTop - boxH - 14;
  }

  pen.field("Fichier", fileName);
  pen.field("Empreinte SHA-256", formatGroupedHex(proof.note_sha256));

  if (when) {
    pen.field("Date et heure", `${when.long}\n(${when.tz})`);
  } else {
    pen.field("Date et heure", "Aucun jeton d'horodatage dans cette preuve.");
  }

  if (proof.tsa) {
    const providerName = (proof.tsa.label || "Certigna").replace(/\s*\([^)]*\)\s*$/, "").trim() || "Certigna";
    const providerLines = qualified
      ? `${providerName}\nHorodatage électronique qualifié eIDAS\nRéférence de politique : ${proof.tsa.policy || "1.2.250.1.177.2.9.1"}`
      : isFreeTsa
        ? "FreeTSA — jeton de test uniquement.\nCeci n'est PAS un horodatage qualifié eIDAS."
        : `${proof.tsa.label || proof.tsa.provider}\nCeci n'est PAS un horodatage qualifié eIDAS.`;
    pen.field("Prestataire", providerLines);
    if (proof.tsa.serial) pen.field("Numéro de série du jeton", formatGroupedHex(proof.tsa.serial));
  } else {
    pen.field("Prestataire", "Aucun prestataire d'horodatage dans cette preuve.");
  }

  pen.field("Ancrage public (OpenTimestamps)", opts.otsText);
  pen.rule();
  pen.gap(2);

  pen.text("Pour revérifier", { font: fonts.timesBold, size: 12, lineGap: 8 });
  const since = when ? when.short : "la date d'horodatage";
  const steps = [
    "1.  Redéposez le même fichier dans XVcache.",
    "2.  L'outil compare son empreinte à celle écrite sur ce certificat.",
    `3.  Vous obtenez «${NBSP}Intact${NBSP}» ou «${NBSP}Modifié depuis le ${since}${NBSP}».`,
  ];
  for (const step of steps) {
    pen.text(step, { font: fonts.times, size: 11, lineGap: 5 });
  }
  pen.gap(8);
  pen.rule();
  pen.gap(2);

  pen.text("Fichiers techniques joints à ce certificat", { font: fonts.timesBold, size: 12, lineGap: 8 });
  if (opts.attachments.length === 0) {
    pen.text("Aucun fichier technique n'a pu être joint.", { font: fonts.times, size: 11, lineGap: 5 });
  } else {
    for (const a of opts.attachments) {
      pen.text(`${a.name}  —  ${a.description}`, { font: fonts.times, size: 11, lineGap: 5 });
    }
  }

  const disclaimer =
    "Ce document n'est pas un constat d'huissier, ni une signature électronique qualifiée, ni un conseil juridique.";
  const discLines = wrapText(disclaimer, fonts.helvOblique, 8, CONTENT_W);
  const footerY = MARGIN_BOTTOM + discLines.length * 11 + 10;
  if (pen.y < footerY + 8) {
    /* content already above footer; if not, the footer still draws over the bottom margin */
  }
  page.drawLine({
    start: { x: MARGIN_X, y: footerY + discLines.length * 11 + 8 },
    end: { x: PAGE_W - MARGIN_X, y: footerY + discLines.length * 11 + 8 },
    thickness: 0.5,
    color: RULE,
  });
  let dy = footerY + discLines.length * 11 - 8;
  for (const line of discLines) {
    page.drawText(line, { x: MARGIN_X, y: dy - 8, size: 8, font: fonts.helvOblique, color: MUTED });
    dy -= 11;
  }

  doc.setTitle(`Certificat XVcache — ${fileName}`);
  doc.setAuthor("XVcache");
  doc.setSubject(qualified ? "Certificat d'horodatage électronique qualifié eIDAS" : "Certificat d'horodatage (non qualifié)");
  doc.setCreator("XVcache");
  doc.setProducer("XVcache");
  if (when) doc.setCreationDate(new Date(when.iso));
  doc.setKeywords(["XVcache", "horodatage", qualified ? "eIDAS" : "test", fileName]);

  const embedded: { name: string; bytes: Uint8Array; description: string }[] = [];
  for (const a of opts.attachments) {
    try {
      embedded.push({ name: a.name, bytes: await fs.readFile(a.path), description: a.description });
    } catch { /* skip missing */ }
  }
  attachFiles(doc, embedded);

  return doc.save();
}
