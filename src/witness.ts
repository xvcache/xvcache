import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { leafHash, merklePath, merkleRoot, verifyMerklePath, type HashLeaf, type MerkleStep } from "./merkle.js";
import { requestTimestamp, parseTimeStampToken, verifyTokenSignature, resolveTsaProvider, OID_SHA256, assessQualification, certignaTrust, type Qualification, type QualifiedTrust, type TsaProvider, type FetchLike } from "./tsa.js";
import { stampDigest, serializeOts, parseOts, otsStatus } from "./ots.js";
import { renderCertificate, type CertificateModel } from "./certificate.js";
import type { Proof } from "./certify.js";
import type { TsaTokenLedger } from "./tsa-tokens.js";

/**
 * Hosted witness (L3, écarts 6 + 10): hash-only certification shared by every firm.
 * - Each fingerprint becomes a leaf { k: "hash", id: proof_id, h: sha256 } — no firm, no label in the leaf.
 * - anchorMode "window" (tests, local): every submission arriving within `batchWindowMs` shares ONE Merkle root,
 *   hence ONE TSA token, and the call waits for it.
 * - anchorMode "daily" (hosted default, decision of 23/11/2026): submissions are queued on disk and answered at once
 *   as pending; ONE Merkle root common to every subscriber is stamped once a day (≈ one Certigna token per day),
 *   at `dailyAnchorUtc` (HH:MM, UTC). An empty day consumes no token.
 * - Usage is counted only when a proof obtains its token (onTimestamped); a pending proof is never counted.
 * - Every token obtained is recorded in the local token ledger (stock estimate + low-stock alert).
 * - If the qualified TSA (Certigna) fails (402 credits exhausted, 5xx, network), the batch is kept as
 *   `pending_qualified`: anchored with OpenTimestamps when enabled, NEVER silently stamped by another TSA,
 *   the operator is alerted, and requalifyPending() retries later. A pending proof never says "qualified".
 */

export const HOSTED_PROOF_FORMAT = "xvcache-hosted-proof/1";

export type HostedStatus = "qualified" | "timestamped" | "pending_qualified" | "pending_timestamp" | "ots_only";

export type HostedProof = {
  format: typeof HOSTED_PROOF_FORMAT;
  proof_id: string;
  sha256: string;
  label: string;
  leaf: HashLeaf;
  leaf_hash: string;
  /** null while the proof waits for the daily anchor (daily mode). */
  merkle: { scheme: string; leaf_index: number; leaf_count: number; path: MerkleStep[]; root: string } | null;
  batch_id: string | null;
  created_at: string;
  /** Daily mode: when the shared root containing this fingerprint is (or was) due to be stamped. */
  anchor_due_at?: string;
  status: HostedStatus;
  qualified: boolean;
  expected_provider: string | null;
  tsa: Proof["tsa"];
  ots: Proof["ots"];
  notice: string;
};

type Stored = { proof: HostedProof; owner: string };

type BatchRecord = {
  batch_id: string;
  root: string;
  created_at: string;
  proof_ids: string[];
  status: HostedStatus;
  attempts: number;
  last_error: string | null;
};

export type SubmitItem = { sha256: string; label: string; owner: string };

export type AnchorMode = "window" | "daily";

export type WitnessOptions = {
  dataDir: string;
  tsa: TsaProvider | null;
  ots: { enabled: boolean; calendars: string[] };
  batchWindowMs?: number;
  /** "window" (default here) or "daily" (hosted server default). */
  anchorMode?: AnchorMode;
  /** Daily mode: time of the daily anchor, "HH:MM" UTC (default "21:50": 22:50 Paris in winter, 23:50 Paris in summer, so always the same Paris calendar day). */
  dailyAnchorUtc?: string;
  /** Daily mode: start the internal daily timer (default true). Tests call anchorNow() directly. */
  autoAnchor?: boolean;
  /** Local ledger of TSA tokens consumed (stock estimate, low-stock alert). */
  tokenLedger?: TsaTokenLedger;
  /** Called once per owner when proofs obtain their timestamp token (usage is counted there, never for pending proofs). */
  onTimestamped?: (owner: string, count: number) => void | Promise<void>;
  fetchImpl?: FetchLike;
  /** Operator alert sink (default: stderr + alerts.log). Messages never contain credentials. */
  onAlert?: (message: string) => void;
  /** Automatic retry of pending batches (ms). 0 / undefined = manual requalifyPending() only. */
  retryIntervalMs?: number;
};

export type HostedVerdict = "V" | "X" | "pending" | "not_found" | "invalid";
export type HostedCheck = { ok: boolean | null; detail: string };
export type HostedVerification = {
  verdict: HostedVerdict;
  qualified: boolean;
  status: HostedStatus | null;
  gen_time: string | null;
  /** Recomputed from the token, never trusted from stored JSON. */
  qualification: Qualification | null;
  signature: "verified" | "failed" | "unavailable" | null;
  checks: { fingerprint: HostedCheck; merkle: HostedCheck; tsa_token: HostedCheck; tsa_signature: HostedCheck; ots: HostedCheck };
  proof: HostedProof | null;
};

const NOTICE = "Hash-only proof: XVcache never received the document, only its SHA-256 fingerprint. One RFC 3161 token covers the Merkle root shared by every fingerprint of the batch; the Merkle path proves this fingerprint is under that root. Legal presumption (eIDAS art. 41) only if status is 'qualified'.";

const HEX64 = /^[0-9a-f]{64}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/**
 * Default daily anchor, in UTC: 21:50 UTC = 22:50 Europe/Paris in winter (UTC+1) and 23:50 in summer (UTC+2).
 * It therefore always falls on the same Paris calendar day as the submissions it covers (22:50 UTC would be
 * 00:50 the next day in Paris in summer). The certified date of a proof is the issue time (genTime) of that
 * day's Certigna token, never the time the fingerprint was submitted.
 */
export const DEFAULT_DAILY_ANCHOR_UTC = "21:50";
const MERKLE_SCHEME = "sha256, leaf=H(0x00||canonical_json(leaf)), node=H(0x01||L||R), odd node promoted";

/** Next occurrence of HH:MM UTC strictly after `from`. */
export function nextDailyAnchor(from: Date, hhmm: string = DEFAULT_DAILY_ANCHOR_UTC): Date {
  const m = HHMM.exec(hhmm) ?? HHMM.exec(DEFAULT_DAILY_ANCHOR_UTC)!;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), Number(m[1]), Number(m[2])));
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const PROOF_ID = /^xvh_[A-Za-z0-9_-]{16,40}$/;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isProofId(s: string): boolean {
  return PROOF_ID.test(s);
}

export class HostedWitness {
  private queue: { item: SubmitItem; resolve: (p: HostedProof) => void; reject: (e: unknown) => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private anchorTimer: NodeJS.Timeout | null = null;
  private window: number;
  private anchorChain: Promise<unknown> = Promise.resolve();
  readonly mode: AnchorMode;

  constructor(private opts: WitnessOptions) {
    this.window = opts.batchWindowMs ?? 2000;
    this.mode = opts.anchorMode ?? "window";
    if (opts.retryIntervalMs && opts.retryIntervalMs > 0) {
      this.retryTimer = setInterval(() => { this.requalifyPending().catch((e) => this.alert(`requalification failed: ${errMsg(e)}`)); }, opts.retryIntervalMs);
      this.retryTimer.unref();
    }
    if (this.mode === "daily" && opts.autoAnchor !== false) this.scheduleAnchor(true);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    this.timer = null;
    this.retryTimer = null;
    this.anchorTimer = null;
  }

  /** Wire the usage counter (called by the remote app) unless one was given in the options. */
  useUsageCounter(fn: (owner: string, count: number) => void | Promise<void>): void {
    this.opts.onTimestamped ??= fn;
  }

  /** Daily mode: time of the next shared anchor. */
  nextAnchorAt(from: Date = new Date()): Date {
    return nextDailyAnchor(from, this.opts.dailyAnchorUtc ?? DEFAULT_DAILY_ANCHOR_UTC);
  }

  private scheduleAnchor(catchUp = false): void {
    if (catchUp) {
      // A queue left from before a restart whose anchor time has passed is stamped right away.
      void this.overdueQueue().then((late) => { if (late) return this.anchorNow(); return 0; }).catch((e) => this.alert(`daily anchor (catch-up) failed: ${errMsg(e)}`));
    }
    const delay = Math.max(1000, this.nextAnchorAt().getTime() - Date.now());
    this.anchorTimer = setTimeout(() => {
      this.anchorTimer = null;
      void this.anchorNow().catch((e) => this.alert(`daily anchor failed: ${errMsg(e)}`)).finally(() => this.scheduleAnchor());
    }, Math.min(delay, 2 ** 31 - 1));
    this.anchorTimer.unref();
  }

  private async overdueQueue(): Promise<boolean> {
    for (const id of await this.queuedIds()) {
      const s = await this.readStored(id);
      if (s?.proof.anchor_due_at && Date.parse(s.proof.anchor_due_at) <= Date.now()) return true;
    }
    return false;
  }

  private async queuedIds(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir("queue"))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isProofId);
    } catch {
      return [];
    }
  }

  /** Number of fingerprints waiting for the next daily anchor. */
  async queueSize(): Promise<number> {
    return (await this.queuedIds()).length;
  }

  private async timestamped(owners: string[]): Promise<void> {
    if (!this.opts.onTimestamped) return;
    const count = new Map<string, number>();
    for (const o of owners) count.set(o, (count.get(o) ?? 0) + 1);
    for (const [o, n] of count) {
      try { await this.opts.onTimestamped(o, n); } catch (e) { this.alert(`usage update failed for ${n} proof(s): ${errMsg(e)}`); }
    }
  }

  private dir(...p: string[]): string {
    return path.join(this.opts.dataDir, "hosted", ...p);
  }

  private alert(message: string): void {
    const line = `[xvcache][operator-alert] ${new Date().toISOString()} ${message}`;
    if (this.opts.onAlert) this.opts.onAlert(line);
    else {
      process.stderr.write(line + "\n");
      fs.mkdir(this.dir(), { recursive: true }).then(() => fs.appendFile(this.dir("alerts.log"), line + "\n")).catch(() => {});
    }
  }

  /** Queue fingerprints; resolves when their shared batch has been stamped (or recorded as pending). */
  submit(items: SubmitItem[]): Promise<HostedProof[]> {
    for (const it of items) if (!HEX64.test(it.sha256)) return Promise.reject(new Error("HASH_INVALID"));
    if (this.mode === "daily") return this.enqueue(items);
    const ps = items.map((item) => new Promise<HostedProof>((resolve, reject) => this.queue.push({ item, resolve, reject })));
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.window);
    }
    return Promise.all(ps);
  }

  /** Daily mode: record each fingerprint as pending (no token yet) and answer immediately. */
  private async enqueue(items: SubmitItem[]): Promise<HostedProof[]> {
    const created_at = new Date().toISOString();
    const due = this.nextAnchorAt(new Date(created_at)).toISOString();
    const status: HostedStatus = !this.opts.tsa ? "ots_only" : this.opts.tsa.qualified ? "pending_qualified" : "pending_timestamp";
    await fs.mkdir(this.dir("queue"), { recursive: true });
    await fs.mkdir(this.dir("proofs"), { recursive: true });
    const proofs: HostedProof[] = [];
    for (const it of items) {
      const proof_id = "xvh_" + randomBytes(16).toString("base64url");
      const leaf: HashLeaf = { k: "hash", id: proof_id, h: it.sha256 };
      const p: HostedProof = {
        format: HOSTED_PROOF_FORMAT, proof_id, sha256: it.sha256, label: it.label, leaf, leaf_hash: leafHash(leaf),
        merkle: null, batch_id: null, created_at, anchor_due_at: due, status, qualified: false,
        expected_provider: this.opts.tsa?.id ?? null, tsa: null, ots: null, notice: NOTICE,
      };
      await this.writeStored({ proof: p, owner: it.owner });
      await fs.writeFile(this.dir("queue", `${proof_id}.json`), JSON.stringify({ proof_id, due }));
      proofs.push(p);
    }
    return proofs;
  }

  /**
   * Daily mode: stamp ONE Merkle root over every queued fingerprint (all subscribers together).
   * Returns the number of fingerprints anchored (0 = empty queue, no token consumed).
   */
  anchorNow(): Promise<number> {
    const run = this.anchorChain.then(() => this.anchorQueued());
    this.anchorChain = run.catch(() => {});
    return run;
  }

  private async anchorQueued(): Promise<number> {
    const ids = await this.queuedIds();
    const stored: Stored[] = [];
    for (const id of ids) {
      const s = await this.readStored(id);
      if (s && !s.proof.merkle) stored.push(s);
      else await fs.rm(this.dir("queue", `${id}.json`), { force: true });
    }
    if (!stored.length) return 0;
    stored.sort((a, b) => a.proof.created_at.localeCompare(b.proof.created_at) || a.proof.proof_id.localeCompare(b.proof.proof_id));
    const created_at = new Date().toISOString();
    const batch_id = `${created_at.replace(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(4).toString("hex")}`;
    const lhs = stored.map((s) => leafHash(s.proof.leaf));
    const root = merkleRoot(lhs);
    const st = await this.stampRoot(root);
    if (st.error) {
      const t = this.opts.tsa!;
      this.alert(`TSA ${t.id} unavailable for daily batch ${batch_id} (${stored.length} fingerprint(s)): ${st.error} — kept as ${t.qualified ? "pending_qualified" : "pending_timestamp"}, no fallback TSA used.`);
    }
    const { ots, otsBuf } = await this.stampOts(root, batch_id, !!st.error);
    const status = this.statusFor(st.tsa);
    await fs.mkdir(this.dir("batches"), { recursive: true });
    const rec: BatchRecord = { batch_id, root, created_at, proof_ids: stored.map((s) => s.proof.proof_id), status, attempts: 1, last_error: st.error };
    await fs.writeFile(this.dir("batches", `${batch_id}.json`), JSON.stringify(rec, null, 2));
    if (st.tokenDer) await fs.writeFile(this.dir("batches", `${batch_id}.tst`), st.tokenDer);
    if (otsBuf) await fs.writeFile(this.dir("batches", `${batch_id}.ots`), otsBuf);
    for (const [i, s] of stored.entries()) {
      s.proof.merkle = { scheme: MERKLE_SCHEME, leaf_index: i, leaf_count: lhs.length, path: merklePath(lhs, i), root };
      s.proof.batch_id = batch_id;
      s.proof.status = status;
      s.proof.qualified = status === "qualified";
      s.proof.tsa = st.tsa;
      s.proof.ots = ots;
      await this.writeStored(s);
      await fs.rm(this.dir("queue", `${s.proof.proof_id}.json`), { force: true });
    }
    if (st.tsa) await this.timestamped(stored.map((s) => s.owner));
    return stored.length;
  }

  private async stampOts(root: string, batch_id: string, tsaFailed: boolean): Promise<{ ots: Proof["ots"]; otsBuf: Buffer | null }> {
    if (!this.opts.ots.enabled) return { ots: null, otsBuf: null };
    try {
      const s = await stampDigest(Buffer.from(root, "hex"), this.opts.ots.calendars);
      const otsBuf = serializeOts(s.ts);
      return { otsBuf, ots: { status: "pending", calendars: s.calendars, ots_base64: otsBuf.toString("base64"), detail: "Submitted to OpenTimestamps calendars; Bitcoin confirmation within hours." } };
    } catch (e) {
      if (tsaFailed || !this.opts.tsa) this.alert(`OpenTimestamps also failed for batch ${batch_id}: ${errMsg(e)}`);
      return { ots: null, otsBuf: null };
    }
  }

  private async stampRoot(root: string): Promise<{ tsa: Proof["tsa"]; tokenDer: Buffer | null; error: string | null }> {
    const t = this.opts.tsa;
    if (!t) return { tsa: null, tokenDer: null, error: null };
    try {
      const res = await requestTimestamp(t, root, { fetchImpl: this.opts.fetchImpl });
      if (this.opts.tokenLedger) {
        try { await this.opts.tokenLedger.consumed(1); } catch (e) { this.alert(`token ledger update failed: ${errMsg(e)}`); }
      }
      const q = await assessQualification(res.token, root, this.trustFor(t.id));
      return {
        tokenDer: res.token,
        error: null,
        tsa: {
          provider: t.id, label: t.label, url: t.url, qualified: q.qualified, qualified_basis: q.qualified ? t.qualifiedBasis : `Non qualifié : ${q.detail}`,
          qualification: { status: q.status, signature: q.signature, signer_issuer: q.signer_issuer, detail: q.detail },
          hash_algorithm: "sha256", message_imprint: res.info.messageImprint, gen_time: res.info.genTime,
          serial: res.info.serial, policy: res.info.policy, token_base64: res.token.toString("base64"),
        },
      };
    } catch (e) {
      return { tsa: null, tokenDer: null, error: errMsg(e) };
    }
  }

  private statusFor(tsa: Proof["tsa"]): HostedStatus {
    const t = this.opts.tsa;
    if (!t) return "ots_only";
    if (tsa) return tsa.qualified ? "qualified" : "timestamped";
    return t.qualified ? "pending_qualified" : "pending_timestamp";
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (!batch.length) return;
    try {
      const created_at = new Date().toISOString();
      const batch_id = `${created_at.replace(/[-:.]/g, "").slice(0, 15)}Z-${randomBytes(4).toString("hex")}`;
      const ids = batch.map(() => "xvh_" + randomBytes(16).toString("base64url"));
      const leaves: HashLeaf[] = batch.map((b, i) => ({ k: "hash", id: ids[i], h: b.item.sha256 }));
      const lhs = leaves.map(leafHash);
      const root = merkleRoot(lhs);

      const st = await this.stampRoot(root);
      if (st.error) {
        const t = this.opts.tsa!;
        this.alert(`TSA ${t.id} unavailable for batch ${batch_id} (${batch.length} fingerprint(s)): ${st.error} — kept as ${t.qualified ? "pending_qualified" : "pending_timestamp"}, no fallback TSA used.`);
      }
      const { ots, otsBuf } = await this.stampOts(root, batch_id, !!st.error);
      const status = this.statusFor(st.tsa);
      await fs.mkdir(this.dir("batches"), { recursive: true });
      await fs.mkdir(this.dir("proofs"), { recursive: true });
      const rec: BatchRecord = { batch_id, root, created_at, proof_ids: ids, status, attempts: 1, last_error: st.error };
      await fs.writeFile(this.dir("batches", `${batch_id}.json`), JSON.stringify(rec, null, 2));
      if (st.tokenDer) await fs.writeFile(this.dir("batches", `${batch_id}.tst`), st.tokenDer);
      if (otsBuf) await fs.writeFile(this.dir("batches", `${batch_id}.ots`), otsBuf);

      const proofs: HostedProof[] = batch.map((b, i) => ({
        format: HOSTED_PROOF_FORMAT,
        proof_id: ids[i],
        sha256: b.item.sha256,
        label: b.item.label,
        leaf: leaves[i],
        leaf_hash: lhs[i],
        merkle: { scheme: MERKLE_SCHEME, leaf_index: i, leaf_count: lhs.length, path: merklePath(lhs, i), root },
        batch_id,
        created_at,
        status,
        qualified: status === "qualified",
        expected_provider: this.opts.tsa?.id ?? null,
        tsa: st.tsa,
        ots,
        notice: NOTICE,
      }));
      await Promise.all(proofs.map((p, i) => this.writeStored({ proof: p, owner: batch[i].item.owner })));
      if (st.tsa) await this.timestamped(batch.map((b) => b.item.owner));
      batch.forEach((b, i) => b.resolve(proofs[i]));
    } catch (e) {
      batch.forEach((b) => b.reject(e));
    }
  }

  private async writeStored(s: Stored): Promise<void> {
    const f = this.dir("proofs", `${s.proof.proof_id}.json`);
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2));
    await fs.rename(tmp, f);
  }

  private async readStored(proof_id: string): Promise<Stored | null> {
    if (!isProofId(proof_id)) return null;
    try {
      return JSON.parse(await fs.readFile(this.dir("proofs", `${proof_id}.json`), "utf8")) as Stored;
    } catch {
      return null;
    }
  }

  async getProof(proof_id: string): Promise<HostedProof | null> {
    return (await this.readStored(proof_id))?.proof ?? null;
  }

  async ownerOf(proof_id: string): Promise<string | null> {
    return (await this.readStored(proof_id))?.owner ?? null;
  }

  /** Retry the TSA for every pending batch. Returns the number of batches that obtained their token. */
  async requalifyPending(): Promise<number> {
    let names: string[] = [];
    try { names = (await fs.readdir(this.dir("batches"))).filter((n) => n.endsWith(".json")); } catch { return 0; }
    let done = 0;
    for (const n of names) {
      const f = this.dir("batches", n);
      const rec = JSON.parse(await fs.readFile(f, "utf8")) as BatchRecord;
      if (rec.status !== "pending_qualified" && rec.status !== "pending_timestamp") continue;
      const st = await this.stampRoot(rec.root);
      rec.attempts += 1;
      if (!st.tsa || !st.tokenDer) {
        rec.last_error = st.error;
        await fs.writeFile(f, JSON.stringify(rec, null, 2));
        continue;
      }
      rec.status = this.statusFor(st.tsa);
      rec.last_error = null;
      await fs.writeFile(this.dir("batches", `${rec.batch_id}.tst`), st.tokenDer);
      const owners: string[] = [];
      for (const id of rec.proof_ids) {
        const s = await this.readStored(id);
        if (!s) continue;
        owners.push(s.owner);
        s.proof.tsa = st.tsa;
        s.proof.status = rec.status;
        s.proof.qualified = rec.status === "qualified";
        await this.writeStored(s);
      }
      await fs.writeFile(f, JSON.stringify(rec, null, 2));
      await this.timestamped(owners);
      this.alert(`batch ${rec.batch_id} requalified (${rec.status}) after ${rec.attempts} attempt(s).`);
      done++;
    }
    return done;
  }

  private caFor(provider: string): { ca?: string; untrusted?: string } {
    const t = this.opts.tsa;
    if (t && t.id === provider) return { ca: t.caFile, untrusted: t.untrustedFile };
    const p = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: provider === "certigna" ? "certigna" : "freetsa", XVCACHE_TSA_USER: "x", XVCACHE_TSA_PASSWORD: "x" });
    return p && !("error" in p) ? { ca: p.caFile, untrusted: p.untrustedFile } : {};
  }

  private trustFor(provider: string): QualifiedTrust {
    const t = this.opts.tsa;
    return t && t.id === provider && t.qualifiedTrust ? t.qualifiedTrust : certignaTrust();
  }

  /** Free verification: fingerprint + proof_id → V / X / pending. Never reveals the owner. */
  async verify(q: { sha256: string; proof_id: string; online?: boolean }): Promise<HostedVerification> {
    const empty: HostedCheck = { ok: null, detail: "not checked" };
    const base = { qualified: false, status: null, gen_time: null, proof: null, qualification: null, signature: null };
    const sha = q.sha256.trim().toLowerCase();
    if (!HEX64.test(sha)) return { ...base, verdict: "invalid", checks: { fingerprint: { ok: false, detail: "Not a SHA-256 fingerprint (64 hex characters)." }, merkle: empty, tsa_token: empty, tsa_signature: empty, ots: empty } };
    const p = await this.getProof(q.proof_id.trim());
    if (!p) return { ...base, verdict: "not_found", checks: { fingerprint: { ok: null, detail: "Unknown proof_id." }, merkle: empty, tsa_token: empty, tsa_signature: empty, ots: empty } };

    const checks: HostedVerification["checks"] = { fingerprint: empty, merkle: empty, tsa_token: empty, tsa_signature: empty, ots: empty };
    checks.fingerprint = sha === p.sha256
      ? { ok: true, detail: "The document's fingerprint is identical to the certified fingerprint." }
      : { ok: false, detail: "Different fingerprint: the document was MODIFIED (or it is another document)." };
    const lh = leafHash({ k: "hash", id: p.proof_id, h: p.sha256 });
    if (!p.merkle) {
      checks.merkle = lh !== p.leaf_hash ? { ok: false, detail: "Recomputed leaf differs." } : { ok: null, detail: `Waiting for the daily shared timestamp (due ${p.anchor_due_at ?? "soon"}).` };
      checks.tsa_token = { ok: null, detail: "No timestamp token yet: the fingerprint is queued for the next daily shared timestamp." };
      const verdict: HostedVerdict = checks.fingerprint.ok === false || checks.merkle.ok === false ? "X" : "pending";
      return { verdict, qualified: false, status: p.status, gen_time: null, checks, proof: p, qualification: null, signature: null };
    }
    checks.merkle = lh !== p.leaf_hash ? { ok: false, detail: "Recomputed leaf differs." }
      : verifyMerklePath(lh, p.merkle.path, p.merkle.root) ? { ok: true, detail: `Valid Merkle path (${p.merkle.path.length} step(s), ${p.merkle.leaf_count} fingerprint(s) under the same root).` }
      : { ok: false, detail: "Merkle path does not lead to the root." };
    let qualification: Qualification | null = null;
    if (p.tsa) {
      try {
        const token = Buffer.from(p.tsa.token_base64, "base64");
        const info = parseTimeStampToken(token);
        checks.tsa_token = info.hashAlgorithm !== OID_SHA256 || info.messageImprint !== p.merkle.root ? { ok: false, detail: "The TSA token is not over this root." }
          : info.genTime !== p.tsa.gen_time ? { ok: false, detail: "Token date differs from the stated date." }
          : { ok: true, detail: `RFC 3161 token over the root, genTime ${info.genTime}, serial ${info.serial}.` };
        const ca = this.caFor(p.tsa.provider);
        const sig = await verifyTokenSignature(token, p.merkle.root, ca.ca, ca.untrusted);
        checks.tsa_signature = { ok: sig.status === "verified" ? true : sig.status === "failed" ? false : null, detail: sig.detail };
        qualification = await assessQualification(token, p.merkle.root, this.trustFor(p.tsa.provider));
      } catch (e) {
        checks.tsa_token = { ok: false, detail: `Unreadable TSA token: ${errMsg(e)}` };
      }
    } else {
      checks.tsa_token = { ok: null, detail: p.status === "pending_qualified" ? "Qualified token not issued yet (provider unavailable); automatic retry in progress." : "No TSA token." };
    }
    if (p.ots?.ots_base64) {
      try {
        const s = await otsStatus(parseOts(Buffer.from(p.ots.ots_base64, "base64")), { online: !!q.online });
        checks.ots = { ok: s.status === "failed" ? false : s.status === "confirmed" ? true : null, detail: s.detail };
      } catch (e) {
        checks.ots = { ok: false, detail: `Unreadable .ots: ${errMsg(e)}` };
      }
    } else checks.ots = { ok: null, detail: "No OpenTimestamps anchor." };

    let verdict: HostedVerdict;
    if (checks.fingerprint.ok === false || checks.merkle.ok === false || checks.tsa_token.ok === false || checks.tsa_signature.ok === false || checks.ots.ok === false) verdict = "X";
    else if (checks.tsa_token.ok === true) verdict = "V";
    else verdict = "pending";
    const qualified = verdict === "V" && checks.tsa_signature.ok === true && !!qualification?.qualified;
    // Do not return stale/forged stored "qualified" fields (including when openssl is absent).
    const status = p.tsa ? (qualified ? "qualified" : "timestamped") : p.status;
    const proof: HostedProof = { ...p, qualified, status, tsa: p.tsa ? {
      ...p.tsa, qualified, policy: qualification?.policy ?? null,
      qualification: qualification ? { status: qualification.status, signature: qualification.signature, signer_issuer: qualification.signer_issuer, detail: qualification.detail } : undefined,
    } : null };
    return {
      verdict, qualified, status, gen_time: p.tsa?.gen_time ?? null, checks, proof, qualification,
      signature: p.tsa ? (checks.tsa_signature.ok === true ? "verified" : checks.tsa_signature.ok === false ? "failed" : "unavailable") : null,
    };
  }

  /**
   * One-page certificate for a hosted proof, in any EU language. No PDF when the fingerprint
   * given does not match (verdict X) or the proof is unknown. Pending proofs carry the NOT QUALIFIED banner.
   */
  async certificatePdf(q: { proof_id: string; lang: string; tz?: string; sha256?: string }): Promise<null | { bytes: Uint8Array; lines: string[]; qualified: boolean; verdict: HostedVerdict; lang: string; proof: HostedProof }> {
    const stored = await this.getProof(q.proof_id);
    if (!stored) return null;
    const v = await this.verify({ sha256: q.sha256 ?? stored.sha256, proof_id: stored.proof_id });
    const p = v.proof!;
    if (v.verdict === "X" || v.verdict === "invalid" || v.verdict === "not_found") return null;
    const attachments: CertificateModel["attachments"] = [
      { name: "proof.json", description: "XVcache hosted proof (hashes only)", bytes: Buffer.from(JSON.stringify(p, null, 2)) },
    ];
    if (p.tsa) attachments.unshift({ name: "token.tst", description: "RFC 3161 timestamp token (DER) over the Merkle root", bytes: Buffer.from(p.tsa.token_base64, "base64") });
    if (p.ots?.ots_base64) attachments.push({ name: "root.ots", description: "OpenTimestamps proof of the Merkle root", bytes: Buffer.from(p.ots.ots_base64, "base64") });
    const model: CertificateModel = {
      lang: q.lang,
      tz: q.tz,
      kind: "timestamp",
      verdict: v.verdict === "V" ? "V" : "pending",
      label: p.label,
      sha256: p.sha256,
      gen_time: p.tsa?.gen_time ?? null,
      tsa: p.tsa ? { provider: p.tsa.provider, label: p.tsa.label, qualified: v.qualified, policy: v.qualification?.policy ?? null, serial: p.tsa.serial, signature: v.signature ?? "unavailable" } : null,
      pending_qualified: p.status === "pending_qualified",
      ots_status: p.ots?.status ?? null,
      ots_detail: p.ots?.detail ?? null,
      proof_id: p.proof_id,
      attachments,
    };
    const r = await renderCertificate(model);
    const qualified = !!model.tsa?.qualified && !model.pending_qualified && model.verdict === "V";
    return { bytes: r.bytes, lines: r.lines, qualified, verdict: v.verdict, lang: r.lang, proof: p };
  }
}
