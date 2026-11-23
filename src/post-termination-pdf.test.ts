/**
 * A4: after past_due or canceled, PDFs of existing proofs stay available
 * for POST_TERMINATION_ACCESS_DAYS (365, easy to switch to 90). New
 * certifications stay blocked. After the window, a distinct ACCESS_ENDED error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";
import { CERTIGNA_QUALIFIED_POLICY_OID, type TsaProvider } from "./tsa.js";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore, POST_TERMINATION_ACCESS_DAYS } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DAY_MS = 24 * 3600 * 1000;

type ToolOut = { isError?: boolean; content: { type: string; text?: string; resource?: { mimeType: string; blob: string; uri: string } }[] };
function body(r: unknown): Record<string, unknown> {
  const t = (r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(t) as Record<string, unknown>;
}

async function connect(url: string, apiKey?: string): Promise<Client> {
  const c = new Client({ name: "a4-test", version: "0" });
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
}

test("POST_TERMINATION_ACCESS_DAYS is the single named duration (tests must not hard-code 365)", () => {
  assert.equal(typeof POST_TERMINATION_ACCESS_DAYS, "number");
  assert.ok(POST_TERMINATION_ACCESS_DAYS > 0);
});

test("past_due/canceled: PDF of existing proofs allowed at constant-1 days; certify stays blocked; constant+1 days → ACCESS_ENDED", async () => {
  const fake: FakeTsa = await startFakeTsa({ policy: CERTIGNA_QUALIFIED_POLICY_OID });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-a4-"));
  const t0 = new Date("2026-01-15T12:00:00.000Z");
  let now = new Date(t0);
  const servers: { close(): Promise<void> }[] = [];
  const clients: Client[] = [];
  try {
    const store = new SubscriptionStore(path.join(tmp, "subscriptions.json"), () => now);
    const tsa: TsaProvider = {
      id: "certigna",
      label: "Certigna (test)",
      url: fake.url,
      qualified: true,
      qualifiedBasis: "test",
      caFile: fake.caFile,
      qualifiedTrust: { name: "Certigna (simulated)", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: fake.caFile },
    };
    const witness = new HostedWitness({ dataDir: tmp, tsa, ots: { enabled: false, calendars: [] }, batchWindowMs: 50, onAlert: () => {} });
    const srv = await startRemoteServer({ store, witness, dataDir: tmp, port: 0, now: () => now });
    servers.push(srv);
    const { api_key, key_hash } = await store.createApiKey({ plan_id: "coffre-horodate", quota: null, status: "active", default_lang: "fr" });
    const c = await connect(srv.url, api_key);
    clients.push(c);
    const cert = body(await c.callTool({ name: "certify_hash", arguments: { items: [{ sha256: sha("acte"), label: "Acte" }] } }));
    assert.equal(cert.ok, true, JSON.stringify(cert));
    const proofId = (cert.results as { proof_id: string }[])[0].proof_id;

    await store.setSubscriptionState(key_hash, { status: "canceled", ended_at: t0.toISOString() });

    now = new Date(t0.getTime() + (POST_TERMINATION_ACCESS_DAYS - 1) * DAY_MS);
    for (const name of ["get_report_pdf", "get_certificate_pdf", "get_verification_report"] as const) {
      const r = await c.callTool({ name, arguments: { proof_id: proofId, lang: "fr" } }) as ToolOut;
      const b = body(r);
      assert.equal(b.ok, true, `${name} at days-1: ${JSON.stringify(b)}`);
      assert.equal(r.isError, undefined, name);
    }
    const blocked = body(await c.callTool({ name: "certify_hash", arguments: { items: [{ sha256: sha("nouveau"), label: "Nouveau" }] } }));
    assert.equal(blocked.code, "PAYMENT_REQUIRED", "new certifications stay blocked during the window");

    now = new Date(t0.getTime() + (POST_TERMINATION_ACCESS_DAYS + 1) * DAY_MS);
    for (const name of ["get_report_pdf", "get_certificate_pdf", "get_verification_report"] as const) {
      const b = body(await c.callTool({ name, arguments: { proof_id: proofId, lang: "fr" } }));
      assert.equal(b.code, "ACCESS_ENDED", `${name} at days+1: ${JSON.stringify(b)}`);
      assert.equal(typeof b.message_localized, "string");
      assert.notEqual(b.code, "PAYMENT_REQUIRED", "after the window the error must be distinct from PAYMENT_REQUIRED");
    }
    const stillBlocked = body(await c.callTool({ name: "certify_document", arguments: { sha256: sha("encore") } }));
    assert.equal(stillBlocked.code, "PAYMENT_REQUIRED");

  } finally {
    for (const c of clients) await c.close().catch(() => {});
    for (const s of servers) await s.close().catch(() => {});
    await fake.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("past_due within the window also allows existing PDFs; missing ended_at is back-filled once", async () => {
  const fake: FakeTsa = await startFakeTsa({ policy: CERTIGNA_QUALIFIED_POLICY_OID });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-a4-pd-"));
  const t0 = new Date("2026-03-01T00:00:00.000Z");
  let now = new Date(t0);
  const servers: { close(): Promise<void> }[] = [];
  const clients: Client[] = [];
  try {
    const store = new SubscriptionStore(path.join(tmp, "subscriptions.json"), () => now);
    const tsa: TsaProvider = {
      id: "certigna",
      label: "Certigna (test)",
      url: fake.url,
      qualified: true,
      qualifiedBasis: "test",
      caFile: fake.caFile,
      qualifiedTrust: { name: "Certigna (simulated)", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: fake.caFile },
    };
    const witness = new HostedWitness({ dataDir: tmp, tsa, ots: { enabled: false, calendars: [] }, batchWindowMs: 50, onAlert: () => {} });
    const srv = await startRemoteServer({ store, witness, dataDir: tmp, port: 0, now: () => now });
    servers.push(srv);
    const { api_key, key_hash } = await store.createApiKey({ plan_id: "coffre-horodate", quota: null, status: "active" });
    const c = await connect(srv.url, api_key);
    clients.push(c);
    const cert = body(await c.callTool({ name: "certify_hash", arguments: { items: [{ sha256: sha("doc"), label: "Doc" }] } }));
    const proofId = (cert.results as { proof_id: string }[])[0].proof_id;

    await store.setSubscriptionState(key_hash, { status: "past_due", ended_at: null });
    const rec = await store.authenticate(api_key);
    assert.ok(rec?.ended_at, "ended_at must be back-filled for retrocompatibility");
    assert.equal(Date.parse(rec!.ended_at!), t0.getTime());

    now = new Date(t0.getTime() + (POST_TERMINATION_ACCESS_DAYS - 1) * DAY_MS);
    const pdf = body(await c.callTool({ name: "get_report_pdf", arguments: { proof_id: proofId } }));
    assert.equal(pdf.ok, true, JSON.stringify(pdf));

    now = new Date(t0.getTime() + (POST_TERMINATION_ACCESS_DAYS + 1) * DAY_MS);
    const ended = body(await c.callTool({ name: "get_report_pdf", arguments: { proof_id: proofId } }));
    assert.equal(ended.code, "ACCESS_ENDED");

  } finally {
    for (const c of clients) await c.close().catch(() => {});
    for (const s of servers) await s.close().catch(() => {});
    await fake.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
