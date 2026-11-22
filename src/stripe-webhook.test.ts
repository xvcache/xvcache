import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore, checkoutRef } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";
import { verifyStripeSignature, signStripePayload, normalizeStripeEvent, paymentLinkBilling, STRIPE_WEBHOOK_PATH } from "./stripe-webhook.js";

const SECRET = "whsec_test_only_not_a_real_secret";
const LINK = "https://buy.stripe.com/test_xxxxxxxx";
let tmp: string;
before(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-stripe-")); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

type ToolOut = { isError?: boolean; content: { type: string; text?: string }[] };
const body = (r: unknown): Record<string, any> => JSON.parse((r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}");

async function setup(name: string, secret: string | null = SECRET) {
  const dataDir = path.join(tmp, name);
  const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"));
  const witness = new HostedWitness({ dataDir, tsa: null, ots: { enabled: false, calendars: [] }, batchWindowMs: 20, onAlert: () => {} });
  const logs: Record<string, unknown>[] = [];
  const srv = await startRemoteServer({ store, witness, dataDir, port: 0, billing: paymentLinkBilling(LINK), stripeWebhookSecret: secret ?? undefined, billingTestMode: true, billingLog: (l) => logs.push(l) });
  const hook = srv.url.replace(/\/mcp$/, STRIPE_WEBHOOK_PATH);
  return { store, srv, hook, logs, dataDir };
}

let seq = 0;
function evt(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) {
  return { id: `evt_test_${++seq}`, object: "event", type, created, livemode: false, data: { object } };
}
async function post(hook: string, e: unknown, o: { secret?: string; header?: string } = {}) {
  const raw = JSON.stringify(e);
  const header = o.header ?? signStripePayload(raw, o.secret ?? SECRET);
  const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": header }, body: raw });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

test("signature: valid, wrong secret, tampered body, old timestamp, malformed", () => {
  const raw = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  const h = signStripePayload(raw, SECRET, now);
  assert.deepEqual(verifyStripeSignature(raw, h, SECRET, now), { ok: true });
  assert.equal(verifyStripeSignature(raw, h, "whsec_other", now).ok, false);
  assert.equal(verifyStripeSignature(raw + " ", h, SECRET, now).ok, false);
  assert.equal(verifyStripeSignature(raw, h, SECRET, now + 301).ok, false);
  assert.equal(verifyStripeSignature(raw, "garbage", SECRET, now).ok, false);
  assert.equal(verifyStripeSignature(raw, undefined, SECRET, now).ok, false);
  // several v1 (secret rotation): any match is enough
  const multi = `t=${now},v1=${"0".repeat(64)},${h.split(",")[1]}`;
  assert.deepEqual(verifyStripeSignature(raw, multi, SECRET, now), { ok: true });
});

test("normalize: invoice subscription id from old (invoice.subscription) and new (parent.subscription_details) API shapes", () => {
  const a = normalizeStripeEvent(evt("invoice.paid", { subscription: "sub_A", customer: "cus_1" }));
  const b = normalizeStripeEvent(evt("invoice.payment_failed", { parent: { subscription_details: { subscription: "sub_B" } }, customer: "cus_1" }));
  assert.equal(a.kind === "invoice_paid" && a.subscription, "sub_A");
  assert.equal(b.kind === "invoice_failed" && b.subscription, "sub_B");
  const d = normalizeStripeEvent(evt("customer.subscription.deleted", { id: "sub_C", status: "canceled", customer: "cus_1" }));
  assert.equal(d.kind === "subscription_status" && d.status, "canceled");
});

test("payment link billing: client_reference_id is the public pairing ref (never the pairing code)", async () => {
  const b = paymentLinkBilling(LINK)!;
  const r = await b.createCheckout({ plan_id: "coffre-horodate", lang: "fr" as any, consent_quote: "oui", consent_at: "x", pairing_code: "xvp_secret", email: "a@b.eu" });
  const u = new URL(r.checkout_url);
  assert.equal(u.searchParams.get("client_reference_id"), checkoutRef("xvp_secret"));
  assert.ok(!r.checkout_url.includes("xvp_secret"));
  assert.equal(u.searchParams.get("prefilled_email"), "a@b.eu");
  assert.equal(paymentLinkBilling("https://evil.example/pay"), undefined);
});

test("webhook end to end: request_upgrade → checkout.session.completed → get_subscription (key once) → past_due → active → canceled; idempotent; dispute flagged", async () => {
  const { srv, hook, store, logs, dataDir } = await setup("e2e");
  try {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
    const up = body(await c.callTool({ name: "request_upgrade", arguments: { lang: "fr", human_confirmed: true, consent_quote: "Oui, j'accepte" } }));
    assert.equal(up.ok, true);
    assert.equal(up.test_mode, true);
    const ref = new URL(up.checkout_url).searchParams.get("client_reference_id");
    assert.match(String(ref), /^xvr_[0-9a-f]{40}$/);
    assert.equal(body(await c.callTool({ name: "get_subscription", arguments: { pairing_code: up.pairing_code } })).code, "NOT_PAID_YET");

    // subscription.created may arrive BEFORE checkout.session.completed
    const t0 = Math.floor(Date.now() / 1000);
    assert.equal((await post(hook, evt("customer.subscription.created", { id: "sub_1", customer: "cus_1", status: "active" }, t0))).status, 200);
    const done = evt("checkout.session.completed", { id: "cs_test_1", client_reference_id: ref, customer: "cus_1", subscription: "sub_1", payment_status: "paid" }, t0);
    const r1 = await post(hook, done);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.duplicate, false);
    const r2 = await post(hook, done); // Stripe retry → no second key
    assert.equal(r2.status, 200);
    assert.equal(r2.json.duplicate, true);

    const sub = body(await c.callTool({ name: "get_subscription", arguments: { pairing_code: up.pairing_code } }));
    assert.equal(sub.status, "active");
    assert.match(sub.api_key, /^xvc_/);
    assert.equal(sub.default_lang, "fr");
    assert.equal(body(await c.callTool({ name: "get_subscription", arguments: { pairing_code: up.pairing_code } })).api_key, null, "key shown once");
    assert.equal((await store.authenticate(sub.api_key))!.stripe_customer, "cus_1");

    assert.equal((await post(hook, evt("invoice.payment_failed", { customer: "cus_1", parent: { subscription_details: { subscription: "sub_1" } } }, t0 + 10))).status, 200);
    assert.equal((await store.authenticate(sub.api_key))!.status, "past_due");
    // a stale event (older) does not override
    assert.equal((await post(hook, evt("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active" }, t0 + 5))).json.ok, true);
    assert.equal((await store.authenticate(sub.api_key))!.status, "past_due");
    assert.equal((await post(hook, evt("invoice.paid", { customer: "cus_1", subscription: "sub_1" }, t0 + 20))).status, 200);
    assert.equal((await store.authenticate(sub.api_key))!.status, "active");
    assert.equal((await post(hook, evt("charge.dispute.created", { id: "dp_1", charge: "ch_1", customer: "cus_1" }, t0 + 25))).status, 200);
    assert.ok((await store.authenticate(sub.api_key))!.disputed_at);
    assert.equal((await post(hook, evt("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled" }, t0 + 30))).status, 200);
    assert.equal((await store.authenticate(sub.api_key))!.status, "canceled");
    assert.equal((await post(hook, evt("invoice.paid", { customer: "cus_1", subscription: "sub_1" }, t0 + 40))).status, 200);
    assert.equal((await store.authenticate(sub.api_key))!.status, "canceled", "canceled is final");

    // canceled key → paid tools refused
    const lawyer = new Client({ name: "l", version: "0" });
    await lawyer.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${sub.api_key}` } } }));
    assert.equal(body(await lawyer.callTool({ name: "certify_hash", arguments: { items: [{ sha256: "a".repeat(64) }] } })).code, "PAYMENT_REQUIRED");

    // unlinked checkout is recorded for the operator, no key minted
    assert.equal((await post(hook, evt("checkout.session.completed", { id: "cs_test_2", client_reference_id: null, customer: "cus_2", subscription: "sub_2", payment_status: "paid" }))).status, 200);
    const raw = await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8");
    assert.ok(!raw.includes(sub.api_key), "plain key erased after first read");
    assert.equal(JSON.parse(raw).unlinked_checkouts.length, 1);
    assert.ok(logs.every((l) => !JSON.stringify(l).includes(SECRET)));
  } finally { await srv.close(); }
});

test("webhook rejects bad signatures (400), wrong method (405), and answers 503 without a secret", async () => {
  const a = await setup("bad");
  try {
    assert.equal((await post(a.hook, evt("invoice.paid", {}), { secret: "whsec_wrong" })).status, 400);
    assert.equal((await post(a.hook, evt("invoice.paid", {}), { header: "t=1,v1=" + "0".repeat(64) })).status, 400);
    assert.equal((await fetch(a.hook)).status, 405);
    assert.ok(a.logs.some((l) => l.error === "bad_signature"));
  } finally { await a.srv.close(); }
  const b = await setup("nosecret", null);
  try {
    assert.equal((await post(b.hook, evt("invoice.paid", {}))).status, 503);
  } finally { await b.srv.close(); }
});
