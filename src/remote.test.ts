import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";
import type { TsaProvider, FetchLike } from "./tsa.js";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";
import type { Billing } from "./plans.js";

let fake: FakeTsa;
let tmp: string;
before(async () => { fake = await startFakeTsa(); tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-remote-")); });
after(async () => { await fake.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const certignaLike = (): TsaProvider => ({ id: "certigna", label: "Certigna (simulated in tests)", url: fake.url, qualified: true, qualifiedBasis: "test", caFile: fake.caFile });

type ToolOut = { isError?: boolean; content: { type: string; text?: string; resource?: { mimeType: string; blob: string; uri: string } }[] };
function body(r: unknown): Record<string, any> {
  const t = (r as ToolOut).content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(t);
}
async function connect(url: string, apiKey?: string): Promise<Client> {
  const c = new Client({ name: "remote-test", version: "0" });
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
}

async function setup(name: string, o: { fetchImpl?: FetchLike; billing?: Billing; window?: number } = {}) {
  const dataDir = path.join(tmp, name);
  const store = new SubscriptionStore(path.join(dataDir, "subscriptions.json"));
  const witness = new HostedWitness({ dataDir, tsa: certignaLike(), ots: { enabled: false, calendars: [] }, batchWindowMs: o.window ?? 200, fetchImpl: o.fetchImpl, onAlert: () => {} });
  const srv = await startRemoteServer({ store, witness, dataDir, port: 0, billing: o.billing });
  return { store, witness, srv, dataDir };
}

test("remote client: lists tools, get_offer without key, paid tools without key → PAYMENT_REQUIRED (next_tool present_to_client)", async () => {
  const { srv } = await setup("public");
  try {
    const c = await connect(srv.url);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    for (const n of ["get_offer", "list_plans", "present_to_client", "request_upgrade", "get_subscription", "get_usage", "certify_document", "certify_hash", "verify_document", "verify_proof", "get_certificate_pdf"]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const offer = body(await c.callTool({ name: "get_offer", arguments: { lang: "de" } }));
    assert.equal(offer.lang, "de");
    assert.equal(offer.next_tool, "present_to_client");
    for (const [name, args] of [["certify_document", { sha256: sha("x") }], ["certify_hash", { items: [{ sha256: sha("x") }] }], ["get_usage", {}], ["get_certificate_pdf", { proof_id: "xvh_aaaaaaaaaaaaaaaaaaaaaa" }]] as const) {
      const r = await c.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      const b = body(r);
      assert.equal(b.code, "PAYMENT_REQUIRED", name);
      assert.equal(b.next_tool, "present_to_client");
      for (const k of ["message_localized", "retryable", "next_action"]) assert.ok(k in b, `${name}: ${k}`);
    }
    const bad = await connect(srv.url, "xvc_wrong");
    assert.equal(body(await bad.callTool({ name: "get_usage", arguments: {} })).code, "INVALID_KEY");
    await c.close(); await bad.close();
  } finally { await srv.close(); }
});

test("hash only: anything but 64 hex → HASH_INVALID; content field rejected; label > 120 → LABEL_INVALID; nothing counted", async () => {
  const { srv, store } = await setup("hashonly");
  try {
    const { api_key, key_hash } = await store.createApiKey({ plan_id: "coffre-horodate", quota: 10, status: "active" });
    const c = await connect(srv.url, api_key);
    for (const v of ["Contrat de bail entre M. Dupont et ...", sha("x").slice(0, 63), sha("x") + "0", "z".repeat(64), ""]) {
      const b = body(await c.callTool({ name: "certify_document", arguments: { sha256: v } }));
      assert.equal(b.code, "HASH_INVALID", JSON.stringify(v));
    }
    assert.equal(body(await c.callTool({ name: "certify_document", arguments: { sha256: sha("x"), content: "full text of the contract" } })).code, "HASH_INVALID");
    assert.equal(body(await c.callTool({ name: "certify_hash", arguments: { items: [{ sha256: sha("ok") }, { sha256: "not a hash" }] } })).code, "HASH_INVALID");
    assert.equal(body(await c.callTool({ name: "certify_document", arguments: { sha256: sha("x"), label: "L".repeat(121) } })).code, "LABEL_INVALID");
    assert.equal(body(await c.callTool({ name: "verify_document", arguments: { sha256: "hello", proof_id: "xvh_x" } })).code, "HASH_INVALID");
    assert.equal((await store.usage(key_hash)).certifications_this_period, 0);
    const okR = await c.callTool({ name: "certify_document", arguments: { sha256: sha("x").toUpperCase(), label: "L".repeat(120), lang: "it" } });
    assert.equal(body(okR).ok, true);
    await c.close();
  } finally { await srv.close(); }
});

test("multi-firm over HTTP: 2 keys × 3 fingerprints → 1 token, 6 proofs, each verify_proof = V (free, no key); PDF + 24 h link; quota", async () => {
  const { srv, store } = await setup("multi", { window: 400 });
  try {
    const A = await store.createApiKey({ plan_id: "coffre-horodate", quota: 4, status: "active", default_lang: "fr" });
    const B = await store.createApiKey({ plan_id: "coffre-horodate", quota: null, status: "trialing" });
    const ca = await connect(srv.url, A.api_key);
    const cb = await connect(srv.url, B.api_key);
    const before = fake.requests;
    const [ra, rb] = await Promise.all([
      ca.callTool({ name: "certify_hash", arguments: { items: ["a1", "a2", "a3"].map((s) => ({ sha256: sha(s), label: `Pièce ${s}` })) } }),
      cb.callTool({ name: "certify_hash", arguments: { items: ["b1", "b2", "b3"].map((s) => ({ sha256: sha(s) })), lang: "pl" } }),
    ]);
    assert.equal(fake.requests - before, 1, "one token for both firms");
    const ba = body(ra), bb = body(rb);
    assert.equal(ba.lang, "fr", "default language of the subscription");
    assert.equal(bb.lang, "pl");
    assert.equal(ba.batch_root, bb.batch_root);
    assert.equal(ba.fingerprints_in_shared_timestamp, 6);
    const results = [...ba.results, ...bb.results];
    assert.equal(results.length, 6);
    const pub = await connect(srv.url); // no key: verification is free
    for (const r of results) {
      assert.equal(r.status, "qualified");
      assert.match(r.pdf_url, /\/pdf\/[A-Za-z0-9_-]+\.pdf$/);
      const v = body(await pub.callTool({ name: "verify_proof", arguments: { sha256: r.sha256, proof_id: r.proof_id, lang: "es" } }));
      assert.equal(v.verdict, "V");
      assert.equal(v.qualified, true);
      assert.ok(!JSON.stringify(v).includes(A.key_hash) && !JSON.stringify(v).includes(B.key_hash), "never reveals the firm");
    }
    const x = body(await pub.callTool({ name: "verify_document", arguments: { sha256: sha("other"), proof_id: results[0].proof_id } }));
    assert.equal(x.verdict, "X");
    const res = await fetch(results[0].pdf_url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    // certify_document returns the PDF embedded
    const one = await ca.callTool({ name: "certify_document", arguments: { sha256: sha("a4") } }) as ToolOut;
    assert.equal(one.content.find((c) => c.type === "resource")?.resource?.mimeType, "application/pdf");
    // quota of A = 4 → the 5th is refused with next_reset
    const q = body(await ca.callTool({ name: "certify_document", arguments: { sha256: sha("a5") } }));
    assert.equal(q.code, "QUOTA_EXCEEDED");
    assert.match(q.next_reset, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    const u = body(await ca.callTool({ name: "get_usage", arguments: {} }));
    assert.equal(u.certifications_this_period, 4);
    // reissue: own proof in another language OK; another firm's proof → PROOF_NOT_FOUND
    const re = await ca.callTool({ name: "get_certificate_pdf", arguments: { proof_id: ba.results[0].proof_id, lang: "sv" } }) as ToolOut;
    assert.equal(body(re).lang, "sv");
    assert.ok(re.content.some((c) => c.type === "resource"));
    assert.equal(body(await ca.callTool({ name: "get_certificate_pdf", arguments: { proof_id: bb.results[0].proof_id } })).code, "PROOF_NOT_FOUND");
    await ca.close(); await cb.close(); await pub.close();
  } finally { await srv.close(); }
});

test("simulated Certigna 402 over HTTP → pending_qualified, PDF never claims 'qualified', no fallback; later get_certificate_pdf is qualified", async () => {
  let down = true;
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    if (down) return { ok: false, status: 402, arrayBuffer: async () => new ArrayBuffer(0) };
    return (fetch as unknown as FetchLike)(url, init);
  };
  const { srv, store, witness } = await setup("402", { fetchImpl, window: 20 });
  try {
    const { api_key } = await store.createApiKey({ plan_id: "coffre-horodate", quota: null, status: "active" });
    const c = await connect(srv.url, api_key);
    const r = await c.callTool({ name: "certify_document", arguments: { sha256: sha("doc402"), lang: "en" } }) as ToolOut;
    const b = body(r);
    assert.equal(b.results[0].status, "pending_qualified");
    assert.equal(b.results[0].qualified, false);
    assert.match(b.next_action, /NOT QUALIFIED/);
    assert.ok(urls.every((u) => u === fake.url), "no other TSA called");
    assert.equal(r.content.find((x) => x.type === "resource")?.resource?.mimeType, "application/pdf", "a receipt PDF is still delivered");
    for (const lang of ["en", "fr", "de"]) {
      const pdf = await witness.certificatePdf({ proof_id: b.results[0].proof_id, lang });
      const text = pdf!.lines.join(" ");
      assert.equal(pdf!.qualified, false);
      assert.ok(/NOT QUALIFIED|NON QUALIFIÉ|NICHT QUALIFIZIERT/i.test(text), `${lang}: banner`);
    }
    const en = (await witness.certificatePdf({ proof_id: b.results[0].proof_id, lang: "en" }))!.lines.join(" ");
    assert.ok(!en.includes("Qualified eIDAS electronic timestamp"), "never the qualified provider line while pending");
    down = false;
    assert.equal(await witness.requalifyPending(), 1);
    const again = body(await c.callTool({ name: "get_certificate_pdf", arguments: { proof_id: b.results[0].proof_id } }));
    assert.equal(again.qualified, true);
    assert.equal(again.status, "qualified");
    await c.close();
  } finally { await srv.close(); }
});

test("single-question journey (fake billing, tests only): get_offer → present_to_client → ONE yes → request_upgrade → get_subscription → certify_document → PDF", async () => {
  let pairing: string | undefined;
  const billing: Billing = {
    live: true,
    async createCheckout(req) {
      pairing = req.pairing_code;
      return { checkout_url: "https://checkout.invalid/test", expires_at: new Date(Date.now() + 3600e3).toISOString(), pairing_code: req.pairing_code };
    },
  };
  const { srv, store } = await setup("journey", { billing, window: 20 });
  try {
    const ai = await connect(srv.url);
    const questionsToHuman: string[] = [];
    const offer = body(await ai.callTool({ name: "get_offer", arguments: { lang: "nl" } }));
    assert.equal(offer.next_tool, "present_to_client");
    const pres = body(await ai.callTool({ name: offer.next_tool, arguments: { lang: "nl", context: "litige" } }));
    questionsToHuman.push(pres.consent_prompt); // the only question
    const human = "Ja";
    const up = body(await ai.callTool({ name: pres.next_tool, arguments: { lang: "nl", human_confirmed: true, consent_quote: human } }));
    assert.equal(up.ok, true);
    assert.equal(up.checkout_url, "https://checkout.invalid/test");
    assert.equal(up.next_tool, "get_subscription");
    const notPaid = body(await ai.callTool({ name: "get_subscription", arguments: { pairing_code: up.pairing_code } }));
    assert.equal(notPaid.code, "NOT_PAID_YET");
    assert.equal(notPaid.retryable, true);
    await store.activatePairing(pairing!, { status: "trialing", quota: 50 }); // stands in for the L4 Stripe webhook
    const sub = body(await ai.callTool({ name: "get_subscription", arguments: { pairing_code: up.pairing_code } }));
    assert.equal(sub.status, "trialing");
    assert.match(sub.api_key, /^xvc_/);
    assert.equal(sub.default_lang, "nl");
    const lawyer = await connect(srv.url, sub.api_key);
    const cert = await lawyer.callTool({ name: "certify_document", arguments: { sha256: sha("pleidooi.pdf"), label: "Pleidooi v2" } }) as ToolOut;
    const cb = body(cert);
    assert.equal(cb.lang, "nl");
    assert.equal(cb.results[0].status, "qualified");
    assert.ok(cert.content.some((c) => c.type === "resource" && c.resource?.mimeType === "application/pdf"));
    assert.equal(questionsToHuman.length, 1, "exactly one question to the lawyer");
    assert.match(questionsToHuman[0], /19/);
    await ai.close(); await lawyer.close();
  } finally { await srv.close(); }
});
