/**
 * A3: if the process dies just after the webhook answers Stripe with 200, the
 * API key must still be recoverable after a restart on the same data directory
 * (pairing / get_subscription, and the one-time email link). A Stripe retry of
 * the same event must not mint a second key or a second subscription.
 *
 * Isolation: 127.0.0.1, port 0, tmp dir, fake qualified TSA (closed local URL,
 * never called), OTS off, fetch trapped in the harness, no Stripe API, no real
 * email (fake mailer), signed webhook payloads only. Never logs a raw API key.
 *
 * These tests use only APIs present on 5364b2f. They must compile and fail
 * their assertions on that commit, then pass after the fix.
 *
 * Replay on 5364b2f (product only, keep this test and the harness):
 *
 *   cd /workspace/xvcache-wt-a3
 *   git checkout 5364b2f3e7c12e9b25622c362d303a4262f244b0 -- \
 *     src/subscriptions.ts src/key-delivery.ts src/remote.ts src/remote-server.ts
 *   npm run build && node --test dist/key-recoverable.test.js
 *   git checkout fix/a3-cle-recuperable -- \
 *     src/subscriptions.ts src/key-delivery.ts src/remote.ts src/remote-server.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkoutRef, hashSecret } from "./subscriptions.js";
import { signStripePayload, STRIPE_WEBHOOK_PATH } from "./stripe-webhook.js";
import { exampleCheckoutPayment } from "./stripe-price-table.js";

const SECRET = "whsec_test_only_not_a_real_secret";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(ROOT, "dist", "key-recoverable-harness.js");

type ToolOut = { isError?: boolean; content: { type: string; text?: string }[] };
const body = (r: unknown): Record<string, any> => JSON.parse((r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}");
const keyHash = (k: string) => createHash("sha256").update(k, "utf8").digest("hex");
const hint = (k: string) => k.slice(-4);

let tmp = "";
before(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-a3-")); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

type Ready = { url: string; port: number; base: string };

async function startHarness(dataDir: string, mailLog: string, hang: boolean): Promise<{ child: ChildProcess; ready: Ready }> {
  await fs.mkdir(dataDir, { recursive: true });
  const child = spawn(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      A3_DATA_DIR: dataDir,
      A3_MAIL_LOG: mailLog,
      A3_MAIL_HANG: hang ? "1" : "",
      A3_WEBHOOK_SECRET: SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => { stderr += c; });
  const ready = await new Promise<Ready>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`harness ready timeout\n${stderr}`)), 15_000);
    child.stdout.on("data", (c: string) => {
      stdout += c;
      const line = stdout.split("\n").find((l) => l.startsWith("{"));
      if (!line) return;
      try {
        const j = JSON.parse(line) as Ready;
        if (j.url && j.port) { clearTimeout(t); resolve(j); }
      } catch { /* incomplete line */ }
    });
    child.on("exit", (code, sig) => {
      clearTimeout(t);
      reject(new Error(`harness exited ${code}/${sig} before ready\n${stderr}`));
    });
  });
  return { child, ready };
}

function killHard(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) { resolve(); return; }
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
    setTimeout(() => resolve(), 2000);
  });
}

let seq = 0;
function paidEvent(o: { ref?: string | null; email?: string; locale?: string; customer?: string; subscription?: string; session?: string }) {
  return {
    id: `evt_a3_${++seq}`,
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: o.session ?? `cs_a3_${seq}`,
        client_reference_id: o.ref ?? undefined,
        customer: o.customer ?? `cus_a3_${seq}`,
        subscription: o.subscription ?? `sub_a3_${seq}`,
        payment_status: "paid",
        customer_details: o.email ? { email: o.email } : undefined,
        locale: o.locale ?? "fr",
        ...exampleCheckoutPayment(),
      },
    },
  };
}

async function postHook(base: string, ev: unknown) {
  const raw = JSON.stringify(ev);
  const r = await fetch(`${base}${STRIPE_WEBHOOK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signStripePayload(raw, SECRET) },
    body: raw,
  });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

async function connect(url: string): Promise<Client> {
  const ai = new Client({ name: "a3", version: "0" });
  await ai.connect(new StreamableHTTPClientTransport(new URL(url)));
  return ai;
}

function readMails(mailLog: string): Promise<{ to: string; subject: string; text: string; html: string }[]> {
  return fs.readFile(mailLog, "utf8").catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }).then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

function linkFrom(mail: { text: string }): string {
  const line = mail.text.split("\n").find((l) => l.includes("/key/"));
  assert.ok(line, "mail should contain a /key/ link");
  return line!;
}

async function assertNoNetwork(mailLog: string): Promise<void> {
  const calls = await fs.readFile(mailLog + ".network", "utf8").catch(() => "");
  assert.equal(calls, "", `the harness must not make any network call, got:\n${calls}`);
}

async function reveal(link: string): Promise<string> {
  const html = await (await fetch(link, { method: "POST" })).text();
  const m = /<code>(xvc_[A-Za-z0-9_-]+)<\/code>/.exec(html);
  assert.ok(m, "POST should reveal a key in <code>");
  return m![1];
}

test("crash after Stripe 200: pairing still yields the same key after restart; email link is resent; replay mints nothing", async () => {
  const dataDir = path.join(tmp, "pairing");
  const mailLog = path.join(tmp, "pairing-mail.log");
  const first = await startHarness(dataDir, mailLog, true);
  let pairing = "";
  let ev: ReturnType<typeof paidEvent>;
  try {
    const ai = await connect(first.ready.url);
    const up = body(await ai.callTool({ name: "request_upgrade", arguments: { lang: "fr", human_confirmed: true, consent_quote: "oui" } }));
    pairing = up.pairing_code;
    ev = paidEvent({ ref: checkoutRef(pairing), email: "a3-pairing@example.test", customer: "cus_a3_p", subscription: "sub_a3_p", session: "cs_a3_p" });
    const r = await postHook(first.ready.base, ev);
    assert.equal(r.status, 200, "webhook should accept the paid checkout");
    assert.equal(r.json.ok, true);
    assert.equal(r.json.duplicate, false);
    await ai.close();
  } finally {
    await killHard(first.child);
  }
  assert.equal((await readMails(mailLog)).length, 0, "hanging mailer + SIGKILL: no email sent before the crash");

  const second = await startHarness(dataDir, mailLog, false);
  try {
    const mails = await readMails(mailLog);
    assert.equal(mails.length, 1, "after restart the unsent link email must be resumed");
    const link = linkFrom(mails[0]);

    const ai = await connect(second.ready.url);
    const sub = body(await ai.callTool({ name: "get_subscription", arguments: { pairing_code: pairing } }));
    assert.equal(typeof sub.api_key, "string");
    assert.match(sub.api_key, /^xvc_/);
    const fromPairing = sub.api_key as string;
    const fromLink = await reveal(link);
    assert.equal(keyHash(fromLink), keyHash(fromPairing), `pairing and email link must yield the same key (hints ${hint(fromPairing)} / ${hint(fromLink)})`);

    const retry = await postHook(second.ready.base, ev);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicate, true, "Stripe replay of the same event is a duplicate");
    assert.equal((await readMails(mailLog)).length, 1, "replay must not send a second email");

    const again = body(await ai.callTool({ name: "get_subscription", arguments: { pairing_code: pairing } }));
    assert.equal(again.api_key, null, "key is shown only once via pairing");
    const store = JSON.parse(await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8"));
    assert.equal(store.subscriptions.length, 1, "no second subscription");
    assert.equal(store.subscriptions[0].key_hash, hashSecret(fromPairing));
    const wrap = await fs.readFile(path.join(dataDir, "delivery-wrap.key")).catch(() => null);
    assert.ok(wrap && wrap.length === 32, "delivery wrap key is persisted beside the store");
    const raw = await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8");
    assert.ok(!raw.includes(fromPairing), "API key is not stored in clear after it was claimed");
    await ai.close();
  } finally {
    await killHard(second.child);
  }
  await assertNoNetwork(mailLog);
});

test("crash after Stripe 200 without pairing (website): the same key is recoverable from the resumed email link; replay mints nothing", async () => {
  const dataDir = path.join(tmp, "website");
  const mailLog = path.join(tmp, "website-mail.log");
  const ev = paidEvent({ email: "a3-site@example.test", locale: "en", customer: "cus_a3_w", subscription: "sub_a3_w", session: "cs_a3_w" });
  const first = await startHarness(dataDir, mailLog, true);
  try {
    const r = await postHook(first.ready.base, ev);
    assert.equal(r.status, 200);
    assert.equal(r.json.duplicate, false);
  } finally {
    await killHard(first.child);
  }
  assert.equal((await readMails(mailLog)).length, 0, "no email before the crash");

  const second = await startHarness(dataDir, mailLog, false);
  try {
    const mails = await readMails(mailLog);
    assert.equal(mails.length, 1, "website checkout must resume the one-time link after restart");
    const key = await reveal(linkFrom(mails[0]));
    const retry = await postHook(second.ready.base, ev);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.duplicate, true);
    assert.equal((await readMails(mailLog)).length, 1);
    const store = JSON.parse(await fs.readFile(path.join(dataDir, "subscriptions.json"), "utf8"));
    assert.equal(store.subscriptions.length, 1);
    assert.equal(store.subscriptions[0].key_hash, hashSecret(key));
    const c = await connect(second.ready.url);
    // authenticate with the recovered key (header only; do not log it)
    await c.close();
    const authed = new Client({ name: "a3-auth", version: "0" });
    await authed.connect(new StreamableHTTPClientTransport(new URL(second.ready.url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    const usage = body(await authed.callTool({ name: "get_usage", arguments: {} }));
    assert.equal(usage.status, "active");
    await authed.close();
  } finally {
    await killHard(second.child);
  }
  await assertNoNetwork(mailLog);
});
