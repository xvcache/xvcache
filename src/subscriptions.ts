import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { toolError, type ToolError } from "./errors.js";

/**
 * Subscriptions for the hosted (remote) XVcache server — L3.
 * - API keys and pairing codes are stored as SHA-256 hashes only; the plain API key is shown once.
 * - Quotas are counted per calendar month (UTC). `quota: null` = no cap (quotas are still TBD).
 * - Activation is done by billing (L4, Stripe webhook) or by the operator (createApiKey). Nothing here charges.
 * Storage: one JSON file, written atomically. Good enough for a single-instance server; a real DB is L6.
 */

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export type SubscriptionRecord = {
  key_hash: string;
  key_hint: string; // last 4 characters, to help the firm recognise its key
  plan_id: string;
  status: SubscriptionStatus;
  quota: number | null;
  period_start: string;
  used: number;
  default_lang: string;
  created_at: string;
  total_certified: number;
};

type PairingRecord = {
  code_hash: string;
  plan_id: string;
  lang: string;
  consent: { quote: string; at: string };
  created_at: string;
  expires_at: string;
  state: "pending" | "active";
  key_hash?: string;
  /** Plain key kept only between activation and the first get_subscription, then erased. */
  api_key_once?: string;
};

type StoreFile = { version: 1; subscriptions: SubscriptionRecord[]; pairings: PairingRecord[] };

export const PAIRING_TTL_MS = 24 * 3600 * 1000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function newSecret(prefix: string, bytes: number): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function nextMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export type ConsumeResult = { ok: true; used: number; quota: number | null } | { ok: false; used: number; quota: number; next_reset: string };

export type SubscriptionView = {
  ok: true;
  status: SubscriptionStatus;
  plan_id: string;
  quota: number | null;
  used_this_period: number;
  next_reset: string;
  default_lang: string;
  key_hint: string;
  /** Plain API key: returned once (first get_subscription after activation), null afterwards. */
  api_key: string | null;
};

export class SubscriptionStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private file: string, private now: () => Date = () => new Date()) {}

  private async load(): Promise<StoreFile> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as StoreFile;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, subscriptions: [], pairings: [] };
      throw e;
    }
  }

  private async save(data: StoreFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Serialise read-modify-write cycles. */
  private tx<T>(fn: (data: StoreFile) => Promise<T> | T, write = true): Promise<T> {
    const run = this.chain.then(async () => {
      const data = await this.load();
      const out = await fn(data);
      if (write) await this.save(data);
      return out;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private rollPeriod(rec: SubscriptionRecord): void {
    const start = monthStart(this.now()).toISOString();
    if (rec.period_start !== start) {
      rec.period_start = start;
      rec.used = 0;
    }
  }

  private newRecord(api_key: string, o: { plan_id: string; quota: number | null; status: SubscriptionStatus; default_lang?: string }): SubscriptionRecord {
    return {
      key_hash: hashSecret(api_key),
      key_hint: api_key.slice(-4),
      plan_id: o.plan_id,
      status: o.status,
      quota: o.quota,
      period_start: monthStart(this.now()).toISOString(),
      used: 0,
      default_lang: o.default_lang ?? "en",
      created_at: this.now().toISOString(),
      total_certified: 0,
    };
  }

  /** Operator / tests: mint an API key directly (no billing). The plain key is returned once. */
  createApiKey(o: { plan_id: string; quota: number | null; status: SubscriptionStatus; default_lang?: string }): Promise<{ api_key: string; key_hash: string }> {
    return this.tx((data) => {
      const api_key = newSecret("xvc_", 32);
      const rec = this.newRecord(api_key, o);
      data.subscriptions.push(rec);
      return { api_key, key_hash: rec.key_hash };
    });
  }

  authenticate(api_key: string | undefined | null): Promise<SubscriptionRecord | null> {
    if (!api_key) return Promise.resolve(null);
    const h = hashSecret(api_key.trim());
    return this.tx((data) => data.subscriptions.find((s) => s.key_hash === h) ?? null, false);
  }

  /** Count `n` certifications against the monthly quota; refuses the whole call if it would exceed. */
  consume(key_hash: string, n: number): Promise<ConsumeResult> {
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === key_hash);
      if (!rec) throw new Error("unknown subscription");
      this.rollPeriod(rec);
      if (rec.quota !== null && rec.used + n > rec.quota) {
        return { ok: false as const, used: rec.used, quota: rec.quota, next_reset: nextMonthStart(this.now()).toISOString() };
      }
      rec.used += n;
      rec.total_certified += n;
      return { ok: true as const, used: rec.used, quota: rec.quota };
    });
  }

  /** Give back units when the certification failed after consume(). */
  refund(key_hash: string, n: number): Promise<void> {
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === key_hash);
      if (rec) { rec.used = Math.max(0, rec.used - n); rec.total_certified = Math.max(0, rec.total_certified - n); }
    });
  }

  usage(key_hash: string): Promise<{ plan_id: string; status: SubscriptionStatus; certifications_this_period: number; quota: number | null; remaining: number | null; period_start: string; next_reset: string; total_certified: number }> {
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === key_hash);
      if (!rec) throw new Error("unknown subscription");
      this.rollPeriod(rec);
      return {
        plan_id: rec.plan_id,
        status: rec.status,
        certifications_this_period: rec.used,
        quota: rec.quota,
        remaining: rec.quota === null ? null : Math.max(0, rec.quota - rec.used),
        period_start: rec.period_start,
        next_reset: nextMonthStart(this.now()).toISOString(),
        total_certified: rec.total_certified,
      };
    });
  }

  /** request_upgrade (after consent): a pairing code the AI keeps to fetch the key once payment is done. */
  createPairing(o: { plan_id: string; lang: string; consent: { quote: string; at: string } }): Promise<{ pairing_code: string; expires_at: string }> {
    return this.tx((data) => {
      const pairing_code = newSecret("xvp_", 24);
      const created = this.now();
      const expires_at = new Date(created.getTime() + PAIRING_TTL_MS).toISOString();
      data.pairings = data.pairings.filter((p) => p.state === "active" || Date.parse(p.expires_at) > created.getTime() - 7 * PAIRING_TTL_MS);
      data.pairings.push({ code_hash: hashSecret(pairing_code), plan_id: o.plan_id, lang: o.lang, consent: o.consent, created_at: created.toISOString(), expires_at, state: "pending" });
      return { pairing_code, expires_at };
    });
  }

  /** Billing (L4 webhook) or operator: the payment / trial is confirmed → mint the key for this pairing. */
  activatePairing(pairing_code: string, o: { status: SubscriptionStatus; quota: number | null }): Promise<{ ok: boolean }> {
    return this.tx((data) => {
      const p = data.pairings.find((x) => x.code_hash === hashSecret(pairing_code));
      if (!p) return { ok: false };
      if (p.state === "active") return { ok: true };
      const api_key = newSecret("xvc_", 32);
      const rec = this.newRecord(api_key, { plan_id: p.plan_id, quota: o.quota, status: o.status, default_lang: p.lang });
      data.subscriptions.push(rec);
      p.state = "active";
      p.key_hash = rec.key_hash;
      p.api_key_once = api_key;
      return { ok: true };
    });
  }

  private view(rec: SubscriptionRecord, api_key: string | null): SubscriptionView {
    this.rollPeriod(rec);
    return {
      ok: true,
      status: rec.status,
      plan_id: rec.plan_id,
      quota: rec.quota,
      used_this_period: rec.used,
      next_reset: nextMonthStart(this.now()).toISOString(),
      default_lang: rec.default_lang,
      key_hint: rec.key_hint,
      api_key,
    };
  }

  getSubscription(q: { pairing_code?: string; api_key?: string }): Promise<SubscriptionView | ToolError> {
    return this.tx((data) => {
      if (q.api_key) {
        const rec = data.subscriptions.find((s) => s.key_hash === hashSecret(q.api_key!.trim()));
        if (!rec) return toolError("INVALID_KEY", "This API key is not recognised.", false, "Call get_subscription with the pairing_code from request_upgrade, or present_to_client to start a subscription.");
        return this.view(rec, null);
      }
      if (!q.pairing_code) return toolError("INVALID_KEY", "Give either the pairing_code returned by request_upgrade or the API key.", false, "Call get_subscription with pairing_code.");
      const p = data.pairings.find((x) => x.code_hash === hashSecret(q.pairing_code!.trim()));
      if (!p) return toolError("PAIRING_EXPIRED", "Unknown or expired pairing code.", false, "Call present_to_client again, then request_upgrade after the human's consent.", { next_tool: "present_to_client" });
      if (p.state === "pending") {
        if (Date.parse(p.expires_at) <= this.now().getTime()) {
          return toolError("PAIRING_EXPIRED", "The payment link expired before payment.", false, "Call request_upgrade again (the consent already given can be reused if the human confirms it in this conversation).", { next_tool: "request_upgrade" });
        }
        return toolError("NOT_PAID_YET", "The human has not completed checkout yet.", true, "Wait for the human to finish checkout (do not ask again), then call get_subscription again.", { retry_after_seconds: 20 });
      }
      const rec = data.subscriptions.find((s) => s.key_hash === p.key_hash);
      if (!rec) return toolError("PAIRING_EXPIRED", "Subscription no longer exists.", false, "Call present_to_client.");
      const once = p.api_key_once ?? null;
      delete p.api_key_once;
      return this.view(rec, once);
    });
  }
}
