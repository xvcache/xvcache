import { promises as fs } from "node:fs";
import path from "node:path";
import {
  sha256Hex, verifyJournalFile, readCompleteJournalLines, parseEntry, lastNoteRecord, normalizeNotePath,
  type JournalEntry,
} from "./journal.js";
import { leafHash, merkleRoot, merklePath, verifyMerklePath, type LeafData, type MerkleStep, type NoteLeaf } from "./merkle.js";
import {
  requestTimestamp, parseTimeStampToken, verifyTokenSignature, certsDir, OID_SHA256,
  type TsaProvider, type FetchLike, type SignatureCheck,
} from "./tsa.js";
import { stampDigest, serializeOts, parseOts, upgradeTimestamp, otsStatus, DEFAULT_CALENDARS, type OtsStatus } from "./ots.js";

export const PROOF_FORMAT = "xvcache-proof/1";

export type CertifyConfig = {
  vaultRoot: string;
  journalPath: string;
  dataDir: string;
  tsa: TsaProvider | null;
  ots: { enabled: boolean; calendars: string[] };
  fetchImpl?: typeof fetch;
};

export function certifyConfigFromEnv(base: { vaultRoot: string; journalPath: string; tsa: TsaProvider | null }, env: NodeJS.ProcessEnv = process.env): CertifyConfig {
  const dataDir = env.XVCACHE_DATA ? path.resolve(env.XVCACHE_DATA) : path.join(path.dirname(base.journalPath), ".xvcache");
  const otsOff = (env.XVCACHE_OTS ?? "on").toLowerCase();
  const calendars = env.XVCACHE_OTS_CALENDARS ? env.XVCACHE_OTS_CALENDARS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_CALENDARS;
  return { ...base, dataDir, ots: { enabled: !(otsOff === "off" || otsOff === "0" || otsOff === "false"), calendars } };
}

type Pending = { path: string; note_sha256: string; queued_at: string; journal_status: JournalStatus };
type JournalStatus = "V" | "X" | "non journalisée" | "journal altéré";

export type Proof = {
  format: string;
  path: string;
  note_sha256: string;
  leaf: NoteLeaf;
  leaf_hash: string;
  merkle: { scheme: string; leaf_index: number; leaf_count: number; path: MerkleStep[]; root: string };
  batch_id: string;
  batch_created_at: string;
  queued_at: string;
  journal_status_at_certification: JournalStatus;
  journal_head: { seq: number; hash: string; leaf_hash: string } | null;
  tsa: null | {
    provider: string;
    label: string;
    url: string;
    qualified: boolean;
    qualified_basis: string;
    hash_algorithm: "sha256";
    message_imprint: string;
    gen_time: string;
    serial: string;
    policy: string;
    token_base64: string;
  };
  ots: null | { status: string; calendars: string[]; ots_base64: string; detail: string };
  billing: { paid_feature: true; price: "TBD"; payment_live: false };
  notice: string;
};

const NOTICE =
  "This proof contains hashes only, never note content. Layer A: RFC 3161 token over the Merkle root (legal value only if the provider is qualified eIDAS). Layer B: OpenTimestamps anchor of the same root (public, Bitcoin, confirmation takes hours). One timestamp covers every note in the batch.";

const HEX64 = /^[0-9a-f]{64}$/;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve a vault-relative .md note with the same rules as verify_journal. */
export async function resolveNoteInVault(vaultRoot: string, rel: string): Promise<{ real: string; relMd: string } | { error: string }> {
  if (path.isAbsolute(rel)) return { error: "Refusé : chemin absolu interdit." };
  const norm = rel.replace(/\\/g, "/");
  if (norm.split("/").some((p) => p === "..")) return { error: "Refusé : chemin hors du coffre." };
  const relMd = normalizeNotePath(norm).replace(/^\.\//, "");
  const target = path.resolve(vaultRoot, relMd);
  if (!target.startsWith(vaultRoot + path.sep)) return { error: "Refusé : chemin hors du coffre." };
  let real: string;
  try { real = await fs.realpath(target); } catch { return { error: "Note introuvable." }; }
  if (!real.startsWith(vaultRoot + path.sep)) return { error: "Refusé : lien symbolique hors du coffre." };
  return { real, relMd: path.relative(vaultRoot, real).split(path.sep).join("/") };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  await fs.rename(tmp, file);
}

function batchIdFor(date: Date, root: string): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z") + "-" + root.slice(0, 8);
}

export type CheckResult = { ok: boolean | null; detail: string };

export type VerifyReport = {
  glyph: "V" | "X";
  message: string;
  path: string | null;
  batch_id: string | null;
  root: string | null;
  gen_time: string | null;
  provider: string | null;
  qualified: boolean;
  qualified_confirmed: boolean;
  checks: Record<string, CheckResult>;
  ots: OtsStatus | null;
};

export class Certifier {
  readonly cfg: CertifyConfig;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(cfg: CertifyConfig) { this.cfg = cfg; }

  private get pendingFile(): string { return path.join(this.cfg.dataDir, "pending.json"); }
  proofsDir(): string { return path.join(this.cfg.dataDir, "proofs"); }
  batchesDir(): string { return path.join(this.cfg.dataDir, "batches"); }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private async journalEntries(): Promise<{ ok: boolean; entries: JournalEntry[]; lastSeq?: number; lastHash?: string }> {
    const chain = await verifyJournalFile(this.cfg.journalPath);
    if (!chain.ok) return { ok: false, entries: [] };
    const entries: JournalEntry[] = [];
    for (const line of await readCompleteJournalLines(this.cfg.journalPath)) {
      const p = parseEntry(line);
      if (!("error" in p)) entries.push(p);
    }
    return { ok: true, entries, lastSeq: chain.lastSeq, lastHash: chain.lastHash };
  }

  async pending(): Promise<Pending[]> {
    return readJson<Pending[]>(this.pendingFile, []);
  }

  /** Add the note's current fingerprint to the pending batch. */
  async enqueue(rel: string): Promise<Pending | { error: string }> {
    return this.serialize(async () => {
      const r = await resolveNoteInVault(this.cfg.vaultRoot, rel);
      if ("error" in r) return r;
      const sha = sha256Hex(await fs.readFile(r.real));
      const j = await this.journalEntries();
      let journal_status: JournalStatus;
      if (!j.ok) journal_status = "journal altéré";
      else {
        const rec = lastNoteRecord(j.entries, r.relMd);
        journal_status = !rec ? "non journalisée" : rec.note_sha256 === sha ? "V" : "X";
      }
      const item: Pending = { path: r.relMd, note_sha256: sha, queued_at: new Date().toISOString(), journal_status };
      const list = (await this.pending()).filter((p) => p.path !== item.path);
      list.push(item);
      await writeJsonAtomic(this.pendingFile, list);
      return item;
    });
  }

  /** Stamp every pending note with one timestamp over the Merkle root. */
  async runBatch(): Promise<{ batch_id: string; root: string; leaf_count: number; proofs: Proof[]; tsa_error?: string; ots_error?: string } | { error: string }> {
    return this.serialize(async () => {
      const list = (await this.pending()).slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (list.length === 0) return { error: "Aucune note en attente de certification." };
      if (!this.cfg.tsa && !this.cfg.ots.enabled) return { error: "Aucun témoin configuré (TSA désactivée et OpenTimestamps désactivé)." };

      const leaves: LeafData[] = list.map((p) => ({ k: "note", p: p.path, h: p.note_sha256 }));
      const j = await this.journalEntries();
      let journalHead: Proof["journal_head"] = null;
      if (j.ok && j.lastSeq && j.lastHash) {
        const jl: LeafData = { k: "journal", seq: j.lastSeq, h: j.lastHash };
        leaves.push(jl);
        journalHead = { seq: j.lastSeq, hash: j.lastHash, leaf_hash: leafHash(jl) };
      }
      const hashes = leaves.map(leafHash);
      const root = merkleRoot(hashes);

      let tsa: Proof["tsa"] = null;
      let tokenDer: Buffer | null = null;
      if (this.cfg.tsa) {
        try {
          const res = await requestTimestamp(this.cfg.tsa, root, { fetchImpl: this.cfg.fetchImpl as unknown as FetchLike | undefined });
          tokenDer = res.token;
          tsa = {
            provider: this.cfg.tsa.id,
            label: this.cfg.tsa.label,
            url: this.cfg.tsa.url,
            qualified: this.cfg.tsa.qualified,
            qualified_basis: this.cfg.tsa.qualifiedBasis,
            hash_algorithm: "sha256",
            message_imprint: res.info.messageImprint,
            gen_time: res.info.genTime,
            serial: res.info.serial,
            policy: res.info.policy,
            token_base64: res.token.toString("base64"),
          };
        } catch (e) {
          return { error: `Horodatage TSA impossible, notes laissées en attente : ${errMsg(e)}` };
        }
      }

      let ots: Proof["ots"] = null;
      let otsBuf: Buffer | null = null;
      let ots_error: string | undefined;
      if (this.cfg.ots.enabled) {
        try {
          const s = await stampDigest(Buffer.from(root, "hex"), this.cfg.ots.calendars, this.cfg.fetchImpl);
          otsBuf = serializeOts(s.ts);
          ots = { status: "pending", calendars: s.calendars, ots_base64: otsBuf.toString("base64"), detail: "Soumis aux calendriers OpenTimestamps ; confirmation Bitcoin en quelques heures." };
        } catch (e) {
          ots_error = errMsg(e);
          if (!tsa) return { error: `Aucun témoin n'a répondu, notes laissées en attente : ${ots_error}` };
        }
      }

      const created = new Date();
      const batchId = batchIdFor(created, root);
      const bdir = path.join(this.batchesDir(), batchId);
      await fs.mkdir(bdir, { recursive: true });
      if (tokenDer) await fs.writeFile(path.join(bdir, "root.tst"), tokenDer);
      if (otsBuf) await fs.writeFile(path.join(bdir, "root.ots"), otsBuf);
      await writeJsonAtomic(path.join(bdir, "batch.json"), {
        format: "xvcache-batch/1",
        batch_id: batchId,
        created_at: created.toISOString(),
        root,
        leaf_hashes: hashes,
        notes: list.map((p) => ({ path: p.path, note_sha256: p.note_sha256 })),
        journal_head: journalHead,
        tsa: tsa ? { provider: tsa.provider, qualified: tsa.qualified, gen_time: tsa.gen_time, serial: tsa.serial } : null,
        ots: ots ? { status: ots.status, calendars: ots.calendars } : ots_error ? { status: "error", error: ots_error } : null,
      });

      const proofs: Proof[] = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const proof: Proof = {
          format: PROOF_FORMAT,
          path: p.path,
          note_sha256: p.note_sha256,
          leaf: leaves[i] as NoteLeaf,
          leaf_hash: hashes[i],
          merkle: { scheme: "sha256, leaf=H(0x00||canonical_json(leaf)), node=H(0x01||L||R), odd node promoted", leaf_index: i, leaf_count: hashes.length, path: merklePath(hashes, i), root },
          batch_id: batchId,
          batch_created_at: created.toISOString(),
          queued_at: p.queued_at,
          journal_status_at_certification: p.journal_status,
          journal_head: journalHead,
          tsa,
          ots,
          billing: { paid_feature: true, price: "TBD", payment_live: false },
          notice: NOTICE,
        };
        await writeJsonAtomic(this.proofFile(p.path, batchId), proof);
        proofs.push(proof);
      }
      const remaining = (await this.pending()).filter((q) => !list.some((p) => p.path === q.path && p.note_sha256 === q.note_sha256));
      await writeJsonAtomic(this.pendingFile, remaining);
      return { batch_id: batchId, root, leaf_count: hashes.length, proofs, ots_error };
    });
  }

  proofFile(rel: string, batchId: string): string {
    return path.join(this.proofsDir(), ...rel.split("/"), `${batchId}.json`);
  }

  async latestProofFile(rel: string): Promise<string | null> {
    const dir = path.join(this.proofsDir(), ...rel.split("/"));
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return null; }
    const jsons = names.filter((n) => n.endsWith(".json")).sort();
    return jsons.length ? path.join(dir, jsons[jsons.length - 1]) : null;
  }

  private caFor(provider: string): { ca?: string; untrusted?: string } {
    if (this.cfg.tsa && this.cfg.tsa.id === provider) return { ca: this.cfg.tsa.caFile, untrusted: this.cfg.tsa.untrustedFile };
    if (provider === "freetsa") return { ca: path.join(certsDir(), "freetsa-cacert.pem") };
    return {};
  }

  /** Check a proof: note hash, Merkle path, TSA token, OpenTimestamps anchor. */
  async verify(input: { path?: string; proof?: unknown; online?: boolean }): Promise<VerifyReport> {
    const checks: Record<string, CheckResult> = {};
    const report = (glyphOk: boolean, p: Partial<Proof> | null, extra: Partial<VerifyReport> = {}): VerifyReport => {
      const qualified = !!p?.tsa?.qualified;
      const qualified_confirmed = qualified && checks.tsa_signature?.ok === true;
      const shown = p?.path ?? input.path ?? "?";
      const when = p?.tsa?.gen_time ? ` le ${p.tsa.gen_time}` : "";
      const level = p?.tsa ? (qualified_confirmed ? "horodatage qualifié eIDAS" : qualified ? "fournisseur qualifié, signature non vérifiée" : p.tsa.label.replace(" (", ", ").replace(/\)$/, "")) : "ancrage OpenTimestamps seul";
      const failed = Object.entries(checks).filter(([, c]) => c.ok === false).map(([k, c]) => `${k} : ${c.detail.replace(/\.$/, "")}`);
      return {
        glyph: glyphOk ? "V" : "X",
        message: glyphOk
          ? `V  certifiée — Note ${shown} existait telle quelle${when} (${level}).`
          : `X  preuve invalide — Note ${shown} : ${failed.join(" ; ") || "preuve illisible"}.`,
        path: p?.path ?? input.path ?? null,
        batch_id: p?.batch_id ?? null,
        root: p?.merkle?.root ?? null,
        gen_time: p?.tsa?.gen_time ?? null,
        provider: p?.tsa?.provider ?? null,
        qualified,
        qualified_confirmed,
        checks,
        ots: null,
        ...extra,
      };
    };

    let proof: Proof;
    let proofFile: string | null = null;
    try {
      if (input.proof !== undefined && input.proof !== null && input.proof !== "") {
        proof = (typeof input.proof === "string" ? JSON.parse(input.proof) : input.proof) as Proof;
      } else if (input.path) {
        const r = await resolveNoteInVault(this.cfg.vaultRoot, input.path);
        const rel = "error" in r ? normalizeNotePath(input.path.replace(/\\/g, "/")) : r.relMd;
        proofFile = await this.latestProofFile(rel);
        if (!proofFile) { checks.proof = { ok: false, detail: "Aucune preuve enregistrée pour cette note (lancer certify_note)." }; return report(false, null); }
        proof = JSON.parse(await fs.readFile(proofFile, "utf8")) as Proof;
      } else {
        checks.proof = { ok: false, detail: "Donner path ou proof." };
        return report(false, null);
      }
    } catch (e) {
      checks.proof = { ok: false, detail: `Preuve illisible : ${errMsg(e)}` };
      return report(false, null);
    }
    if (!proof || proof.format !== PROOF_FORMAT || typeof proof.path !== "string" || !HEX64.test(String(proof.note_sha256)) || !proof.merkle || !HEX64.test(String(proof.merkle.root))) {
      checks.proof = { ok: false, detail: "Format de preuve non reconnu." };
      return report(false, null);
    }
    checks.proof = { ok: true, detail: `Preuve ${proof.batch_id}.` };

    if (input.path && input.proof) {
      const want = normalizeNotePath(input.path.replace(/\\/g, "/"));
      if (want !== proof.path) checks.path = { ok: false, detail: `La preuve concerne ${proof.path}, pas ${want}.` };
    }

    // 1) note content now vs certified fingerprint
    const r = await resolveNoteInVault(this.cfg.vaultRoot, proof.path);
    if ("error" in r) checks.note = { ok: false, detail: r.error };
    else {
      const cur = sha256Hex(await fs.readFile(r.real));
      checks.note = cur === proof.note_sha256
        ? { ok: true, detail: "Empreinte actuelle identique à l'empreinte certifiée." }
        : { ok: false, detail: "Note MODIFIÉE depuis la certification (empreinte différente)." };
    }

    // 2) leaf + Merkle path -> root
    const leaf: NoteLeaf = { k: "note", p: proof.path, h: proof.note_sha256 };
    const lh = leafHash(leaf);
    if (lh !== proof.leaf_hash) checks.merkle = { ok: false, detail: "Feuille recalculée différente." };
    else checks.merkle = verifyMerklePath(lh, proof.merkle.path ?? [], proof.merkle.root)
      ? { ok: true, detail: `Chemin Merkle valide (${proof.merkle.path.length} étape(s), ${proof.merkle.leaf_count} feuille(s) sous la même racine).` }
      : { ok: false, detail: "Chemin Merkle ne mène pas à la racine." };

    // 3) RFC 3161 token
    if (proof.tsa) {
      try {
        const token = Buffer.from(proof.tsa.token_base64, "base64");
        const info = parseTimeStampToken(token);
        if (info.hashAlgorithm !== OID_SHA256 || info.messageImprint !== proof.merkle.root) {
          checks.tsa_token = { ok: false, detail: "Le jeton TSA ne porte pas sur cette racine." };
        } else if (info.genTime !== proof.tsa.gen_time) {
          checks.tsa_token = { ok: false, detail: "Date du jeton différente de la date annoncée." };
        } else {
          checks.tsa_token = { ok: true, detail: `Jeton RFC 3161 sur la racine, genTime ${info.genTime}, série ${info.serial}.` };
        }
        const ca = this.caFor(proof.tsa.provider);
        const sig: SignatureCheck = await verifyTokenSignature(token, proof.merkle.root, ca.ca, ca.untrusted);
        checks.tsa_signature = { ok: sig.status === "verified" ? true : sig.status === "failed" ? false : null, detail: sig.detail };
      } catch (e) {
        checks.tsa_token = { ok: false, detail: `Jeton TSA illisible : ${errMsg(e)}` };
      }
    } else {
      checks.tsa_token = { ok: null, detail: "Pas de jeton TSA dans cette preuve." };
    }

    // 4) OpenTimestamps
    let ots: OtsStatus | null = null;
    if (proof.ots?.ots_base64) {
      try {
        const ts = parseOts(Buffer.from(proof.ots.ots_base64, "base64"));
        if (ts.msg.toString("hex") !== proof.merkle.root) {
          checks.ots = { ok: false, detail: "Le fichier .ots ne porte pas sur cette racine." };
        } else {
          const online = input.online !== false;
          if (online && (await upgradeTimestamp(ts, this.cfg.fetchImpl))) {
            const buf = serializeOts(ts);
            proof.ots.ots_base64 = buf.toString("base64");
            const bdir = path.join(this.batchesDir(), proof.batch_id);
            await fs.writeFile(path.join(bdir, "root.ots"), buf).catch(() => {});
          }
          ots = await otsStatus(ts, { online, f: this.cfg.fetchImpl });
          proof.ots.status = ots.status;
          proof.ots.detail = ots.detail;
          if (proofFile) await writeJsonAtomic(proofFile, proof).catch(() => {});
          checks.ots = { ok: ots.status === "failed" ? false : ots.status === "confirmed" ? true : null, detail: ots.detail };
        }
      } catch (e) {
        checks.ots = { ok: false, detail: `Fichier .ots illisible : ${errMsg(e)}` };
      }
    } else {
      checks.ots = { ok: null, detail: "Pas d'ancrage OpenTimestamps dans cette preuve." };
    }

    const anyWitness = checks.tsa_token.ok === true || (checks.ots.ok !== false && !!proof.ots?.ots_base64);
    if (!anyWitness) checks.witness = { ok: false, detail: "Aucun témoin valide (ni jeton TSA, ni ancrage OTS)." };
    const allOk = Object.values(checks).every((c) => c.ok !== false);
    return report(allOk, proof, { ots });
  }
}
