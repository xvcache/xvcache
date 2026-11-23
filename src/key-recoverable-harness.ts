/**
 * Child process for the A3 crash test: hosted server on 127.0.0.1:0, tmp data dir,
 * qualified TSA resolved through the hosted guard with fake credentials and a closed
 * local TSA URL (127.0.0.1:9), OTS off, network trapped (any fetch is refused and
 * recorded in <A3_MAIL_LOG>.network), no real Stripe or email. When A3_MAIL_HANG=1 the fake mailer never
 * resolves, so the parent can SIGKILL after the webhook 200 (email not sent).
 * Writes {url,port} as one JSON line on stdout when ready. Never prints an API key.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";
import { paymentLinkBilling } from "./stripe-webhook.js";
import { EXAMPLE_PRICE_TABLE } from "./stripe-price-table.js";
import { KeyDeliveryService, type Mailer, type MailMessage } from "./key-delivery.js";
import { resolveHostedTsaProvider } from "./tsa.js";

const dataDir = process.env.A3_DATA_DIR;
const mailLog = process.env.A3_MAIL_LOG;
const hang = process.env.A3_MAIL_HANG === "1";
const secret = process.env.A3_WEBHOOK_SECRET;
if (!dataDir || !mailLog || !secret) {
  process.stderr.write("key-recoverable-harness: missing A3_DATA_DIR, A3_MAIL_LOG or A3_WEBHOOK_SECRET\n");
  process.exit(2);
}

// No network in this harness: any fetch is refused and recorded for the parent test.
globalThis.fetch = (async (input: unknown) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
  await fs.appendFile(mailLog + ".network", target.replace(/\/\/[^@/]*@/, "//") + "\n", "utf8");
  throw new Error("key-recoverable-harness: network disabled");
}) as typeof fetch;

// Hosted mode refuses XVCACHE_TSA_PROVIDER=off: go through the same guard as xvcache-remote
// with fake credentials. Nothing is certified in A3, and the TSA URL is a closed local port.
const tsa = resolveHostedTsaProvider({
  XVCACHE_TSA_PROVIDER: "qualified",
  XVCACHE_TSA_USER: "a3-fake-tsa-user",
  XVCACHE_TSA_PASSWORD: "A3_FAKE_TSA_PASSWORD",
  XVCACHE_TSA_URL: "http://127.0.0.1:9/tsr",
});
if (!tsa || "error" in tsa) {
  process.stderr.write(`key-recoverable-harness: hosted TSA guard refused the fake qualified config\n`);
  process.exit(2);
}

const mailer: Mailer = {
  async send(m: MailMessage) {
    if (hang) {
      await fs.writeFile(mailLog + ".attempted", "1", "utf8");
      await new Promise(() => { /* never resolves; the parent SIGKILLs */ });
    }
    await fs.appendFile(mailLog, JSON.stringify({ to: m.to, subject: m.subject, text: m.text, html: m.html }) + "\n", "utf8");
    return { message_id: "<a3-test>" };
  },
};

const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"), undefined, { keyDeliveryTtlMs: 24 * 3600e3 });
const witness = new HostedWitness({ dataDir, tsa, ots: { enabled: false, calendars: [] }, batchWindowMs: 20, onAlert: () => {} });
const keyDelivery = new KeyDeliveryService({
  store,
  mailer,
  publicBaseUrl: () => "",
  retryDelaysMs: [0],
  log: (l) => process.stderr.write(`xvcache-key-delivery ${JSON.stringify(l)}\n`),
});
const srv = await startRemoteServer({
  store,
  witness,
  dataDir,
  port: 0,
  host: "127.0.0.1",
  billing: paymentLinkBilling("https://buy.stripe.com/test_xxxxxxxx"),
  stripeWebhookSecret: secret,
  billingTestMode: true,
  billingLog: () => {},
  keyDelivery,
  stripePriceTable: EXAMPLE_PRICE_TABLE,
});
if (!hang) await keyDelivery.idle();
const base = srv.url.replace(/\/mcp$/, "");
process.stdout.write(JSON.stringify({ url: srv.url, port: srv.port, base }) + "\n");
