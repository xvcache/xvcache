import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore, checkoutRef, hashSecret } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";
import { signStripePayload, paymentLinkBilling, STRIPE_WEBHOOK_PATH } from "./stripe-webhook.js";
import { KeyDeliveryService, cloudflareMailer, keyLinkEmail, type MailMessage, type Mailer, type FetchFn } from "./key-delivery.js";

const SECRET = "whsec_test_only_not_a_real_secret";
const LINK = "https://buy.stripe.com/test_xxxxxxxx";
let tmp: string;
before(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-keymail-")); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

type ToolOut = { isError?: boolean; content: { type: string; text?: string }[] };
const body = (r: unknown): Record<string, any> => JSON.parse((r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}");
let seq = 0;
const evt = (type: string, object: Record<string, unknown>) => ({ id: `evt_km_${++seq}`, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } });
async function post(hook: string, e: unknown) {
  const raw = JSON.stringify(e);
  const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signStripePayload(raw, SECRET) }, body: raw });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

async function setup(name: string, o: { mailer?: Mailer; ttlMs?: number; now?: () => Date } = {}) {
  const dataDir = path.join(tmp, name);
  const enabled = !!o.mailer;
  const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"), o.now, enabled ? { keyDeliveryTtlMs: o.ttlMs ?? 24 * 3600e3 } : {});
  const witness = new HostedWitness({ dataDir, tsa: null, ots: { enabled: false, calendars: [] }, batchWindowMs: 20, onAlert: () => {} });
  let base = "";
  const logs: Record<string, unknown>[] = [];
  const keyDelivery = o.mailer ? new KeyDeliveryService({ store, mailer: o.mailer, publicBaseUrl: () => base, retryDelaysMs: [0, 5, 5], log: (l) => logs.push(l) }) : undefined;
  const srv = await startRemoteServer({ store, witness, dataDir, port: 0, billing: paymentLinkBilling(LINK), stripeWebhookSecret: SECRET, billingTestMode: true, billingLog: () => {}, keyDelivery });
  base = srv.url.replace(/\/mcp$/, "");
  return { store, srv, hook: `${base}${STRIPE_WEBHOOK_PATH}`, base, keyDelivery, logs, dataDir };
}

async function pairingViaAi(url: string): Promise<{ ai: Client; pairing: string; ref: string }> {
  const ai = new Client({ name: "ai", version: "0" });
  await ai.connect(new StreamableHTTPClientTransport(new URL(url)));
  const up = body(await ai.callTool({ name: "request_upgrade", arguments: { lang: "fr", human_confirmed: true, consent_quote: "oui" } }));
  return { ai, pairing: up.pairing_code, ref: checkoutRef(up.pairing_code) };
}

function capture(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, mailer: { async send(m) { sent.push(m); return { message_id: "<m@test>" }; } } };
}

test("paid checkout with email → ONE email with a one-time link, never the key; GET does not consume; POST shows the key once; then 410", async () => {
  const cap = capture();
  const { srv, hook, base, keyDelivery, store, dataDir, logs } = await setup("happy", { mailer: cap.mailer });
  try {
    const { ai, pairing, ref } = await pairingViaAi(srv.url);
    const r = await post(hook, evt("checkout.session.completed", { id: "cs_1", client_reference_id: ref, customer: "cus_1", subscription: "sub_1", payment_status: "paid", customer_details: { email: "avocate@cabinet.example" }, locale: "fr" }));
    assert.equal(r.status, 200);
    await keyDelivery!.idle();
    assert.equal(cap.sent.length, 1);
    const m = cap.sent[0];
    assert.equal(m.to, "avocate@cabinet.example");
    assert.match(m.subject, /usage unique/);
    // the AI still gets the key once
    const sub = body(await ai.callTool({ name: "get_subscription", arguments: { pairing_code: pairing } }));
    assert.match(sub.api_key, /^xvc_/);
    assert.match(sub.next_action, /Show api_key to the human NOW, once/);
    assert.match(sub.next_action, /emailed/);
    const key: string = sub.api_key;
    assert.ok(!m.text.includes(key) && !m.html.includes(key), "the key is never in the email");
    assert.ok(!m.text.includes("xvc_") && !m.html.includes("xvc_"));
    const link = m.text.split("\n").find((l) => l.startsWith(`${base}/key/`))!;
    assert.ok(link, "link to this server");
    assert.ok(m.html.includes(link));
    assert.match(m.text, /expire le .*heure de Paris/);
    // the store keeps only the token hash and an encrypted key
    const raw = await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8");
    const token = link.slice(link.lastIndexOf("/") + 1);
    assert.ok(!raw.includes(token), "token not stored in clear");
    assert.ok(raw.includes(hashSecret(token)), "token stored hashed");
    const stored = JSON.parse(raw);
    assert.equal(stored.subscriptions[0].email, "avocate@cabinet.example", "customer_details.email kept");
    assert.ok(!raw.includes(key.slice(4)), "key not stored in clear once get_subscription consumed it");
    assert.ok(stored.key_deliveries[0].sent_at);
    assert.ok(!JSON.stringify(logs).includes("avocate@") && !JSON.stringify(logs).includes(token), "logs carry neither address nor token");
    // GET (e.g. a mail scanner) does not consume
    for (let i = 0; i < 2; i++) {
      const g = await fetch(link);
      assert.equal(g.status, 200);
      assert.equal(g.headers.get("cache-control"), "no-store, max-age=0");
      assert.equal(g.headers.get("referrer-policy"), "no-referrer");
      const html = await g.text();
      assert.ok(!html.includes(key), "GET never shows the key");
      assert.match(html, /<form method="post"/);
      assert.match(html, /une seule fois/);
    }
    const p1 = await fetch(link, { method: "POST" });
    assert.equal(p1.status, 200);
    const html1 = await p1.text();
    assert.ok(html1.includes(key), "POST shows the key");
    assert.match(html1, /Sauvegardez-la maintenant/);
    const p2 = await fetch(link, { method: "POST" });
    assert.equal(p2.status, 410, "second reveal refused");
    assert.ok(!(await p2.text()).includes(key));
    assert.equal((await fetch(link)).status, 410);
    assert.ok(!(await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8")).includes('"ct"'), "ciphertext erased after reveal");
    assert.equal((await fetch(`${base}/key/${"A".repeat(43)}`)).status, 404);
    assert.equal((await fetch(`${base}/key/short`)).status, 404);
    await ai.close();
  } finally { await srv.close(); }
});

test("link expires after the TTL (24 h by default) → 410, ciphertext erased; Stripe retry of the same event sends nothing", async () => {
  const cap = capture();
  let now = Date.parse("2026-11-23T08:00:00Z");
  const { srv, hook, keyDelivery, store, dataDir } = await setup("expiry", { mailer: cap.mailer, now: () => new Date(now) });
  try {
    const { ai, ref } = await pairingViaAi(srv.url);
    const e = evt("checkout.session.completed", { id: "cs_2", client_reference_id: ref, customer: "cus_2", subscription: "sub_2", payment_status: "paid", customer_details: { email: "x@y.example" } });
    await post(hook, e);
    await post(hook, e); // Stripe retry → duplicate
    await keyDelivery!.idle();
    assert.equal(cap.sent.length, 1, "one email only");
    const link = cap.sent[0].text.split("\n").find((l) => l.includes("/key/"))!;
    const token = link.slice(link.lastIndexOf("/") + 1);
    assert.equal((await store.deliveryState(token)).state, "valid");
    now += 24 * 3600e3 + 1;
    assert.equal((await fetch(link)).status, 410);
    assert.equal((await fetch(link, { method: "POST" })).status, 410);
    assert.ok(!(await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8")).includes('"ct"'));
    await ai.close();
  } finally { await srv.close(); }
});

test("feature OFF by default: no email, no delivery record; checkout without email: no email; unlinked paid checkout stays for the operator", async () => {
  const off = await setup("off");
  try {
    const { ai, ref } = await pairingViaAi(off.srv.url);
    const r = await post(off.hook, evt("checkout.session.completed", { id: "cs_3", client_reference_id: ref, customer: "cus_3", subscription: "sub_3", payment_status: "paid", customer_details: { email: "a@b.example" } }));
    assert.equal(r.status, 200);
    const raw = JSON.parse(await fs.readFile(path.join(off.dataDir, "subscriptions.json"), "utf8"));
    assert.equal(raw.key_deliveries, undefined);
    const unl = await post(off.hook, evt("checkout.session.completed", { id: "cs_4", customer: "cus_4", subscription: "sub_4", payment_status: "paid", customer_details: { email: "c@d.example" } }));
    assert.equal(unl.status, 200);
    const raw2 = JSON.parse(await fs.readFile(path.join(off.dataDir, "subscriptions.json"), "utf8"));
    assert.equal(raw2.unlinked_checkouts.length, 1, "unchanged 0.2 behaviour when the feature is off");
    assert.equal(raw2.subscriptions.length, 1);
    await ai.close();
  } finally { await off.srv.close(); }
  const cap = capture();
  const on = await setup("noemail", { mailer: cap.mailer });
  try {
    const { ai, ref } = await pairingViaAi(on.srv.url);
    await post(on.hook, evt("checkout.session.completed", { id: "cs_5", client_reference_id: ref, customer: "cus_5", subscription: "sub_5", payment_status: "paid" }));
    await on.keyDelivery!.idle();
    assert.equal(cap.sent.length, 0);
    await ai.close();
  } finally { await on.srv.close(); }
});

test("paid on the public link without AI pairing (website) and feature ON → key minted, delivered ONLY by the one-time link; canceled later → key refused", async () => {
  const cap = capture();
  const { srv, hook, keyDelivery } = await setup("website", { mailer: cap.mailer });
  try {
    const r = await post(hook, evt("checkout.session.completed", { id: "cs_6", customer: "cus_6", subscription: "sub_6", payment_status: "paid", customer_details: { email: "pro@firm.example" }, locale: "en" }));
    assert.equal(r.status, 200);
    await keyDelivery!.idle();
    assert.equal(cap.sent.length, 1);
    assert.match(cap.sent[0].subject, /one-time/);
    const link = cap.sent[0].text.split("\n").find((l) => l.includes("/key/"))!;
    const html = await (await fetch(link, { method: "POST" })).text();
    const key = /<code>(xvc_[A-Za-z0-9_-]+)<\/code>/.exec(html)![1];
    const c = new Client({ name: "c", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    assert.equal(body(await c.callTool({ name: "get_usage", arguments: {} })).status, "active");
    await post(hook, evt("customer.subscription.deleted", { id: "sub_6", customer: "cus_6", status: "canceled" }));
    assert.equal(body(await c.callTool({ name: "get_usage", arguments: {} })).code, "PAYMENT_REQUIRED");
    await c.close();
  } finally { await srv.close(); }
});

test("email send fails → retried, then recorded as failed (no address in logs); the AI channel still works", async () => {
  let calls = 0;
  const { srv, hook, keyDelivery, dataDir, logs } = await setup("fail", { mailer: { async send() { calls++; throw new Error("Cloudflare Email Sending HTTP 403 (10203 email.sending.error.email.sending_disabled)"); } } });
  try {
    const { ai, pairing, ref } = await pairingViaAi(srv.url);
    await post(hook, evt("checkout.session.completed", { id: "cs_7", client_reference_id: ref, customer: "cus_7", subscription: "sub_7", payment_status: "paid", customer_details: { email: "f@g.example" } }));
    await keyDelivery!.idle();
    assert.equal(calls, 3);
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8"));
    assert.match(raw.key_deliveries[0].send_error, /10203/);
    assert.ok(!JSON.stringify(logs).includes("f@g.example"));
    assert.match(body(await ai.callTool({ name: "get_subscription", arguments: { pairing_code: pairing } })).api_key, /^xvc_/);
    await ai.close();
  } finally { await srv.close(); }
});

test("Cloudflare mailer: REST call shape (POST /accounts/{id}/email/sending/send, Bearer, from {address,name}, reply_to) and errors", async () => {
  const seen: { url: string; init: any }[] = [];
  const ok: FetchFn = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ success: true, errors: [], result: { message_id: "<id@x>", delivered: ["a@b.example"], permanent_bounces: [], queued: [], suppressed_recipients: [] } }) }; };
  const m = cloudflareMailer({ accountId: "acc123", apiToken: "tok_test", from: "cle@xvcache.com", fromName: "XVcache", replyTo: "contact@xvcache.com", fetchImpl: ok });
  const mail = keyLinkEmail({ link: "https://mcp.xvcache.com/key/abc", expires_at: "2026-11-24T07:00:00Z", lang: "fr" });
  assert.deepEqual(await m.send({ to: "a@b.example", ...mail }), { message_id: "<id@x>" });
  assert.equal(seen[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.Authorization, "Bearer tok_test");
  const payload = JSON.parse(seen[0].init.body);
  assert.deepEqual(payload.from, { address: "cle@xvcache.com", name: "XVcache" });
  assert.equal(payload.reply_to, "contact@xvcache.com");
  assert.equal(payload.to, "a@b.example");
  assert.ok(payload.text && payload.html, "text and html both sent");
  assert.match(payload.text, /8:00|08:00/, "expiry shown in Paris time");
  assert.match(payload.text, /RENO'LINE SARL/);
  const bad: FetchFn = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10102, message: "email.sending.error.authentication.forbidden" }] }) });
  await assert.rejects(cloudflareMailer({ accountId: "a", apiToken: "t", from: "f@x.com", fetchImpl: bad }).send({ to: "a@b.example", ...mail }), /403.*10102/);
  const bounce: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { permanent_bounces: ["a@b.example"] } }) });
  await assert.rejects(cloudflareMailer({ accountId: "a", apiToken: "t", from: "f@x.com", fetchImpl: bounce }).send({ to: "a@b.example", ...mail }), /bounce/);
});
