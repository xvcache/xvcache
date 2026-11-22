import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubscriptionStore, hashSecret } from "./subscriptions.js";

async function tmpStore(now?: () => Date): Promise<{ store: SubscriptionStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-subs-"));
  return { store: new SubscriptionStore(path.join(dir, "subscriptions.json"), now), dir };
}

test("API keys are stored hashed; authenticate by key; unknown key → null", async () => {
  const { store, dir } = await tmpStore();
  const { api_key } = await store.createApiKey({ plan_id: "coffre-horodate", quota: 5, status: "active", default_lang: "de" });
  assert.match(api_key, /^xvc_[A-Za-z0-9_-]{40,}$/);
  const raw = await fs.readFile(path.join(dir, "subscriptions.json"), "utf8");
  assert.ok(!raw.includes(api_key), "plain key must never be stored");
  assert.ok(raw.includes(hashSecret(api_key)));
  const rec = await store.authenticate(api_key);
  assert.equal(rec?.status, "active");
  assert.equal(rec?.default_lang, "de");
  assert.equal(await store.authenticate("xvc_nope"), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("quota: consume until QUOTA_EXCEEDED with next_reset; resets next month; usage reports", async () => {
  let now = new Date("2026-11-22T10:00:00Z");
  const { store, dir } = await tmpStore(() => now);
  const { api_key } = await store.createApiKey({ plan_id: "coffre-horodate", quota: 3, status: "active" });
  const rec = (await store.authenticate(api_key))!;
  assert.deepEqual(await store.consume(rec.key_hash, 2), { ok: true, used: 2, quota: 3 });
  const over = await store.consume(rec.key_hash, 2);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.next_reset, "2026-12-01T00:00:00.000Z");
  const u = await store.usage(rec.key_hash);
  assert.equal(u.certifications_this_period, 2);
  assert.equal(u.quota, 3);
  assert.equal(u.next_reset, "2026-12-01T00:00:00.000Z");
  now = new Date("2026-12-02T08:00:00Z");
  assert.deepEqual(await store.consume(rec.key_hash, 3), { ok: true, used: 3, quota: 3 });
  await fs.rm(dir, { recursive: true, force: true });
});

test("pairing: pending → activation (L4 webhook stand-in) → api_key returned exactly once; expiry", async () => {
  let now = new Date("2026-11-22T10:00:00Z");
  const { store, dir } = await tmpStore(() => now);
  const p = await store.createPairing({ plan_id: "coffre-horodate", lang: "fr", consent: { quote: "Oui", at: now.toISOString() } });
  assert.match(p.pairing_code, /^xvp_[A-Za-z0-9_-]{20,}$/);
  const pending = await store.getSubscription({ pairing_code: p.pairing_code });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.code, "NOT_PAID_YET");
  await store.activatePairing(p.pairing_code, { status: "trialing", quota: 10 });
  const first = await store.getSubscription({ pairing_code: p.pairing_code });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.status, "trialing");
    assert.match(String(first.api_key), /^xvc_/);
    const again = await store.getSubscription({ pairing_code: p.pairing_code });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.api_key, null, "api_key is returned only once");
    const byKey = await store.getSubscription({ api_key: String(first.api_key) });
    assert.equal(byKey.ok, true);
  }
  const raw = await fs.readFile(path.join(dir, "subscriptions.json"), "utf8");
  assert.ok(!raw.includes(p.pairing_code), "pairing code stored hashed");
  const p2 = await store.createPairing({ plan_id: "coffre-horodate", lang: "en", consent: { quote: "yes", at: now.toISOString() } });
  now = new Date("2026-11-24T10:00:00Z");
  const expired = await store.getSubscription({ pairing_code: p2.pairing_code });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, "PAIRING_EXPIRED");
  await fs.rm(dir, { recursive: true, force: true });
});
