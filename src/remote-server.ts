#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { loadLocalEnv } from "./env.js";
import { resolveTsaProvider } from "./tsa.js";
import { DEFAULT_CALENDARS } from "./ots.js";
import { SubscriptionStore, KEY_DELIVERY_TTL_MS } from "./subscriptions.js";
import { HostedWitness, DEFAULT_DAILY_ANCHOR_UTC, type AnchorMode } from "./witness.js";
import { TsaTokenLedger, DEFAULT_TOKEN_ALERT_BELOW } from "./tsa-tokens.js";
import { KeyDeliveryService, cloudflareMailer } from "./key-delivery.js";
import { startRemoteServer } from "./remote.js";
import { paymentLinkBilling, isTestPaymentLink } from "./stripe-webhook.js";

/**
 * Hosted XVcache MCP server (Streamable HTTP, hash-only). Local use only for now (L3):
 * no deployment, no domain (L5/L7), no billing (L4: request_upgrade answers BILLING_UNAVAILABLE).
 * Env: XVCACHE_REMOTE_HOST (127.0.0.1), XVCACHE_REMOTE_PORT (0 = free port), XVCACHE_REMOTE_DATA
 * (~/.xvcache-remote), XVCACHE_PUBLIC_URL, XVCACHE_BATCH_WINDOW_MS (2000), XVCACHE_RETRY_MS (300000),
 * XVCACHE_OTS (on/off), TSA settings as for the local server (XVCACHE_TSA_*; FreeTSA = test by default).
 * L4 billing: XVCACHE_STRIPE_PAYMENT_LINK_URL + STRIPE_WEBHOOK_SECRET (both needed; webhook on POST /stripe/webhook).
 * 0.3.0 anchoring: XVCACHE_ANCHOR_MODE (daily | window; default daily = ONE shared Merkle root stamped per day),
 *   XVCACHE_DAILY_ANCHOR_UTC (HH:MM UTC, default 21:50 = 22:50 Paris in winter / 23:50 in summer, always the same Paris day;
 *   avoid values after 21:59 UTC, which cross midnight in Paris in summer).
 * 0.3.0 token stock: XVCACHE_TSA_TOKEN_STOCK (tokens left on the provider account, seeds the local ledger once),
 *   XVCACHE_TSA_TOKEN_ALERT_BELOW (default 20). `xvcache-remote --tsa-stock <n>` resets the stock; `--tsa-tokens` shows it.
 * 0.3.0 key email (OFF by default): XVCACHE_KEY_EMAIL=on, XVCACHE_PUBLIC_URL (https), XVCACHE_EMAIL_FROM (address on a
 *   domain onboarded to Cloudflare Email Sending), XVCACHE_EMAIL_FROM_NAME, XVCACHE_EMAIL_REPLY_TO, CLOUDFLARE_ACCOUNT_ID,
 *   CLOUDFLARE_EMAIL_API_TOKEN ("Email Sending: Edit"), XVCACHE_KEY_LINK_TTL_HOURS (default 24).
 * Operator: `xvcache-remote --create-key [quota]` prints a test API key once.
 */
loadLocalEnv();
const env = process.env;
const dataDir = path.resolve(env.XVCACHE_REMOTE_DATA || path.join(os.homedir(), ".xvcache-remote"));
const operatorAlert = (m: string) => process.stderr.write(`[xvcache][operator-alert] ${new Date().toISOString()} ${m}\n`);

const emailOn = /^(on|1|true|yes)$/i.test(env.XVCACHE_KEY_EMAIL || "");
const ttlHours = Number(env.XVCACHE_KEY_LINK_TTL_HOURS || 24);
const linkTtlMs = Number.isFinite(ttlHours) && ttlHours > 0 && ttlHours <= 72 ? ttlHours * 3600e3 : KEY_DELIVERY_TTL_MS;
const emailMissing = emailOn ? (["XVCACHE_PUBLIC_URL", "XVCACHE_EMAIL_FROM", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_EMAIL_API_TOKEN"] as const).filter((k) => !env[k]?.trim()) : [];
if (emailOn && env.XVCACHE_PUBLIC_URL && !/^https:\/\//.test(env.XVCACHE_PUBLIC_URL)) emailMissing.push("XVCACHE_PUBLIC_URL" as never);
const keyEmail = emailOn && !emailMissing.length;
if (emailOn && !keyEmail) operatorAlert(`key email requested but disabled: missing or invalid ${emailMissing.join(", ")}`);

const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"), undefined, keyEmail ? { keyDeliveryTtlMs: linkTtlMs } : {});

if (process.argv[2] === "--create-key") {
  const quota = process.argv[3] ? Number(process.argv[3]) : null;
  const { api_key } = await store.createApiKey({ plan_id: "coffre-horodate", quota: Number.isFinite(quota) ? quota : null, status: "active" });
  process.stdout.write(api_key + "\n");
  process.exit(0);
}

const tsa = resolveTsaProvider(env);
if (tsa && "error" in tsa) {
  process.stderr.write(`xvcache-remote: ${tsa.error}\n`);
  process.exit(1);
}
const stockEnv = env.XVCACHE_TSA_TOKEN_STOCK?.trim() ? Number(env.XVCACHE_TSA_TOKEN_STOCK) : null;
const alertBelow = env.XVCACHE_TSA_TOKEN_ALERT_BELOW?.trim() ? Number(env.XVCACHE_TSA_TOKEN_ALERT_BELOW) : DEFAULT_TOKEN_ALERT_BELOW;
const ledger = tsa ? new TsaTokenLedger(path.join(dataDir, "hosted", "tsa-tokens.json"), {
  provider: tsa.id, alertBelow, initialStock: Number.isInteger(stockEnv) ? stockEnv : null, onAlert: operatorAlert,
}) : undefined;

if (process.argv[2] === "--tsa-stock" || process.argv[2] === "--tsa-tokens") {
  if (!ledger) { process.stderr.write("xvcache-remote: no TSA configured\n"); process.exit(1); }
  const v = process.argv[2] === "--tsa-stock" ? await ledger.setStock(Number(process.argv[3])) : await ledger.status();
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  process.exit(0);
}
const anchorMode: AnchorMode = (env.XVCACHE_ANCHOR_MODE || "daily").toLowerCase() === "window" ? "window" : "daily";
const otsOff = (env.XVCACHE_OTS || "").toLowerCase();
const witness = new HostedWitness({
  dataDir,
  tsa,
  ots: { enabled: !(otsOff === "off" || otsOff === "0" || otsOff === "false"), calendars: DEFAULT_CALENDARS },
  batchWindowMs: Number(env.XVCACHE_BATCH_WINDOW_MS || 2000),
  retryIntervalMs: Number(env.XVCACHE_RETRY_MS || 300000),
  anchorMode,
  dailyAnchorUtc: env.XVCACHE_DAILY_ANCHOR_UTC || DEFAULT_DAILY_ANCHOR_UTC,
  tokenLedger: ledger,
});
let publicBase = env.XVCACHE_PUBLIC_URL || "";
const keyDelivery = keyEmail ? new KeyDeliveryService({
  store,
  mailer: cloudflareMailer({
    accountId: env.CLOUDFLARE_ACCOUNT_ID!.trim(),
    apiToken: env.CLOUDFLARE_EMAIL_API_TOKEN!.trim(),
    from: env.XVCACHE_EMAIL_FROM!.trim(),
    fromName: env.XVCACHE_EMAIL_FROM_NAME?.trim() || "XVcache",
    replyTo: env.XVCACHE_EMAIL_REPLY_TO?.trim() || undefined,
  }),
  publicBaseUrl: () => publicBase,
}) : undefined;
const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
const linkUrl = env.XVCACHE_STRIPE_PAYMENT_LINK_URL?.trim() || undefined;
const salesOpen = env.XVCACHE_SALES_OPEN === "1";
const allowTestCheckout = env.XVCACHE_STRIPE_ALLOW_TEST_CHECKOUT === "1";
const testLink = isTestPaymentLink(linkUrl);
// Until sales open, request_upgrade must return BILLING_UNAVAILABLE with no payment link.
// A Stripe TEST link is never served in production unless XVCACHE_STRIPE_ALLOW_TEST_CHECKOUT=1 (local tests only).
const billing = (webhookSecret && salesOpen && linkUrl && (!testLink || allowTestCheckout)) ? paymentLinkBilling(linkUrl) : undefined;
const srv = await startRemoteServer({
  store,
  witness,
  dataDir,
  billing,
  stripeWebhookSecret: webhookSecret,
  billingTestMode: Boolean(billing) && testLink && allowTestCheckout,
  host: env.XVCACHE_REMOTE_HOST || "127.0.0.1",
  port: Number(env.XVCACHE_REMOTE_PORT || 0),
  publicBaseUrl: env.XVCACHE_PUBLIC_URL || undefined,
  keyDelivery,
});
publicBase ||= srv.url.replace(/\/mcp$/, "");
process.stderr.write(`xvcache-remote listening on ${srv.url} (TSA: ${tsa ? `${tsa.id}${tsa.qualified ? ", qualified" : ", NOT qualified"}` : "off"}; billing: ${billing ? (isTestPaymentLink(linkUrl) ? "Stripe TEST" : "Stripe LIVE") : "off"}; webhook: ${webhookSecret ? "on" : "off"}; anchor: ${anchorMode === "daily" ? `daily ${env.XVCACHE_DAILY_ANCHOR_UTC || DEFAULT_DAILY_ANCHOR_UTC} UTC` : "window"}; key email: ${keyEmail ? "on" : "off"})\n`);
if (ledger) void ledger.status().then((v) => process.stderr.write(`xvcache-remote: TSA tokens consumed ${v.consumed_total}; remaining ${v.remaining ?? "unknown (set XVCACHE_TSA_TOKEN_STOCK)"}; alert below ${v.alert_below}\n`));
const stop = () => { void srv.close().then(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
