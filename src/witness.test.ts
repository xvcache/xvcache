import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";
import { CERTIGNA_QUALIFIED_POLICY_OID, type TsaProvider, type FetchLike } from "./tsa.js";
import { HostedWitness } from "./witness.js";

let fake: FakeTsa;
let tmp: string;
before(async () => { fake = await startFakeTsa({ policy: CERTIGNA_QUALIFIED_POLICY_OID }); tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-witness-")); });
after(async () => { await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A Certigna-like provider pointed at the local fake TSA: qualified = true, no real Certigna call. */
function certignaLike(): TsaProvider {
  return { id: "certigna", label: "Certigna (simulated in tests)", url: fake.url, qualified: true, qualifiedBasis: "test", caFile: fake.caFile,
    // Test-only trust anchor standing in for the bundled Certigna chain (the token must still prove it).
    qualifiedTrust: { name: "Certigna (simulated)", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: fake.caFile } };
}

test("two firms × 3 fingerprints in the same window → ONE token, 6 individual proofs, each verifiable alone (V)", async () => {
  const w = new HostedWitness({ dataDir: path.join(tmp, "multi"), tsa: certignaLike(), ots: { enabled: false, calendars: [] }, batchWindowMs: 150 });
  const before = fake.requests;
  const a = ["a1", "a2", "a3"].map((s) => ({ sha256: sha(s), label: `A ${s}`, owner: "firm-a" }));
  const b = ["b1", "b2", "b3"].map((s) => ({ sha256: sha(s), label: `B ${s}`, owner: "firm-b" }));
  const [pa, pb] = await Promise.all([w.submit(a), w.submit(b)]);
  assert.equal(fake.requests - before, 1, "exactly one timestamp for both firms");
  const all = [...pa, ...pb];
  assert.equal(all.length, 6);
  assert.equal(new Set(all.map((p) => p.merkle.root)).size, 1, "one shared root");
  assert.equal(new Set(all.map((p) => p.proof_id)).size, 6);
  for (const p of all) {
    assert.equal(p.status, "qualified");
    assert.equal(p.qualified, true);
    assert.ok(!JSON.stringify(p.leaf).includes("firm-"), "the leaf never names the firm");
    const v = await w.verify({ sha256: p.sha256, proof_id: p.proof_id });
    assert.equal(v.verdict, "V", JSON.stringify(v.checks));
  }
  const x = await w.verify({ sha256: sha("tampered"), proof_id: pa[0].proof_id });
  assert.equal(x.verdict, "X");
  const missing = await w.verify({ sha256: sha("a1"), proof_id: "nope" });
  assert.equal(missing.verdict, "not_found");
  w.close();
});

test("Certigna HTTP 402 → pending_qualified (OTS-less here), never a silent FreeTSA fallback, operator alert; requalified once Certigna is back", async () => {
  const alerts: string[] = [];
  let down = true;
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    if (down) return { ok: false, status: 402, arrayBuffer: async () => new ArrayBuffer(0) };
    return (fetch as unknown as FetchLike)(url, init);
  };
  const w = new HostedWitness({ dataDir: path.join(tmp, "402"), tsa: certignaLike(), ots: { enabled: false, calendars: [] }, batchWindowMs: 10, fetchImpl, onAlert: (m) => alerts.push(m) });
  const [p] = await w.submit([{ sha256: sha("doc"), label: "Doc", owner: "firm-a" }]);
  assert.equal(p.status, "pending_qualified");
  assert.equal(p.qualified, false);
  assert.equal(p.tsa, null);
  assert.ok(calls.every((u) => u === fake.url), "no other TSA (FreeTSA) was called");
  assert.ok(alerts.some((a) => /402/.test(a)), "operator alerted");
  assert.ok(alerts.every((a) => !/password|Authorization/i.test(a)));
  const pending = await w.verify({ sha256: p.sha256, proof_id: p.proof_id });
  assert.equal(pending.verdict, "pending");
  const pdfPending = await w.certificatePdf({ proof_id: p.proof_id, lang: "fr" });
  assert.ok(pdfPending && pdfPending.qualified === false);
  assert.ok(pdfPending!.lines.join(" ").includes("NON QUALIFIÉ"));
  assert.ok(!pdfPending!.lines.join(" ").includes("Horodatage électronique qualifié eIDAS"), "no 'qualified' claim while the token is missing");

  assert.equal(await w.requalifyPending(), 0, "still down: nothing requalified");
  down = false;
  assert.equal(await w.requalifyPending(), 1);
  const after = await w.getProof(p.proof_id);
  assert.equal(after?.status, "qualified");
  assert.equal(after?.qualified, true);
  const v = await w.verify({ sha256: p.sha256, proof_id: p.proof_id });
  assert.equal(v.verdict, "V");
  w.close();
});

test("TSA unreachable and OpenTimestamps off → the proof is still recorded as pending, nothing is lost", async () => {
  const fetchImpl: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
  const w = new HostedWitness({ dataDir: path.join(tmp, "down"), tsa: certignaLike(), ots: { enabled: false, calendars: [] }, batchWindowMs: 5, fetchImpl });
  const [p] = await w.submit([{ sha256: sha("x"), label: "X", owner: "o" }]);
  assert.equal(p.status, "pending_qualified");
  assert.ok(await w.getProof(p.proof_id));
  w.close();
});
