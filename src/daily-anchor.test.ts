import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";
import { CERTIGNA_QUALIFIED_POLICY_OID, type TsaProvider, type FetchLike } from "./tsa.js";
import { HostedWitness, nextDailyAnchor, DEFAULT_DAILY_ANCHOR_UTC } from "./witness.js";
import { TsaTokenLedger } from "./tsa-tokens.js";
import { SubscriptionStore } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";

let fake: FakeTsa;
let tmp: string;
before(async () => { fake = await startFakeTsa({ policy: CERTIGNA_QUALIFIED_POLICY_OID }); tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-daily-")); });
after(async () => { await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const certignaLike = (): TsaProvider => ({ id: "certigna", label: "Certigna (simulated in tests)", url: fake.url, qualified: true, qualifiedBasis: "test", caFile: fake.caFile,
  // Test-only trust anchor standing in for the bundled Certigna chain (the token must still prove it).
  qualifiedTrust: { name: "Certigna (simulated)", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: fake.caFile } });
type ToolOut = { isError?: boolean; content: { type: string; text?: string }[] };
const body = (r: unknown): Record<string, any> => JSON.parse((r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}");

test("nextDailyAnchor: same day if still ahead, else next day (UTC)", () => {
  assert.equal(nextDailyAnchor(new Date("2026-11-23T06:00:00Z"), "22:50").toISOString(), "2026-11-23T22:50:00.000Z");
  assert.equal(nextDailyAnchor(new Date("2026-11-23T22:50:00Z"), "22:50").toISOString(), "2026-11-24T22:50:00.000Z");
  assert.equal(nextDailyAnchor(new Date("2026-12-31T23:00:00Z"), "22:50").toISOString(), "2027-01-01T22:50:00.000Z");
  assert.equal(nextDailyAnchor(new Date("2026-11-23T06:00:00Z"), "nonsense").toISOString(), "2026-11-23T21:50:00.000Z", "invalid → default");
});

test("daily mode: 3 firms all day → answered at once as pending, ONE token at the daily anchor, every proof V; empty day = no token", async () => {
  const ledger = new TsaTokenLedger(path.join(tmp, "d1", "hosted", "tsa-tokens.json"), { provider: "certigna", initialStock: 97, onAlert: () => {} });
  const counted: [string, number][] = [];
  const w = new HostedWitness({ dataDir: path.join(tmp, "d1"), tsa: certignaLike(), ots: { enabled: false, calendars: [] }, anchorMode: "daily", autoAnchor: false, tokenLedger: ledger, onTimestamped: (o, n) => { counted.push([o, n]); }, onAlert: () => {} });
  const before = fake.requests;
  const morning = await w.submit([{ sha256: sha("m1"), label: "M1", owner: "firm-a" }, { sha256: sha("m2"), label: "M2", owner: "firm-a" }]);
  const noon = await w.submit([{ sha256: sha("n1"), label: "N1", owner: "firm-b" }]);
  const evening = await w.submit([{ sha256: sha("e1"), label: "E1", owner: "firm-c" }]);
  assert.equal(fake.requests - before, 0, "no token during the day");
  for (const p of [...morning, ...noon, ...evening]) {
    assert.equal(p.status, "pending_qualified");
    assert.equal(p.qualified, false);
    assert.equal(p.merkle, null);
    assert.ok(p.anchor_due_at && Date.parse(p.anchor_due_at) > Date.now());
    const v = await w.verify({ sha256: p.sha256, proof_id: p.proof_id });
    assert.equal(v.verdict, "pending");
    const x = await w.verify({ sha256: sha("other"), proof_id: p.proof_id });
    assert.equal(x.verdict, "X", "a different fingerprint is X even before the anchor");
    const pdf = await w.certificatePdf({ proof_id: p.proof_id, lang: "fr" });
    assert.ok(pdf && pdf.qualified === false && pdf.lines.join(" ").includes("NON QUALIFIÉ"));
  }
  assert.equal(await w.queueSize(), 4);
  assert.deepEqual(counted, [], "pending proofs are never counted");

  assert.equal(await w.anchorNow(), 4);
  assert.equal(fake.requests - before, 1, "exactly ONE token for all subscribers of the day");
  const roots = new Set<string>();
  for (const p of [...morning, ...noon, ...evening]) {
    const a = (await w.getProof(p.proof_id))!;
    assert.equal(a.status, "qualified");
    assert.equal(a.qualified, true);
    assert.equal(a.merkle!.leaf_count, 4);
    roots.add(a.merkle!.root);
    const v = await w.verify({ sha256: p.sha256, proof_id: p.proof_id });
    assert.equal(v.verdict, "V", JSON.stringify(v.checks));
  }
  assert.equal(roots.size, 1, "one shared root");
  assert.deepEqual(counted.sort(), [["firm-a", 2], ["firm-b", 1], ["firm-c", 1]], "counted once the token is issued");
  const led = await ledger.status();
  assert.equal(led.consumed_total, 1);
  assert.equal(led.remaining, 96);
  assert.equal(await w.queueSize(), 0);
  assert.equal(await w.anchorNow(), 0, "empty queue: nothing stamped");
  assert.equal(fake.requests - before, 1, "no token for an empty day");
  w.close();
});

test("daily mode, Certigna down at anchor time (402) → stays pending_qualified, not counted, no other TSA; requalified (and counted) later", async () => {
  let down = true;
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    if (down) return { ok: false, status: 402, arrayBuffer: async () => new ArrayBuffer(0) };
    return (fetch as unknown as FetchLike)(url, init);
  };
  const alerts: string[] = [];
  const ledger = new TsaTokenLedger(path.join(tmp, "d2", "ledger.json"), { provider: "certigna", onAlert: (m) => alerts.push(m) });
  const counted: [string, number][] = [];
  const w = new HostedWitness({ dataDir: path.join(tmp, "d2"), tsa: certignaLike(), ots: { enabled: false, calendars: [] }, anchorMode: "daily", autoAnchor: false, fetchImpl, tokenLedger: ledger, onTimestamped: (o, n) => { counted.push([o, n]); }, onAlert: (m) => alerts.push(m) });
  const [p] = await w.submit([{ sha256: sha("doc"), label: "Doc", owner: "firm-a" }]);
  assert.equal(await w.anchorNow(), 1);
  const after1 = (await w.getProof(p.proof_id))!;
  assert.equal(after1.status, "pending_qualified");
  assert.ok(after1.merkle, "the Merkle path is fixed even if the token is missing");
  assert.equal(after1.tsa, null);
  assert.ok(urls.every((u) => u === fake.url), "no fallback TSA");
  assert.ok(alerts.some((a) => /402/.test(a)));
  assert.deepEqual(counted, []);
  assert.equal((await ledger.status()).consumed_total, 0, "a refused request is not a consumed token");
  down = false;
  assert.equal(await w.requalifyPending(), 1);
  assert.equal((await w.getProof(p.proof_id))!.status, "qualified");
  assert.deepEqual(counted, [["firm-a", 1]]);
  assert.equal((await ledger.status()).consumed_total, 1);
  w.close();
});

test("token ledger: remaining from the stock, alert in the logs below the threshold (default 20), stock reset by the operator", async () => {
  const alerts: string[] = [];
  const l = new TsaTokenLedger(path.join(tmp, "ledger", "t.json"), { provider: "certigna", initialStock: 22, onAlert: (m) => alerts.push(m) });
  assert.equal((await l.status()).alert_below, 20);
  await l.consumed(); // 21
  await l.consumed(); // 20
  assert.equal(alerts.length, 0, "20 left is not below 20");
  const v = await l.consumed(); // 19
  assert.equal(v.remaining, 19);
  assert.equal(v.low, true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /stock low: about 19 token/);
  const reset = await l.setStock(500);
  assert.equal(reset.remaining, 500);
  assert.equal(reset.consumed_total, 3, "the total is kept");
  await l.consumed();
  assert.equal(alerts.length, 1);
  const custom = new TsaTokenLedger(path.join(tmp, "ledger", "c.json"), { provider: "certigna", initialStock: 6, alertBelow: 5, onAlert: (m) => alerts.push(m) });
  await custom.consumed();
  assert.equal(alerts.length, 1, "5 left, threshold 5: no alert");
  await custom.consumed();
  assert.equal(alerts.length, 2);
  const unknown = new TsaTokenLedger(path.join(tmp, "ledger", "u.json"), { provider: "certigna" });
  const u = await unknown.consumed();
  assert.equal(u.remaining, null);
  assert.equal(u.low, false);
  await assert.rejects(l.setStock(-1));
});

test("hosted server in daily mode: certify answers at once (pending, receipt PDF, due time), unlimited subscription, usage counted only after the anchor", async () => {
  const dataDir = path.join(tmp, "srv");
  const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"));
  const witness = new HostedWitness({ dataDir, tsa: certignaLike(), ots: { enabled: false, calendars: [] }, anchorMode: "daily", autoAnchor: false, onAlert: () => {} });
  const srv = await startRemoteServer({ store, witness, dataDir, port: 0 });
  try {
    const { api_key, key_hash } = await store.createApiKey({ plan_id: "coffre-horodate", quota: null, status: "active" });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${api_key}` } } }));
    const before = fake.requests;
    const r = body(await c.callTool({ name: "certify_hash", arguments: { items: Array.from({ length: 30 }, (_, i) => ({ sha256: sha(`d${i}`) })) } }));
    assert.equal(r.ok, true);
    assert.equal(fake.requests - before, 0);
    assert.equal(r.results.length, 30);
    assert.equal(r.results[0].status, "pending_qualified");
    assert.ok(r.results[0].anchor_due_at);
    assert.match(r.next_action, /daily shared timestamp/);
    assert.match(r.next_action, /NOT QUALIFIED/);
    assert.equal(r.batch_root, null);
    assert.equal(r.usage.quota, null, "unlimited");
    assert.equal((await store.usage(key_hash)).certifications_this_period, 0, "pending proofs are not counted");
    assert.equal(await witness.anchorNow(), 30);
    assert.equal(fake.requests - before, 1);
    assert.equal((await store.usage(key_hash)).certifications_this_period, 30, "counted once timestamped");
    const again = body(await c.callTool({ name: "get_certificate_pdf", arguments: { proof_id: r.results[0].proof_id } }));
    assert.equal(again.qualified, true);
    await c.close();
  } finally { await srv.close(); }
});

test("default daily anchor (21:50 UTC) stays on the same Paris calendar day in winter and in summer", () => {
  assert.equal(DEFAULT_DAILY_ANCHOR_UTC, "21:50");
  const paris = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
  const winter = nextDailyAnchor(new Date("2026-12-15T08:00:00Z"));
  const summer = nextDailyAnchor(new Date("2027-07-15T08:00:00Z"));
  assert.equal(paris(winter), "15/12/2026 22:50");
  assert.equal(paris(summer), "15/07/2027 23:50");
});
