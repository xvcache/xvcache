import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { leafHash, merklePath, merkleRoot, verifyMerklePath, type HashLeaf, type MerkleStep } from "./merkle.js";
import { requestTimestamp, parseTimeStampToken, verifyTokenSignature, resolveTsaProvider, OID_SHA256, type TsaProvider, type FetchLike } from "./tsa.js";
import { stampDigest, serializeOts, parseOts, otsStatus } from "./ots.js";
import { renderCertificate, type CertificateModel } from "./certificate.js";
import type { Proof } from "./certify.js";

/**
 * Hosted witness (L3, écarts 6 + 10): hash-only certification shared by every firm.
 * - Each fingerprint becomes a leaf { k: "hash", id: proof_id, h: sha256 } — no firm, no label in the leaf.
 * - Every submission arriving within `batchWindowMs` shares ONE Merkle root, hence ONE TSA token.
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
  merkle: { scheme: string; leaf_index: number; leaf_count: number; path: MerkleStep[]; root: string };
  batch_id: string;
  created_at: string;
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

export type WitnessOptions = {
  dataDir: string;
  tsa: TsaProvider | null;
  ots: { enabled: boolean; calendars: string[] };
  batchWindowMs?: number;
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
  checks: { fingerprint: HostedCheck; merkle: HostedCheck; tsa_token: HostedCheck; tsa_signature: HostedCheck; ots: HostedCheck };
  proof: HostedProof | null;
};

const NOTICE = "Hash-only proof: XVcache never received the document, only its SHA-256 fingerprint. One RFC 3161 token covers the Merkle root shared by every fingerprint of the batch; the Merkle path proves this fingerprint is under that root. Legal presumption (eIDAS art. 41) only if status is 'qualified'.";

const HEX64 = /^[0-9a-f]{64}$/;
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
  private window: number;

  constructor(private opts: WitnessOptions) {
    this.window = opts.batchWindowMs ?? 2000;
    if (opts.retryIntervalMs && opts.retryIntervalMs > 0) {
      this.retryTimer = setInterval(() => { this.requalifyPending().catch((e) => this.alert(`requalification failed: ${errMsg(e)}`)); }, opts.retryIntervalMs);
      this.retryTimer.unref();
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
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
    const ps = items.map((item) => new Promise<HostedProof>((resolve, reject) => this.queue.push({ item, resolve, reject })));
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.window);
    }
    return Promise.all(ps);
  }

  private async stampRoot(root: string): Promise<{ tsa: Proof["tsa"]; tokenDer: Buffer | null; error: string | null }> {
    const t = this.opts.tsa;
    if (!t) return { tsa: null, tokenDer: null, error: null };
    try {
      const res = await requestTimestamp(t, root, { fetchImpl: this.opts.fetchImpl });
      return {
        tokenDer: res.token,
        error: null,
        tsa: {
          provider: t.id, label: t.label, url: t.url, qualified: t.qualified, qualified_basis: t.qualifiedBasis,
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
      let ots: Proof["ots"] = null;
      let otsBuf: Buffer | null = null;
      if (this.opts.ots.enabled) {
        try {
          const s = await stampDigest(Buffer.from(root, "hex"), this.opts.ots.calendars);
          otsBuf = serializeOts(s.ts);
          ots = { status: "pending", calendars: s.calendars, ots_base64: otsBuf.toString("base64"), detail: "Submitted to OpenTimestamps calendars; Bitcoin confirmation within hours." };
        } catch (e) {
          if (st.error || !this.opts.tsa) this.alert(`OpenTimestamps also failed for batch ${batch_id}: ${errMsg(e)}`);
        }
      }
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
        merkle: { scheme: "sha256, leaf=H(0x00||canonical_json(leaf)), node=H(0x01||L||R), odd node promoted", leaf_index: i, leaf_count: lhs.length, path: merklePath(lhs, i), root },
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
      for (const id of rec.proof_ids) {
        const s = await this.readStored(id);
        if (!s) continue;
        s.proof.tsa = st.tsa;
        s.proof.status = rec.status;
        s.proof.qualified = rec.status === "qualified";
        await this.writeStored(s);
      }
      await fs.writeFile(f, JSON.stringify(rec, null, 2));
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

  /** Free verification: fingerprint + proof_id → V / X / pending. Never reveals the owner. */
  async verify(q: { sha256: string; proof_id: string; online?: boolean }): Promise<HostedVerification> {
    const empty: HostedCheck = { ok: null, detail: "not checked" };
    const base = { qualified: false, status: null, gen_time: null, proof: null };
    const sha = q.sha256.trim().toLowerCase();
    if (!HEX64.test(sha)) return { ...base, verdict: "invalid", checks: { fingerprint: { ok: false, detail: "Not a SHA-256 fingerprint (64 hex characters)." }, merkle: empty, tsa_token: empty, tsa_signature: empty, ots: empty } };
    const p = await this.getProof(q.proof_id.trim());
    if (!p) return { ...base, verdict: "not_found", checks: { fingerprint: { ok: null, detail: "Unknown proof_id." }, merkle: empty, tsa_token: empty, tsa_signature: empty, ots: empty } };

    const checks: HostedVerification["checks"] = { fingerprint: empty, merkle: empty, tsa_token: empty, tsa_signature: empty, ots: empty };
    checks.fingerprint = sha === p.sha256
      ? { ok: true, detail: "The document's fingerprint is identical to the certified fingerprint." }
      : { ok: false, detail: "Different fingerprint: the document was MODIFIED (or it is another document)." };
    const lh = leafHash({ k: "hash", id: p.proof_id, h: p.sha256 });
    checks.merkle = lh !== p.leaf_hash ? { ok: false, detail: "Recomputed leaf differs." }
      : verifyMerklePath(lh, p.merkle.path, p.merkle.root) ? { ok: true, detail: `Valid Merkle path (${p.merkle.path.length} step(s), ${p.merkle.leaf_count} fingerprint(s) under the same root).` }
      : { ok: false, detail: "Merkle path does not lead to the root." };
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
    return { verdict, qualified: verdict === "V" && p.qualified, status: p.status, gen_time: p.tsa?.gen_time ?? null, checks, proof: p };
  }

  /**
   * One-page certificate for a hosted proof, in any EU language. No PDF when the fingerprint
   * given does not match (verdict X) or the proof is unknown. Pending proofs carry the NOT QUALIFIED banner.
   */
  async certificatePdf(q: { proof_id: string; lang: string; tz?: string; sha256?: string }): Promise<null | { bytes: Uint8Array; lines: string[]; qualified: boolean; verdict: HostedVerdict; lang: string; proof: HostedProof }> {
    const p = await this.getProof(q.proof_id);
    if (!p) return null;
    const v = await this.verify({ sha256: q.sha256 ?? p.sha256, proof_id: p.proof_id });
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
      tsa: p.tsa ? { provider: p.tsa.provider, label: p.tsa.label, qualified: p.tsa.qualified, policy: p.tsa.policy, serial: p.tsa.serial } : null,
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
