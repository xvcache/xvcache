import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";
import { signStripePayload, paymentLinkBilling, STRIPE_WEBHOOK_PATH } from "./stripe-webhook.js";

/**
 * A2: the webhook must check a paid checkout against a configured price table
 * (price id or lookup_key, amount, currency, livemode, plan) before minting a key.
 * These tests use only APIs present on 2a389fc (env XVCACHE_STRIPE_PRICE_TABLE +
 * signed local events). They must compile and fail their assertions on that
 * commit, then pass after the fix.
 */

const SECRET = "whsec_test_only_not_a_real_secret";
const LINK = "https://buy.stripe.com/test_xxxxxxxx";
const TABLE_ENV = "XVCACHE_STRIPE_PRICE_TABLE";

/** Fake Stripe identifiers — examples only, not real prices. */
const PRICE_ESSENTIEL = "price_EXAMPLE_essentiel_monthly";
const PRICE_CABINET = "price_EXAMPLE_cabinet_monthly";
const LOOKUP_ESSENTIEL = "exemple_essentiel_mensuel";
const LOOKUP_CABINET = "exemple_cabinet_mensuel";

const FIXTURE_TABLE = {
  livemode: false,
  entries: [
    { plan_id: "essentiel", price_id: PRICE_ESSENTIEL, lookup_key: LOOKUP_ESSENTIEL, amount: 2900, currency: "eur" },
    { plan_id: "cabinet", price_id: PRICE_CABINET, lookup_key: LOOKUP_CABINET, amount: 5900, currency: "eur" },
  ],
};

type ToolOut = { isError?: boolean; content: { type: string; text?: string }[] };
const body = (r: unknown): Record<string, any> => JSON.parse((r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}");

let tmp: string;
let prevTableEnv: string | undefined;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-price-check-"));
  prevTableEnv = process.env[TABLE_ENV];
});
after(async () => {
  if (prevTableEnv === undefined) delete process.env[TABLE_ENV];
  else process.env[TABLE_ENV] = prevTableEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

let seq = 0;
function evt(type: string, object: Record<string, unknown>, o: { created?: number; livemode?: boolean } = {}) {
  return { id: `evt_pc_${++seq}`, object: "event", type, created: o.created ?? Math.floor(Date.now() / 1000), livemode: o.livemode ?? false, data: { object } };
}

function line(priceId: string, amount: number, currency: string, lookup?: string) {
  return {
    amount_subtotal: amount,
    amount_total: amount,
    currency,
    quantity: 1,
    price: { id: priceId, lookup_key: lookup, unit_amount: amount, currency },
  };
}

function paidSession(ref: string | null, o: {
  price_id?: string;
  lookup_key?: string;
  amount?: number;
  currency?: string;
  plan_id?: string;
  line_items?: unknown;
  id?: string;
  subscription?: string;
  customer?: string;
} = {}) {
  const amount = o.amount ?? 2900;
  const currency = o.currency ?? "eur";
  const price_id = o.price_id ?? PRICE_ESSENTIEL;
  const lookup_key = o.lookup_key ?? LOOKUP_ESSENTIEL;
  const plan_id = o.plan_id ?? "essentiel";
  return {
    id: o.id ?? `cs_pc_${seq}`,
    client_reference_id: ref,
    customer: o.customer ?? "cus_pc",
    subscription: o.subscription ?? `sub_pc_${seq}`,
    payment_status: "paid",
    amount_total: amount,
    currency,
    metadata: { plan_id, price_id, lookup_key },
    line_items: o.line_items ?? { object: "list", data: [line(price_id, amount, currency, lookup_key)] },
  };
}

async function post(hook: string, e: unknown) {
  const raw = JSON.stringify(e);
  const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": signStripePayload(raw, SECRET) }, body: raw });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

async function setup(name: string, table: typeof FIXTURE_TABLE | null) {
  const dataDir = path.join(tmp, name);
  await fs.mkdir(dataDir, { recursive: true });
  if (table) {
    const tablePath = path.join(dataDir, "stripe-price-table.json");
    await fs.writeFile(tablePath, JSON.stringify(table, null, 2));
    process.env[TABLE_ENV] = tablePath;
  } else {
    delete process.env[TABLE_ENV];
  }
  const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"));
  const witness = new HostedWitness({ dataDir, tsa: null, ots: { enabled: false, calendars: [] }, batchWindowMs: 20, onAlert: () => {} });
  const logs: Record<string, unknown>[] = [];
  const srv = await startRemoteServer({ store, witness, dataDir, port: 0, billing: paymentLinkBilling(LINK), stripeWebhookSecret: SECRET, billingTestMode: true, billingLog: (l) => logs.push(l) });
  return { store, srv, hook: srv.url.replace(/\/mcp$/, STRIPE_WEBHOOK_PATH), logs, dataDir };
}

async function upgrade(url: string, plan_id?: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  const args: Record<string, unknown> = { lang: "fr", human_confirmed: true, consent_quote: "Oui, j'accepte" };
  if (plan_id) args.plan_id = plan_id;
  const up = body(await c.callTool({ name: "request_upgrade", arguments: args }));
  assert.equal(up.ok, true, `request_upgrade failed: ${JSON.stringify(up)}`);
  const ref = new URL(up.checkout_url).searchParams.get("client_reference_id");
  assert.match(String(ref), /^xvr_[0-9a-f]{40}$/);
  return { client: c, pairing_code: up.pairing_code as string, ref: String(ref) };
}

async function subscriptionCount(dataDir: string): Promise<number> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8"));
    return Array.isArray(raw.subscriptions) ? raw.subscriptions.length : 0;
  } catch {
    return 0;
  }
}

async function paidStatus(client: Client, pairing_code: string) {
  return body(await client.callTool({ name: "get_subscription", arguments: { pairing_code } }));
}



describe("webhook price table control", { concurrency: 1 }, () => {

test("compliant checkout against the price table issues a key and logs acceptance", async () => {
  const { srv, hook, logs, dataDir } = await setup("ok", FIXTURE_TABLE);
  const clients: Client[] = [];
  try {
    const up = await upgrade(srv.url);
    clients.push(up.client);
    const e = evt("checkout.session.completed", paidSession(up.ref));
    const r = await post(hook, e);
    assert.equal(r.status, 200);
    assert.notEqual(r.json.rejected, true);
    const sub = await paidStatus(up.client, up.pairing_code);
    assert.equal(sub.status, "active");
    assert.match(String(sub.api_key), /^xvc_/);
    assert.equal(sub.plan_id, "essentiel");
    const accept = logs.find((l) => l.event === e.id && l.price_check === "accepted");
    assert.ok(accept, `expected price_check=accepted in logs, got ${JSON.stringify(logs)}`);
    assert.equal(accept.plan_id, "essentiel");
    assert.ok(logs.every((l) => !JSON.stringify(l).includes(SECRET)));
    assert.equal(await subscriptionCount(dataDir), 1);

    // Event without line_items: no Stripe API call; match metadata + amount_total + currency + livemode.
    const up2 = await upgrade(srv.url);
    clients.push(up2.client);
    const session = paidSession(up2.ref);
    delete (session as { line_items?: unknown }).line_items;
    const e2 = evt("checkout.session.completed", session);
    const r2 = await post(hook, e2);
    assert.equal(r2.status, 200);
    assert.notEqual(r2.json.rejected, true);
    const sub2 = await paidStatus(up2.client, up2.pairing_code);
    assert.match(String(sub2.api_key), /^xvc_/);
    assert.ok(logs.some((l) => l.event === e2.id && l.price_check === "accepted"));
  } finally {
    for (const c of clients) await c.close();
    await srv.close();
  }
});

test("unknown price, wrong amount, wrong currency, unexpected livemode, inconsistent plan: refuse, no key, log the reason", async () => {
  const cases: { name: string; reason: string; plan_id?: string; session?: Parameters<typeof paidSession>[1]; livemode?: boolean }[] = [
    { name: "unknown price", reason: "unknown_price", session: { price_id: "price_EXAMPLE_unknown", lookup_key: "exemple_inconnu", amount: 2900, currency: "eur" } },
    { name: "wrong amount", reason: "amount_mismatch", session: { amount: 9999 } },
    { name: "wrong currency", reason: "currency_mismatch", session: { currency: "usd" } },
    { name: "unexpected livemode", reason: "livemode_mismatch", livemode: true },
    { name: "inconsistent plan", reason: "plan_mismatch", plan_id: "cabinet" },
    {
      name: "ambiguous line items",
      reason: "ambiguous_line_items",
      session: {
        line_items: { object: "list", data: [line(PRICE_ESSENTIEL, 2900, "eur", LOOKUP_ESSENTIEL), line(PRICE_CABINET, 5900, "eur", LOOKUP_CABINET)] },
        amount: 8800,
      },
    },
  ];
  for (const c of cases) {
    const { srv, hook, logs, dataDir } = await setup(`refuse-${c.reason}`, FIXTURE_TABLE);
    const clients: Client[] = [];
    try {
      const up = await upgrade(srv.url, c.plan_id);
      clients.push(up.client);
      const e = evt("checkout.session.completed", paidSession(up.ref, { ...c.session, subscription: `sub_${c.reason}` }), { livemode: c.livemode });
      const r = await post(hook, e);
      assert.equal(r.status, 200, `${c.name}: HTTP`);
      assert.equal(r.json.rejected, true, `${c.name}: rejected flag, body=${JSON.stringify(r.json)}`);
      assert.equal(r.json.reason, c.reason, `${c.name}: reason`);
      const sub = await paidStatus(up.client, up.pairing_code);
      assert.equal(sub.code, "NOT_PAID_YET", `${c.name}: no key issued, got ${JSON.stringify(sub)}`);
      assert.equal(await subscriptionCount(dataDir), 0, `${c.name}: no subscription`);
      const lineLog = logs.find((l) => l.event === e.id);
      assert.ok(lineLog, `${c.name}: a log line for the event`);
      assert.equal(lineLog.price_check, "rejected", `${c.name}: log price_check`);
      assert.equal(lineLog.reason, c.reason, `${c.name}: log reason`);
      const dumped = JSON.stringify(logs);
      assert.ok(!dumped.includes(SECRET), `${c.name}: no webhook secret in logs`);
      assert.ok(!dumped.includes("@"), `${c.name}: no email-like PII in logs`);
    } finally {
      for (const cl of clients) await cl.close();
      await srv.close();
    }
  }
});

test("missing or empty price table: refuse the checkout, no key, log the reason", async () => {
  const runs: { name: string; table: typeof FIXTURE_TABLE | null; emptyFile?: boolean; reason: string }[] = [
    { name: "table absent", table: null, reason: "price_table_missing" },
    { name: "table empty", table: { livemode: false, entries: [] }, reason: "price_table_empty" },
  ];
  for (const run of runs) {
    const { srv, hook, logs, dataDir } = await setup(`table-${run.reason}`, run.table);
    const clients: Client[] = [];
    try {
      const up = await upgrade(srv.url);
      clients.push(up.client);
      const e = evt("checkout.session.completed", paidSession(up.ref));
      const r = await post(hook, e);
      assert.equal(r.status, 200, `${run.name}: HTTP`);
      assert.equal(r.json.rejected, true, `${run.name}: rejected`);
      assert.equal(r.json.reason, run.reason, `${run.name}: reason`);
      const sub = await paidStatus(up.client, up.pairing_code);
      assert.equal(sub.code, "NOT_PAID_YET", `${run.name}: no key`);
      assert.equal(await subscriptionCount(dataDir), 0, `${run.name}: no subscription`);
      const lineLog = logs.find((l) => l.event === e.id);
      assert.ok(lineLog, `${run.name}: log line`);
      assert.equal(lineLog.price_check, "rejected", `${run.name}: log price_check`);
      assert.equal(lineLog.reason, run.reason, `${run.name}: log reason`);
    } finally {
      for (const cl of clients) await cl.close();
      await srv.close();
    }
  }
});
});
