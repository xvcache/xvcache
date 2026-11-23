import { createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { PAIRING_TTL_MS, checkoutRef, type BillingEvent, type BillingResult, type PendingKeyDelivery, type SubscriptionStatus, type SubscriptionStore } from "./subscriptions.js";
import type { Billing, CheckoutRequest, CheckoutResult } from "./plans.js";
import { checkPaidCheckout, loadStripePriceTableFromEnv, priceCheckLogFields, type PriceTable, type PriceTableLoad } from "./stripe-price-table.js";

/**
 * L4 — Stripe billing for the hosted server, with no Stripe SDK and no Stripe secret key on the server:
 * - Checkout = the Stripe Payment Link, with `client_reference_id` = public reference of the pairing
 *   (derived from the pairing-code hash; the pairing code itself never goes to Stripe).
 * - Webhook `POST /stripe/webhook`: signature checked with STRIPE_WEBHOOK_SECRET (whsec_…, HMAC-SHA256,
 *   5-minute tolerance, constant-time compare), each event applied exactly once (event id).
 * Env: XVCACHE_STRIPE_PAYMENT_LINK_URL (https://buy.stripe.com/…), STRIPE_WEBHOOK_SECRET,
 *   XVCACHE_STRIPE_PRICE_TABLE (path) or XVCACHE_STRIPE_PRICE_TABLE_JSON (see stripe-price-table.example.json).
 * Billing is "live" (request_upgrade returns a checkout_url) only when both the link and the webhook secret are set.
 * A paid checkout is applied only if it matches the price table (price id or lookup_key, amount, currency, livemode, plan).
 * Non-conforming payments are refused: HTTP 200 with rejected=true (so Stripe does not retry), no key, no subscription,
 * and a log line without personal data or secrets. A missing/empty table refuses every paid checkout.
 */

export const STRIPE_WEBHOOK_PATH = "/stripe/webhook";
export const SIGNATURE_TOLERANCE_S = 300;
export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.dispute.created",
] as const;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/** Verify a `Stripe-Signature` header (t=…,v1=…) against the raw body. */
export function verifyStripeSignature(raw: Buffer | string, header: string | undefined, secret: string, nowS = Math.floor(Date.now() / 1000), toleranceS = SIGNATURE_TOLERANCE_S): SignatureCheck {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!header) return { ok: false, reason: "missing Stripe-Signature" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t === null || !v1.length) return { ok: false, reason: "malformed Stripe-Signature" };
  if (Math.abs(nowS - t) > toleranceS) return { ok: false, reason: "timestamp outside tolerance" };
  const payload = Buffer.concat([Buffer.from(`${t}.`, "utf8"), Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8")]);
  const expected = createHmac("sha256", secret).update(payload).digest();
  for (const s of v1) {
    const got = Buffer.from(s, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

/** Test helper: build a valid header for a payload. */
export function signStripePayload(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex")}`;
}

type Obj = Record<string, any>;
const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as Obj).id === "string" ? (v as Obj).id : undefined);

export function mapStripeStatus(s: string): SubscriptionStatus {
  switch (s) {
    case "active": return "active";
    case "trialing": return "trialing";
    case "canceled":
    case "incomplete_expired": return "canceled";
    default: return "past_due"; // past_due, unpaid, incomplete, paused
  }
}

/** Stripe event (already verified) → normalised billing event. Works with old and new API versions. */
export function normalizeStripeEvent(evt: Obj): BillingEvent {
  const id = String(evt.id ?? "");
  const created = Number(evt.created ?? 0);
  const o: Obj = evt.data?.object ?? {};
  switch (evt.type) {
    case "checkout.session.completed":
      return {
        id, created, kind: "checkout_completed", session: String(o.id ?? ""),
        ref: typeof o.client_reference_id === "string" ? o.client_reference_id : null,
        customer: idOf(o.customer), subscription: idOf(o.subscription),
        paid: o.payment_status === "paid" || o.payment_status === "no_payment_required",
        email: typeof o.customer_details?.email === "string" ? o.customer_details.email : typeof o.customer_email === "string" ? o.customer_email : undefined,
        locale: typeof o.locale === "string" ? o.locale : undefined,
      };
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return { id, created, kind: "subscription_status", subscription: String(o.id ?? ""), customer: idOf(o.customer), status: evt.type === "customer.subscription.deleted" ? "canceled" : mapStripeStatus(String(o.status ?? "")) };
    case "invoice.paid":
    case "invoice.payment_failed":
      return {
        id, created, kind: evt.type === "invoice.paid" ? "invoice_paid" : "invoice_failed",
        subscription: idOf(o.subscription) ?? idOf(o.parent?.subscription_details?.subscription),
        customer: idOf(o.customer),
      };
    case "charge.dispute.created":
      return { id, created, kind: "dispute", charge: idOf(o.charge), customer: idOf(o.customer) ?? idOf(o.charge?.customer) };
    default:
      return { id, created, kind: "ignored", type: String(evt.type ?? "") };
  }
}

export type WebhookLog = (line: Record<string, unknown>) => void;

/** HTTP handler for POST /stripe/webhook. Never logs secrets nor personal data (ids and types only). */
export type StripeWebhookOptions = {
  store: SubscriptionStore;
  secret: string | undefined;
  log?: WebhookLog;
  now?: () => number;
  onKeyDelivery?: (d: PendingKeyDelivery) => void;
  /** Already-loaded table, or a load result. If omitted, loaded from the env on each process start via the caller. */
  priceTable?: PriceTable | PriceTableLoad;
  stripePriceTablePath?: string;
};

export function resolveWebhookPriceTable(o: { priceTable?: PriceTable | PriceTableLoad; stripePriceTablePath?: string }): PriceTableLoad {
  if (o.priceTable && "ok" in (o.priceTable as PriceTableLoad) && typeof (o.priceTable as PriceTableLoad).ok === "boolean") return o.priceTable as PriceTableLoad;
  if (o.priceTable && typeof o.priceTable === "object" && "livemode" in o.priceTable && "entries" in o.priceTable) {
    return { ok: true, table: o.priceTable as PriceTable, source: "option" };
  }
  return loadStripePriceTableFromEnv(o.stripePriceTablePath);
}

export async function handleStripeWebhook(req: http.IncomingMessage, res: http.ServerResponse, o: StripeWebhookOptions): Promise<void> {
  const log = o.log ?? ((l) => process.stderr.write(`xvcache-billing ${JSON.stringify(l)}\n`));
  const reply = (code: number, body: Record<string, unknown>) => { res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body)); };
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
  if (!o.secret) { reply(503, { ok: false, error: "webhook not configured" }); return; }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 512 * 1024) { reply(413, { ok: false, error: "body too large" }); return; }
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks);
  const sig = verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, o.secret, Math.floor((o.now?.() ?? Date.now()) / 1000));
  if (!sig.ok) { log({ ok: false, error: "bad_signature", reason: sig.reason }); reply(400, { ok: false, error: "invalid signature" }); return; }
  let evt: Obj;
  try { evt = JSON.parse(raw.toString("utf8")); } catch { reply(400, { ok: false, error: "invalid json" }); return; }
  if (typeof evt.id !== "string" || typeof evt.type !== "string") { reply(400, { ok: false, error: "not an event" }); return; }
  const norm = normalizeStripeEvent(evt);
  // Paid checkouts must match the configured price table before any key or subscription is created.
  // HTTP 200 + rejected (not 4xx): the event is understood and will never be honoured, so Stripe
  // must not retry it for days; a later retry must also not suddenly mint a key if the table changes.
  // Signature errors stay 400; store failures stay 500 (transient, Stripe may retry).
  if (norm.kind === "checkout_completed" && norm.paid) {
    const table = resolveWebhookPriceTable(o);
    const pairingPlan = typeof o.store.pairingPlanForCheckoutRef === "function" ? await o.store.pairingPlanForCheckoutRef(norm.ref) : undefined;
    const check = checkPaidCheckout(evt, table, { pairingPlan });
    if (!check.ok) {
      log({ ok: false, event: evt.id, type: evt.type, livemode: evt.livemode === true, ...priceCheckLogFields(check) });
      reply(200, { ok: false, received: evt.id, rejected: true, reason: check.reason });
      return;
    }
    norm.plan_id = check.plan_id;
  }
  let r: BillingResult;
  try {
    r = await o.store.applyBillingEvent(norm);
  } catch (e) {
    log({ ok: false, event: evt.id, type: evt.type, error: e instanceof Error ? e.message : String(e) });
    reply(500, { ok: false, error: "store error" }); // Stripe retries
    return;
  }
  const accepted = norm.kind === "checkout_completed" && norm.paid && r.applied.startsWith("key_minted")
    ? { price_check: "accepted" as const, plan_id: norm.plan_id }
    : {};
  log({ ok: true, event: evt.id, type: evt.type, livemode: evt.livemode === true, applied: r.applied, ...accepted, ...(r.delivery ? { key_link_email: o.onKeyDelivery ? "queued" : "disabled" } : {}) });
  reply(200, { ok: true, received: evt.id, duplicate: r.duplicate });
  // After answering Stripe: email the one-time link (never the key). Failures are logged, retried by the service.
  if (r.delivery && o.onKeyDelivery) o.onKeyDelivery(r.delivery);
}

/** Billing through a Stripe Payment Link (no API key needed on the server). */
export function paymentLinkBilling(url: string | undefined, now: () => Date = () => new Date()): Billing | undefined {
  if (!url) return undefined;
  let base: URL;
  try { base = new URL(url); } catch { return undefined; }
  if (base.protocol !== "https:" || base.hostname !== "buy.stripe.com") return undefined;
  return {
    live: true,
    async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
      if (!req.pairing_code) throw new Error("no pairing code");
      const u = new URL(base.toString());
      u.searchParams.set("client_reference_id", checkoutRef(req.pairing_code));
      if (req.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.email)) u.searchParams.set("prefilled_email", req.email);
      return { checkout_url: u.toString(), expires_at: new Date(now().getTime() + PAIRING_TTL_MS).toISOString(), pairing_code: req.pairing_code };
    },
  };
}

/** True for a Stripe TEST payment link (buy.stripe.com/test_…). */
export function isTestPaymentLink(url: string | undefined): boolean {
  return !!url && /^https:\/\/buy\.stripe\.com\/test_/.test(url);
}
