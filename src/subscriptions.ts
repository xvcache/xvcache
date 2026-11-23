import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
  /** L4: Stripe linkage (test or live ids). The organisation = the Stripe customer who paid via the pairing. */
  stripe_customer?: string;
  stripe_subscription?: string;
  /** Set when a dispute (chargeback) is opened on one of this customer's charges; access is not cut automatically. */
  disputed_at?: string;
  /** 0.3.0: email of the payer (Stripe checkout customer_details.email), used only for the key-delivery link. */
  email?: string;
  /** When the subscription first became past_due or canceled. Window for existing-proof PDFs starts here. */
  ended_at?: string;
};

/**
 * 0.3.0 — key delivery by email: a ONE-TIME link valid a short time (24 h by default).
 * Only the SHA-256 of the link token is stored; the API key is stored encrypted with a key derived from the
 * link token (AES-256-GCM), so neither the store file alone nor the email ever reveals the key.
 * The ciphertext is erased as soon as the key is revealed, or when the link expires.
 */
export type KeyDeliveryRecord = {
  token_hash: string;
  key_hash: string;
  email: string;
  lang: string;
  created_at: string;
  expires_at: string;
  sent_at?: string;
  send_error?: string;
  revealed_at?: string;
  enc?: { iv: string; ct: string; tag: string };
};

/** Returned once by applyBillingEvent to the webhook, which emails the link. Never persisted in clear. */
export type PendingKeyDelivery = { token: string; token_hash: string; email: string; lang: string; expires_at: string };

export type DeliveryState = "valid" | "revealed" | "expired" | "unknown";

export const KEY_DELIVERY_TTL_MS = 24 * 3600 * 1000;
const DELIVERY_KEEP_MS = 30 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

function deliveryKey(token: string): Buffer {
  return createHash("sha256").update("xvcache-key-delivery/1|" + token, "utf8").digest();
}
function sealKey(api_key: string, token: string, token_hash: string): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deliveryKey(token), iv);
  c.setAAD(Buffer.from(token_hash, "utf8"));
  const ct = Buffer.concat([c.update(api_key, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function openKey(enc: { iv: string; ct: string; tag: string }, token: string, token_hash: string): string {
  const d = createDecipheriv("aes-256-gcm", deliveryKey(token), Buffer.from(enc.iv, "base64"));
  d.setAAD(Buffer.from(token_hash, "utf8"));
  d.setAuthTag(Buffer.from(enc.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc.ct, "base64")), d.final()]).toString("utf8");
}
export function isEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());
}

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

type StripeSubState = { status: SubscriptionStatus; at: number; customer?: string };

type StoreFile = {
  version: 1;
  subscriptions: SubscriptionRecord[];
  pairings: PairingRecord[];
  /** L4 webhook: ids of Stripe events already applied (idempotence), most recent last. */
  stripe_events?: string[];
  /** L4 webhook: last known status per Stripe subscription (events can arrive out of order). */
  stripe_subs?: Record<string, StripeSubState>;
  /** L4 webhook: paid checkouts that carried no (or an unknown) client_reference_id — to be handled by the operator. */
  unlinked_checkouts?: { event_id: string; session: string; customer?: string; subscription?: string; at: string }[];
  /** 0.3.0: one-time key-delivery links (hashed tokens, encrypted keys). */
  key_deliveries?: KeyDeliveryRecord[];
};

/** Normalised billing event (built from a verified Stripe event by stripe-webhook.ts). */
export type BillingEvent =
  | { id: string; created: number; kind: "checkout_completed"; session: string; ref: string | null; customer?: string; subscription?: string; paid: boolean; email?: string; locale?: string; plan_id?: string }
  | { id: string; created: number; kind: "subscription_status"; subscription: string; customer?: string; status: SubscriptionStatus }
  | { id: string; created: number; kind: "invoice_paid" | "invoice_failed"; subscription?: string; customer?: string }
  | { id: string; created: number; kind: "dispute"; customer?: string; charge?: string }
  | { id: string; created: number; kind: "ignored"; type: string };

export type BillingResult = { duplicate: boolean; applied: string; delivery?: PendingKeyDelivery };

export const MAX_STRIPE_EVENT_IDS = 5000;

/** Public, non-secret reference of a pairing sent to Stripe as client_reference_id (derived from the hash). */
export function checkoutRefFromCodeHash(code_hash: string): string {
  return "xvr_" + code_hash.slice(0, 40);
}
export function checkoutRef(pairing_code: string): string {
  return checkoutRefFromCodeHash(hashSecret(pairing_code.trim()));
}

export const PAIRING_TTL_MS = 24 * 3600 * 1000;

/** Days after termination (past_due or canceled) during which PDFs of existing proofs can still be re-issued. Flip to 90 if Julien so decides. */
export const POST_TERMINATION_ACCESS_DAYS = 365;
const MS_PER_DAY = 24 * 3600 * 1000;

export function terminationStartedAt(rec: Pick<SubscriptionRecord, "ended_at" | "period_start" | "created_at">): string {
  return rec.ended_at ?? rec.period_start ?? rec.created_at;
}

export function postTerminationAccessUntil(rec: Pick<SubscriptionRecord, "ended_at" | "period_start" | "created_at">): Date {
  return new Date(Date.parse(terminationStartedAt(rec)) + POST_TERMINATION_ACCESS_DAYS * MS_PER_DAY);
}

/** Access to existing-proof PDFs: full (active/trialing), grace (past_due/canceled within the window), or expired. */
export function existingProofAccess(rec: SubscriptionRecord, now: Date = new Date()): "full" | "grace" | "expired" {
  if (rec.status === "active" || rec.status === "trialing") return "full";
  if (rec.status === "past_due" || rec.status === "canceled") {
    return now.getTime() <= postTerminationAccessUntil(rec).getTime() ? "grace" : "expired";
  }
  return "expired";
}


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

  /**
   * @param o.keyDeliveryTtlMs when set (key delivery by email enabled), every key minted from a paid checkout that
   *   carries an email also gets a one-time link (see KeyDeliveryRecord). Unset = feature off (default).
   */
  constructor(private file: string, private now: () => Date = () => new Date(), private o: { keyDeliveryTtlMs?: number } = {}) {}

  currentTime(): Date {
    return this.now();
  }

  get keyDeliveryEnabled(): boolean {
    return typeof this.o.keyDeliveryTtlMs === "number" && this.o.keyDeliveryTtlMs > 0;
  }

  /** Inside a transaction: create the one-time link for a freshly minted key. */
  private newDelivery(data: StoreFile, api_key: string, key_hash: string, email: string, lang: string): PendingKeyDelivery {
    const token = randomBytes(32).toString("base64url");
    const token_hash = hashSecret(token);
    const created = this.now();
    const expires_at = new Date(created.getTime() + (this.o.keyDeliveryTtlMs ?? KEY_DELIVERY_TTL_MS)).toISOString();
    data.key_deliveries ??= [];
    data.key_deliveries = data.key_deliveries.filter((d) => Date.parse(d.expires_at) > created.getTime() - DELIVERY_KEEP_MS);
    data.key_deliveries.push({ token_hash, key_hash, email, lang, created_at: created.toISOString(), expires_at, enc: sealKey(api_key, token, token_hash) });
    return { token, token_hash, email, lang, expires_at };
  }

  /** State of a delivery link, without consuming it (GET page; mail scanners may open links). */
  deliveryState(token: string): Promise<{ state: DeliveryState; lang: string; expires_at?: string }> {
    return this.tx((data) => {
      const d = (data.key_deliveries ?? []).find((x) => x.token_hash === hashSecret(token));
      if (!d) return { state: "unknown" as const, lang: "en" };
      if (d.revealed_at) return { state: "revealed" as const, lang: d.lang };
      if (!d.enc || Date.parse(d.expires_at) <= this.now().getTime()) return { state: "expired" as const, lang: d.lang };
      return { state: "valid" as const, lang: d.lang, expires_at: d.expires_at };
    }, false);
  }

  /** Reveal the key ONCE (POST from the page): decrypts, then erases the ciphertext. */
  revealDeliveredKey(token: string): Promise<{ ok: true; api_key: string; lang: string; key_hint: string } | { ok: false; state: Exclude<DeliveryState, "valid">; lang: string }> {
    return this.tx((data) => {
      const d = (data.key_deliveries ?? []).find((x) => x.token_hash === hashSecret(token));
      if (!d) return { ok: false as const, state: "unknown" as const, lang: "en" };
      if (d.revealed_at) return { ok: false as const, state: "revealed" as const, lang: d.lang };
      if (!d.enc || Date.parse(d.expires_at) <= this.now().getTime()) {
        delete d.enc;
        return { ok: false as const, state: "expired" as const, lang: d.lang };
      }
      const api_key = openKey(d.enc, token, d.token_hash);
      delete d.enc;
      d.revealed_at = this.now().toISOString();
      return { ok: true as const, api_key, lang: d.lang, key_hint: api_key.slice(-4) };
    });
  }

  /** Record the outcome of the email send (no address, no token in the error text). */
  markDeliverySent(token_hash: string, r: { ok: boolean; error?: string }): Promise<void> {
    return this.tx((data) => {
      const d = (data.key_deliveries ?? []).find((x) => x.token_hash === token_hash);
      if (!d) return;
      if (r.ok) { d.sent_at = this.now().toISOString(); delete d.send_error; } else d.send_error = (r.error ?? "send failed").slice(0, 200);
    });
  }

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
  createApiKey(o: { plan_id: string; quota: number | null; status: SubscriptionStatus; default_lang?: string; ended_at?: string }): Promise<{ api_key: string; key_hash: string }> {
    return this.tx((data) => {
      const api_key = newSecret("xvc_", 32);
      const rec = this.newRecord(api_key, o);
      if (o.ended_at) rec.ended_at = o.ended_at;
      data.subscriptions.push(rec);
      return { api_key, key_hash: rec.key_hash };
    });
  }

  /** Tests / operator: change status and optional ended_at of an existing record. */
  setSubscriptionState(key_hash: string, patch: { status?: SubscriptionStatus; ended_at?: string | null }): Promise<SubscriptionRecord | null> {
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === key_hash);
      if (!rec) return null;
      if (patch.status !== undefined) rec.status = patch.status;
      if (patch.ended_at === null) delete rec.ended_at;
      else if (patch.ended_at !== undefined) rec.ended_at = patch.ended_at;
      if ((rec.status === "past_due" || rec.status === "canceled") && !rec.ended_at) rec.ended_at = this.now().toISOString();
      if (rec.status === "active" || rec.status === "trialing") delete rec.ended_at;
      return rec;
    });
  }

  authenticate(api_key: string | undefined | null): Promise<SubscriptionRecord | null> {
    if (!api_key) return Promise.resolve(null);
    const h = hashSecret(api_key.trim());
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === h);
      if (!rec) return null;
      // Retrocompatible: a past_due/canceled record stored without ended_at starts its window now (persisted once).
      if ((rec.status === "past_due" || rec.status === "canceled") && !rec.ended_at) {
        rec.ended_at = this.now().toISOString();
      }
      return rec;
    });
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

  /**
   * Hosted flow (0.3.0): check the monthly cap WITHOUT counting. Usage is counted by recordTimestamped() only when
   * a proof actually obtains its timestamp token, so a pending proof (pending_qualified) is never counted.
   * Paid subscriptions have quota null (unlimited); numeric quotas remain for operator/test keys.
   */
  checkQuota(key_hash: string, n: number): Promise<ConsumeResult> {
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === key_hash);
      if (!rec) throw new Error("unknown subscription");
      this.rollPeriod(rec);
      if (rec.quota !== null && rec.used + n > rec.quota) {
        return { ok: false as const, used: rec.used, quota: rec.quota, next_reset: nextMonthStart(this.now()).toISOString() };
      }
      return { ok: true as const, used: rec.used, quota: rec.quota };
    });
  }

  /** Count `n` proofs of this subscription that have just obtained their timestamp token. */
  recordTimestamped(key_hash: string, n: number): Promise<void> {
    return this.tx((data) => {
      const rec = data.subscriptions.find((s) => s.key_hash === key_hash);
      if (!rec) return;
      this.rollPeriod(rec);
      rec.used += n;
      rec.total_certified += n;
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

  /** Plan requested at request_upgrade, looked up from the public checkout reference (no side effect). */
  pairingPlanForCheckoutRef(ref: string | null | undefined): Promise<string | undefined> {
    if (!ref) return Promise.resolve(undefined);
    return this.tx((data) => data.pairings.find((x) => checkoutRefFromCodeHash(x.code_hash) === ref)?.plan_id, false);
  }

  /**
   * L4: apply one verified billing event, exactly once (event id), in one atomic write.
   * - checkout_completed + known ref → mint the API key for that pairing (returned once by get_subscription),
   *   linked to the Stripe customer / subscription.
   * - subscription_status / invoice_* → update the status of the linked record; older events never override newer ones.
   * - dispute → flag the record (no automatic cut-off; the operator decides).
   */
  applyBillingEvent(ev: BillingEvent): Promise<BillingResult> {
    return this.tx((data) => {
      data.stripe_events ??= [];
      data.stripe_subs ??= {};
      if (data.stripe_events.includes(ev.id)) return { duplicate: true, applied: "duplicate" };
      data.stripe_events.push(ev.id);
      if (data.stripe_events.length > MAX_STRIPE_EVENT_IDS) data.stripe_events.splice(0, data.stripe_events.length - MAX_STRIPE_EVENT_IDS);
      const subs = data.stripe_subs;
      const bySub = (id?: string) => (id ? data.subscriptions.find((r) => r.stripe_subscription === id) : undefined);
      const byCustomer = (id?: string) => (id ? data.subscriptions.filter((r) => r.stripe_customer === id) : []);
      const setSubStatus = (subId: string, status: SubscriptionStatus, at: number, customer?: string, force = false): boolean => {
        const cur = subs[subId];
        if (cur && !force && cur.at > at) return false; // stale event
        if (cur && cur.status === "canceled" && status !== "canceled" && !force) return false; // canceled is final
        subs[subId] = { status, at, customer: customer ?? cur?.customer };
        const rec = bySub(subId);
        if (rec) {
          const wasLive = rec.status === "active" || rec.status === "trialing";
          rec.status = status;
          if (status === "past_due" || status === "canceled") {
            if (wasLive || !rec.ended_at) rec.ended_at = new Date(at * 1000).toISOString();
          } else {
            delete rec.ended_at;
          }
        }
        return true;
      };
      switch (ev.kind) {
        case "checkout_completed": {
          const p = ev.ref ? data.pairings.find((x) => checkoutRefFromCodeHash(x.code_hash) === ev.ref) : undefined;
          const email = isEmail(ev.email) ? ev.email.trim() : undefined;
          if (!p && ev.paid && email && this.keyDeliveryEnabled && ev.subscription) {
            // Paid on the public payment link without an AI pairing (e.g. from the website): the key is minted
            // and delivered ONLY through the one-time email link.
            if (data.subscriptions.some((r) => r.stripe_subscription === ev.subscription)) return { duplicate: false, applied: "checkout_already_active" };
            const known = subs[ev.subscription];
            const status: SubscriptionStatus = known?.status ?? "active";
            const lang = (ev.locale ?? "").toLowerCase().startsWith("fr") ? "fr" : "en";
            const api_key = newSecret("xvc_", 32);
            const rec = this.newRecord(api_key, { plan_id: ev.plan_id ?? "coffre-horodate", quota: null, status, default_lang: lang });
            rec.stripe_customer = ev.customer;
            rec.stripe_subscription = ev.subscription;
            rec.email = email;
            data.subscriptions.push(rec);
            if (!known) subs[ev.subscription] = { status, at: ev.created, customer: ev.customer };
            const delivery = this.newDelivery(data, api_key, rec.key_hash, email, lang);
            return { duplicate: false, applied: `key_minted_email_only:${status}`, delivery };
          }
          if (!p || !ev.paid) {
            data.unlinked_checkouts ??= [];
            data.unlinked_checkouts.push({ event_id: ev.id, session: ev.session, customer: ev.customer, subscription: ev.subscription, at: this.now().toISOString() });
            return { duplicate: false, applied: !ev.paid ? "checkout_unpaid" : "checkout_unlinked" };
          }
          const known = ev.subscription ? subs[ev.subscription] : undefined;
          const status: SubscriptionStatus = known?.status ?? "active";
          if (p.state === "active") {
            const rec = data.subscriptions.find((r) => r.key_hash === p.key_hash);
            if (rec) { rec.stripe_customer ??= ev.customer; rec.stripe_subscription ??= ev.subscription; }
            return { duplicate: false, applied: "checkout_already_active" };
          }
          const api_key = newSecret("xvc_", 32);
          const rec = this.newRecord(api_key, { plan_id: p.plan_id, quota: null, status, default_lang: p.lang });
          rec.stripe_customer = ev.customer;
          rec.stripe_subscription = ev.subscription;
          if (email) rec.email = email;
          data.subscriptions.push(rec);
          p.state = "active";
          p.key_hash = rec.key_hash;
          p.api_key_once = api_key;
          if (ev.subscription && !known) subs[ev.subscription] = { status, at: ev.created, customer: ev.customer };
          const delivery = email && this.keyDeliveryEnabled ? this.newDelivery(data, api_key, rec.key_hash, email, p.lang) : undefined;
          return { duplicate: false, applied: `key_minted:${status}`, ...(delivery ? { delivery } : {}) };
        }
        case "subscription_status": {
          const ok = setSubStatus(ev.subscription, ev.status, ev.created, ev.customer);
          return { duplicate: false, applied: ok ? `status:${ev.status}${bySub(ev.subscription) ? "" : ":unlinked"}` : "stale_ignored" };
        }
        case "invoice_paid":
        case "invoice_failed": {
          const status: SubscriptionStatus = ev.kind === "invoice_paid" ? "active" : "past_due";
          if (ev.subscription) {
            const cur = subs[ev.subscription];
            // A paid invoice never revives a trial into "active" before the subscription event says so,
            // and never reopens a canceled subscription.
            if (ev.kind === "invoice_paid" && cur?.status === "trialing") return { duplicate: false, applied: "trialing_kept" };
            const ok = setSubStatus(ev.subscription, status, ev.created, ev.customer);
            return { duplicate: false, applied: ok ? `status:${status}` : "stale_ignored" };
          }
          return { duplicate: false, applied: "invoice_without_subscription" };
        }
        case "dispute": {
          const recs = byCustomer(ev.customer);
          for (const r of recs) r.disputed_at = this.now().toISOString();
          return { duplicate: false, applied: `dispute_flagged:${recs.length}` };
        }
        default:
          return { duplicate: false, applied: "ignored" };
      }
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
