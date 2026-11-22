#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { loadLocalEnv } from "./env.js";
import { resolveTsaProvider } from "./tsa.js";
import { DEFAULT_CALENDARS } from "./ots.js";
import { SubscriptionStore } from "./subscriptions.js";
import { HostedWitness } from "./witness.js";
import { startRemoteServer } from "./remote.js";
import { paymentLinkBilling, isTestPaymentLink } from "./stripe-webhook.js";

/**
 * Hosted XVcache MCP server (Streamable HTTP, hash-only). Local use only for now (L3):
 * no deployment, no domain (L5/L7), no billing (L4: request_upgrade answers BILLING_UNAVAILABLE).
 * Env: XVCACHE_REMOTE_HOST (127.0.0.1), XVCACHE_REMOTE_PORT (0 = free port), XVCACHE_REMOTE_DATA
 * (~/.xvcache-remote), XVCACHE_PUBLIC_URL, XVCACHE_BATCH_WINDOW_MS (2000), XVCACHE_RETRY_MS (300000),
 * XVCACHE_OTS (on/off), TSA settings as for the local server (XVCACHE_TSA_*; FreeTSA = test by default).
 * L4 billing: XVCACHE_STRIPE_PAYMENT_LINK_URL + STRIPE_WEBHOOK_SECRET (both needed; webhook on POST /stripe/webhook).
 * Operator: `xvcache-remote --create-key [quota]` prints a test API key once.
 */
loadLocalEnv();
const env = process.env;
const dataDir = path.resolve(env.XVCACHE_REMOTE_DATA || path.join(os.homedir(), ".xvcache-remote"));
const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"));

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
const otsOff = (env.XVCACHE_OTS || "").toLowerCase();
const witness = new HostedWitness({
  dataDir,
  tsa,
  ots: { enabled: !(otsOff === "off" || otsOff === "0" || otsOff === "false"), calendars: DEFAULT_CALENDARS },
  batchWindowMs: Number(env.XVCACHE_BATCH_WINDOW_MS || 2000),
  retryIntervalMs: Number(env.XVCACHE_RETRY_MS || 300000),
});
const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
const linkUrl = env.XVCACHE_STRIPE_PAYMENT_LINK_URL?.trim() || undefined;
const billing = webhookSecret ? paymentLinkBilling(linkUrl) : undefined;
const srv = await startRemoteServer({
  store,
  witness,
  dataDir,
  billing,
  stripeWebhookSecret: webhookSecret,
  billingTestMode: isTestPaymentLink(linkUrl),
  host: env.XVCACHE_REMOTE_HOST || "127.0.0.1",
  port: Number(env.XVCACHE_REMOTE_PORT || 0),
  publicBaseUrl: env.XVCACHE_PUBLIC_URL || undefined,
});
process.stderr.write(`xvcache-remote listening on ${srv.url} (TSA: ${tsa ? `${tsa.id}${tsa.qualified ? ", qualified" : ", NOT qualified"}` : "off"}; billing: ${billing ? (isTestPaymentLink(linkUrl) ? "Stripe TEST" : "Stripe LIVE") : "off"}; webhook: ${webhookSecret ? "on" : "off"})\n`);
const stop = () => { void srv.close().then(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
