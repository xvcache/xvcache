/**
 * Qualification is read from the token, never from configuration (juriste, 23/11/2026):
 *  1. qualified only with the Certigna qualified policy OID AND a signer issued by the bundled Certigna chain;
 *  2. the PDF prints the OID actually read in the token, or « absent » (then never qualified);
 *  3. no verified signature (e.g. openssl missing) → never qualified, explicit "signature not verified";
 *     V/X on the fingerprint is unchanged.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  assessQualification, parseTimeStampToken, requestTimestamp, CERTIGNA_QUALIFIED_POLICY_OID,
  type TsaProvider,
} from "./tsa.js";
import { parseDer, derValue, tlv, type DerNode } from "./der.js";
import { Certifier, certifyConfigFromEnv } from "./certify.js";
import { renderCertificate, type CertificateModel } from "./certificate.js";
import { HostedWitness } from "./witness.js";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "certigna-test-20261123.tst");
const REAL = readFileSync(FIXTURE);
const REAL_ROOT = "6a6bb214ab9bfd23d09c259fd7fa9f67199f0dfc262ef3f2b39681216ccde0e1";
const NO_OPENSSL = "/nonexistent/xvcache-no-openssl";

let cg: FakeTsa; // fake TSA that (falsely) uses the Certigna OID with its own throwaway CA
let other: FakeTsa; // fake TSA with a non-qualified policy
let tmp: string;
before(async () => {
  cg = await startFakeTsa({ policy: CERTIGNA_QUALIFIED_POLICY_OID });
  other = await startFakeTsa();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-qual-"));
});
after(async () => { await cg.close(); await other.close(); await fs.rm(tmp, { recursive: true, force: true }); });

async function withoutOpenssl<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.XVCACHE_OPENSSL_BIN;
  process.env.XVCACHE_OPENSSL_BIN = NO_OPENSSL;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.XVCACHE_OPENSSL_BIN; else process.env.XVCACHE_OPENSSL_BIN = prev; }
}

function pdfText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1");
  let out = "";
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { try { out += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { out += m[1]; } }
  return out;
}

/** Re-encode a DER tree, replacing one node's bytes. */
function rebuild(buf: Buffer, n: DerNode, target: DerNode, replacement: Buffer): Buffer {
  if (n === target) return replacement;
  if (!n.constructed || !n.children) return buf.subarray(n.start, n.end);
  return tlv(n.tag, Buffer.concat(n.children.map((c) => rebuild(buf, c, target, replacement))));
}

/** Same token with TSTInfo.policy removed (signature then invalid, but the OID check comes first). */
function stripPolicy(token: Buffer): Buffer {
  const ci = parseDer(token);
  const octet = ci.children![1].children![0].children![2].children![1].children![0];
  const tst = derValue(token, octet);
  const t = parseDer(tst);
  const fields = t.children!.filter((_, i) => i !== 1).map((c) => tst.subarray(c.start, c.end));
  const newTst = tlv(0x30, Buffer.concat(fields));
  return rebuild(token, ci, octet, tlv(0x04, newTst));
}

test("real Certigna token of 23/11/2026 (offline): qualified — Certigna OID, issued by the Certigna chain, signature verified", async () => {
  const info = parseTimeStampToken(REAL);
  assert.equal(info.policy, CERTIGNA_QUALIFIED_POLICY_OID);
  assert.equal(info.messageImprint, REAL_ROOT);
  assert.equal(info.genTime, "2026-11-23T06:09:23.000Z");
  const q = await assessQualification(REAL, REAL_ROOT);
  assert.equal(q.status, "qualified", q.detail);
  assert.equal(q.qualified, true);
  assert.equal(q.signature, "verified");
  assert.equal(q.signer_issuer, "Certigna Entity CA");
});

test("defect 3: real Certigna token but openssl missing → signature_unverified, NOT qualified", async () => {
  const q = await assessQualification(REAL, REAL_ROOT, undefined, { openssl: NO_OPENSSL });
  assert.equal(q.qualified, false);
  assert.equal(q.status, "signature_unverified");
  assert.equal(q.signature, "unavailable");
  assert.match(q.detail, /non vérifiée/);
});

test("real Certigna token over another digest → signature_invalid, NOT qualified", async () => {
  const q = await assessQualification(REAL, "00".repeat(32));
  assert.equal(q.qualified, false);
  assert.equal(q.status, "signature_invalid");
});

test("defect 1: Certigna OID but signer NOT issued by the bundled Certigna chain → NOT qualified", async () => {
  const p: TsaProvider = { id: "certigna", label: "Certigna", url: cg.url, qualified: true, qualifiedBasis: "config says so" };
  const r = await requestTimestamp(p, "ab".repeat(32));
  assert.equal(r.info.policy, CERTIGNA_QUALIFIED_POLICY_OID);
  const q = await assessQualification(r.token, "ab".repeat(32));
  assert.equal(q.qualified, false);
  assert.equal(q.status, "signer_not_trusted");
  assert.equal(q.signer_issuer, "XVcache Test Root");
});

test("defect 1: provider configured as Certigna/qualified but token policy is not the qualified OID → NOT qualified", async () => {
  const p: TsaProvider = { id: "certigna", label: "Certigna", url: other.url, qualified: true, qualifiedBasis: "config says so", caFile: other.caFile };
  const r = await requestTimestamp(p, "cd".repeat(32));
  const q = await assessQualification(r.token, "cd".repeat(32), { name: "test", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: other.caFile });
  assert.equal(q.qualified, false);
  assert.equal(q.status, "policy_not_qualified");
  assert.equal(q.policy, "1.2.3.4.99");
});

test("defect 2: token without policy OID → policy null / « absent », NOT qualified", async () => {
  const stripped = stripPolicy(REAL);
  const info = parseTimeStampToken(stripped);
  assert.equal(info.policy, null);
  assert.equal(info.messageImprint, REAL_ROOT);
  const q = await assessQualification(stripped, REAL_ROOT);
  assert.equal(q.qualified, false);
  assert.equal(q.status, "policy_absent");
});

function model(over: Partial<NonNullable<CertificateModel["tsa"]>>, lang = "fr"): CertificateModel {
  return {
    lang, tz: "Europe/Paris", kind: "timestamp", verdict: "V", label: "Acte.md", sha256: "9f".repeat(32),
    gen_time: "2026-11-23T06:09:23.000Z",
    tsa: { provider: "certigna", label: "Certigna (horodatage qualifié eIDAS)", qualified: true, policy: CERTIGNA_QUALIFIED_POLICY_OID, serial: "4dcd185f69e24f7e9a1fc4ebd43e4529", signature: "verified", ...over },
    attachments: [], fixed_date: "2026-11-23T06:09:23.000Z",
  };
}

test("defect 2: PDF prints the OID read in the token, « absent » when missing — never a default OID, never qualified", async () => {
  const ok = await renderCertificate(model({}));
  const okText = ok.lines.join("\n");
  assert.match(okText, /1\.2\.250\.1\.177\.2\.9\.1/);
  assert.match(okText, /Horodatage électronique qualifié eIDAS/);
  const abs = await renderCertificate(model({ policy: null }));
  const t = abs.lines.join("\n");
  assert.doesNotMatch(t, /1\.2\.250\.1\.177\.2\.9\.1/);
  assert.match(t, /Référence de politique : absent/);
  assert.match(t, /NON QUALIFIÉ/);
  assert.doesNotMatch(t, /Horodatage électronique qualifié eIDAS/);
  assert.doesNotMatch(pdfText(abs.bytes), /Qualified eIDAS electronic timestamp certificate/);
});

test("defect 3: PDF with an unverified signature says so explicitly and is NOT qualified (fr + en)", async () => {
  for (const lang of ["fr", "en"]) {
    const r = await renderCertificate(model({ signature: "unavailable" }, lang));
    const t = r.lines.join(" ");
    assert.match(t, lang === "fr" ? /NON vérifiée \(vérification impossible\)/ : /NOT verified \(verification impossible\)/);
    assert.match(t, lang === "fr" ? /NON QUALIFIÉ/ : /NOT QUALIFIED/);
    assert.match(t, lang === "fr" ? /signature du jeton n'a pas pu être vérifiée/ : /signature could not be verified/);
    assert.match(t, lang === "fr" ? /Empreinte conforme — signature non vérifiée/ : /Fingerprint matches — signature not verified/);
    assert.doesNotMatch(t, lang === "fr" ? /Document intact/ : /Document intact/);
    assert.equal(r.pages, 1);
    assert.equal(r.overflow, false);
  }
});

function certignaLike(fake: FakeTsa): TsaProvider {
  return {
    id: "certigna", label: "Certigna (simulated in tests)", url: fake.url, qualified: true, qualifiedBasis: "test", caFile: fake.caFile,
    qualifiedTrust: { name: "Certigna (simulated)", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: fake.caFile },
  };
}

test("defect 3, local proofs: openssl missing → V/X on the fingerprint unchanged, but never qualified, explicit 'signature non vérifiée'", async () => {
  const vault = path.join(tmp, "local", "vault");
  await fs.mkdir(vault, { recursive: true });
  const c = new Certifier(certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: path.join(tmp, "local", "j.jsonl"), tsa: certignaLike(cg) }, { XVCACHE_OTS: "off" }));
  await fs.writeFile(path.join(vault, "Acte.md"), "# Acte\n");
  await c.enqueue("Acte.md");
  const b = await c.runBatch();
  if ("error" in b) assert.fail(b.error);
  assert.equal(b.proofs[0].tsa!.qualified, true, "with openssl: qualified (simulated trust)");
  const ok = await c.verify({ path: "Acte.md", online: false });
  assert.equal(ok.glyph, "V");
  assert.equal(ok.qualified, true);

  const off = await withoutOpenssl(() => c.verify({ path: "Acte.md", online: false }));
  assert.equal(off.glyph, "V", "fingerprint intact → still V");
  assert.equal(off.qualified, false);
  assert.equal(off.qualified_confirmed, false);
  assert.equal(off.signature, "unavailable");
  assert.equal(off.qualification?.status, "signature_unverified");
  assert.match(off.message, /signature du jeton NON VÉRIFIÉE \(vérification impossible/);
  assert.match(off.message, /V  empreinte conforme, signature non vérifiée/);
  assert.doesNotMatch(off.message, /V  certifiée/);
  assert.doesNotMatch(off.message, /horodatage qualifié eIDAS,/);

  await fs.writeFile(path.join(vault, "Acte.md"), "# Acte modifié\n");
  const x = await withoutOpenssl(() => c.verify({ path: "Acte.md", online: false }));
  assert.equal(x.glyph, "X", "modified fingerprint → X even without openssl");
  assert.equal(x.qualified, false);
});

test("defect 3, hosted: openssl missing → verdict V but qualified=false, status timestamped, PDF NOT QUALIFIED with 'signature non vérifiée'", async () => {
  const w = new HostedWitness({ dataDir: path.join(tmp, "hosted"), tsa: certignaLike(cg), ots: { enabled: false, calendars: [] }, batchWindowMs: 10, onAlert: () => {} });
  try {
    const [p] = await w.submit([{ sha256: "ef".repeat(32), label: "Contrat", owner: "firm" }]);
    assert.equal(p.status, "qualified");
    const v = await withoutOpenssl(() => w.verify({ sha256: "ef".repeat(32), proof_id: p.proof_id }));
    assert.equal(v.verdict, "V");
    assert.equal(v.qualified, false);
    assert.equal(v.status, "timestamped");
    assert.equal(v.signature, "unavailable");
    assert.equal(v.proof!.qualified, false, "stored 'qualified' is not echoed back");
    const pdf = await withoutOpenssl(() => w.certificatePdf({ proof_id: p.proof_id, lang: "fr" }));
    assert.ok(pdf);
    assert.equal(pdf!.qualified, false);
    const t = pdf!.lines.join(" ");
    assert.match(t, /NON QUALIFIÉ/);
    assert.match(t, /NON vérifiée/);
    assert.match(t, /Empreinte conforme — signature non vérifiée/);
    assert.doesNotMatch(t, /Document intact/);
    const x = await withoutOpenssl(() => w.verify({ sha256: "00".repeat(32), proof_id: p.proof_id }));
    assert.equal(x.verdict, "X");
    const back = await w.certificatePdf({ proof_id: p.proof_id, lang: "fr" });
    assert.equal(back!.qualified, true, "openssl back → qualified again (recomputed from the token)");
  } finally {
    w.close();
  }
});
