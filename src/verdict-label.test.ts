/**
 * A6 (Sophie's wording, FR authoritative): five distinct verdicts.
 * "Intact" only when the token signature is verified. The other four states
 * must not render Intact / certifié / certificat / certified / certificate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EU_LANGS, loadLocale, fill, formatLocalDateTime, FR_EN_ONLY_CERT_KEYS } from "./i18n.js";
import {
  humanVerdict,
  localizedVerdict,
  renderCertificate,
  displayTone,
  handleDocument,
  type CertificateModel,
} from "./certificate.js";
import type { VerifyReport } from "./certify.js";
import { Certifier, certifyConfigFromEnv } from "./certify.js";
import type { OtsStatus } from "./ots.js";
import { startFakeTsa } from "./test-tsa.js";
import { resolveTsaProvider, type TsaProvider } from "./tsa.js";
import { HostedWitness } from "./witness.js";
import { SubscriptionStore } from "./subscriptions.js";
import { startRemoteServer } from "./remote.js";

const WHEN = "2026-11-22T19:08:39.000Z";
const OTS_WHEN = "2026-11-22T19:11:00.000Z";
const FORBIDDEN = /\b(intact|certifié|certifiée|certifiés|certifiées|certificat|certificats|certified|certificate|certificates)\b/i;

const FR = {
  intact_title: "Intact",
  unverified_title: "Empreinte conforme — signature non vérifiée",
  unverified_sentence: "Ce document a la même empreinte que celle inscrite dans le jeton daté du {date}. La signature de ce jeton n'a pas pu être vérifiée : cette date n'est donc pas confirmée.",
  invalid_title: "Signature invalide",
  invalid_sentence: "La signature du jeton d'horodatage n'est pas valide. Cette date n'est pas fiable.",
  ots_only_title: "Empreinte conforme — sans jeton d'horodatage",
  ots_only_sentence: "Ce document a la même empreinte que celle ancrée dans la blockchain Bitcoin au plus tard le {date} (preuve OpenTimestamps). Aucun jeton d'horodatage n'est joint.",
  ots_pending_title: "Preuve en attente de confirmation",
  ots_pending_sentence: "Ce document a la même empreinte que celle inscrite dans la preuve OpenTimestamps jointe. Cette preuve n'est pas encore confirmée sur la blockchain Bitcoin. Aucun jeton d'horodatage n'est joint.",
};
const EN = {
  intact_title: "Document intact",
  unverified_title: "Fingerprint matches — signature not verified",
  unverified_sentence: "This document has the same fingerprint as the one recorded in the token dated {date}. The token's signature could not be verified, so this date is not confirmed.",
  invalid_title: "Invalid signature",
  invalid_sentence: "The timestamp token signature is not valid. This date cannot be relied on.",
  ots_only_title: "Fingerprint matches — no timestamp token",
  ots_only_sentence: "This document has the same fingerprint as the one anchored in the Bitcoin blockchain no later than {date} (OpenTimestamps proof). No timestamp token is attached.",
  ots_pending_title: "Proof awaiting confirmation",
  ots_pending_sentence: "This document has the same fingerprint as the one recorded in the attached OpenTimestamps proof. This proof is not yet confirmed on the Bitcoin blockchain. No timestamp token is attached.",
};


function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    glyph: "V",
    message: "V  certifiée — Note Acte.md existait telle quelle.",
    path: "Acte.md",
    batch_id: "batch",
    root: "0".repeat(64),
    gen_time: WHEN,
    provider: "certigna",
    qualified: false,
    qualified_confirmed: false,
    signature: "verified",
    qualification: null,
    checks: { note: { ok: true, detail: "ok" } },
    ots: null,
    ...over,
  };
}

function model(over: Partial<CertificateModel> = {}): CertificateModel {
  return {
    lang: "fr",
    tz: "Europe/Paris",
    kind: "verification",
    verdict: "V",
    label: "Acte.md",
    sha256: "9f".repeat(32),
    gen_time: WHEN,
    tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "verified" },
    attachments: [],
    ...over,
  };
}

function flat(lines: string[]): string {
  return lines.join(" ").replace(/\s+/g, " ");
}

function pdfRaw(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function assertNoForbidden(label: string, ...texts: string[]): void {
  for (const t of texts) {
    const m = t.match(FORBIDDEN);
    assert.equal(m, null, `${label}: forbidden word ${m?.[0]} in: ${t.slice(0, 280)}`);
  }
}

function dateFr(iso: string): string {
  const w = formatLocalDateTime(iso, "fr", "Europe/Paris");
  return `${w.local} (${w.tz}) — ${w.utc} UTC`;
}
function dateEn(iso: string): string {
  const w = formatLocalDateTime(iso, "en", "Europe/Paris");
  return `${w.local} (${w.tz}) — ${w.utc} UTC`;
}

const DOC_TITLE_FR = "Rapport de vérification";
const DOC_TITLE_EN = "Verification report";
const PUBLIC_CERT_WORD = /\b(certificat|certificats|certificate|certificates)\b/i;

async function pdfMeta(bytes: Uint8Array): Promise<{ title: string; subject: string }> {
  const doc = await PDFDocument.load(bytes);
  return { title: doc.getTitle() ?? "", subject: doc.getSubject() ?? "" };
}

function fiveStateModels(lang: "fr" | "en"): { name: string; model: CertificateModel }[] {
  const tsaOk = { provider: "certigna", label: "Certigna", qualified: true, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "verified" as const };
  const tsaUnavail = { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "unavailable" as const };
  const tsaFailed = { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "failed" as const };
  return [
    { name: "intact", model: model({ lang, tsa: tsaOk }) },
    { name: "signature_unverified", model: model({ lang, tsa: tsaUnavail }) },
    { name: "signature_invalid", model: model({ lang, verdict: "X", tsa: tsaFailed }) },
    { name: "ots_only", model: model({ lang, gen_time: null, tsa: null, ots_status: "confirmed", ots_block_time: OTS_WHEN }) },
    { name: "ots_pending", model: model({ lang, tsa: null, ots_status: "pending" }) },
  ];
}

const otsConfirmed: OtsStatus = {
  status: "confirmed",
  digest: "0".repeat(64),
  pending_calendars: [],
  bitcoin: [{ height: 900000, ok: true, block_time: OTS_WHEN, detail: "ok" }],
  detail: "ok",
};
const otsPending: OtsStatus = {
  status: "pending",
  digest: "0".repeat(64),
  pending_calendars: ["https://a.pool.opentimestamps.org"],
  bitcoin: [],
  detail: "pending",
};

test("state 1: signed and verified → Intact, green", async () => {
  const v = humanVerdict(report({ signature: "verified", qualified: true, qualified_confirmed: true }));
  assert.equal(v.kind, "intact");
  assert.equal(v.glyph, "V");
  assert.equal(v.title, FR.intact_title);
  assert.match(v.sentence, /^Intact — /);
  assert.equal(displayTone("intact"), "green");
  const fr = localizedVerdict("intact", "fr", WHEN, "Europe/Paris");
  const en = localizedVerdict("intact", "en", WHEN, "Europe/Paris");
  assert.equal(fr, fill(loadLocale("fr").cert.verdict_intact, { date: dateFr(WHEN) }));
  assert.equal(en, fill(loadLocale("en").cert.verdict_intact, { date: dateEn(WHEN) }));
  const r = await renderCertificate(model({
    lang: "fr",
    tsa: { provider: "certigna", label: "Certigna", qualified: true, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "verified" },
  }));
  const t = flat(r.lines);
  assert.ok(t.includes(loadLocale("fr").cert.title_intact));
  assert.ok(r.lines.includes("V"));
});

test("state 2: verification impossible (openssl / chain unavailable) → distinct label, amber, not Intact", async () => {
  const v = humanVerdict(report({ signature: "unavailable", qualified: false }));
  assert.equal(v.kind, "signature_unverified");
  assert.equal(v.glyph, "V");
  assert.equal(v.title, FR.unverified_title);
  assert.equal(displayTone("signature_unverified"), "amber");
  const fr = localizedVerdict("signature_unverified", "fr", WHEN, "Europe/Paris");
  const en = localizedVerdict("signature_unverified", "en", WHEN, "Europe/Paris");
  assert.equal(fr, fill(FR.unverified_sentence, { date: dateFr(WHEN) }));
  assert.equal(en, fill(EN.unverified_sentence, { date: dateEn(WHEN) }));
  assert.doesNotMatch(fr, FORBIDDEN);
  assert.doesNotMatch(en, FORBIDDEN);
  const r = await renderCertificate(model({
    lang: "fr",
    tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "unavailable" },
  }));
  const t = flat(r.lines);
  assert.ok(t.includes(FR.unverified_title));
  assert.ok(t.includes("cette date n'est donc pas confirmée"));
  assert.ok(!t.includes(loadLocale("fr").cert.title_intact));
  assertNoForbidden("FR PDF unverified", t, pdfRaw(r.bytes));
  const enPdf = await renderCertificate(model({
    lang: "en",
    tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "unavailable" },
  }));
  assertNoForbidden("EN PDF unverified", flat(enPdf.lines), pdfRaw(enPdf.bytes));
  assert.ok(flat(enPdf.lines).includes(EN.unverified_title));
});

test("state 3: signature checked and invalid → red, Signature invalide / Invalid signature", async () => {
  const v = humanVerdict(report({ glyph: "X", signature: "failed", qualified: false, checks: { note: { ok: true, detail: "ok" }, tsa_signature: { ok: false, detail: "bad" } } }));
  assert.equal(v.kind, "signature_invalid");
  assert.equal(v.glyph, "X");
  assert.equal(v.title, FR.invalid_title);
  assert.equal(v.sentence, FR.invalid_sentence);
  assert.equal(displayTone("signature_invalid"), "red");
  const en = localizedVerdict("signature_invalid", "en", WHEN, "Europe/Paris");
  assert.equal(en, EN.invalid_sentence);
  assert.doesNotMatch(v.sentence, FORBIDDEN);
  assert.doesNotMatch(en, FORBIDDEN);
  const r = await renderCertificate(model({
    lang: "fr",
    verdict: "X",
    tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "failed" },
  }));
  const t = flat(r.lines);
  assert.ok(t.includes(FR.invalid_title));
  assert.ok(!t.includes(loadLocale("fr").cert.title_intact));
  assert.ok(!t.includes(loadLocale("fr").cert.title_modified) || t.includes(FR.invalid_title));
  assert.ok(!t.includes(loadLocale("fr").cert.title_modified), "must not reuse the generic 'Modifié' title");
  assertNoForbidden("FR PDF invalid signature", t, pdfRaw(r.bytes));
  const enPdf = await renderCertificate(model({
    lang: "en",
    verdict: "X",
    tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "failed" },
  }));
  assert.ok(flat(enPdf.lines).includes(EN.invalid_title));
  assertNoForbidden("EN PDF invalid signature", flat(enPdf.lines), pdfRaw(enPdf.bytes));
});

test("state 4: no TSA token, OpenTimestamps confirmed → own label, amber, not Intact", async () => {
  const v = humanVerdict(report({
    signature: null,
    provider: null,
    gen_time: null,
    ots: otsConfirmed,
  }));
  assert.equal(v.kind, "ots_only");
  assert.equal(v.glyph, "V");
  assert.equal(v.title, FR.ots_only_title);
  assert.equal(displayTone("ots_only"), "amber");
  const fr = localizedVerdict("ots_only", "fr", OTS_WHEN, "Europe/Paris");
  const en = localizedVerdict("ots_only", "en", OTS_WHEN, "Europe/Paris");
  assert.equal(fr, fill(FR.ots_only_sentence, { date: dateFr(OTS_WHEN) }));
  assert.equal(en, fill(EN.ots_only_sentence, { date: dateEn(OTS_WHEN) }));
  assert.doesNotMatch(fr, FORBIDDEN);
  assert.doesNotMatch(en, FORBIDDEN);
  const r = await renderCertificate(model({
    lang: "fr",
    gen_time: null,
    tsa: null,
    ots_status: "confirmed",
    ots_block_time: OTS_WHEN,
  }));
  const t = flat(r.lines);
  assert.ok(t.includes(FR.ots_only_title));
  assert.ok(!t.includes(FR.unverified_title), "must not reuse the unverified-signature title");
  assert.ok(!t.includes(loadLocale("fr").cert.title_intact));
  assertNoForbidden("FR PDF ots_only", t, pdfRaw(r.bytes));
  const enPdf = await renderCertificate(model({
    lang: "en",
    gen_time: null,
    tsa: null,
    ots_status: "confirmed",
    ots_block_time: OTS_WHEN,
  }));
  assert.ok(flat(enPdf.lines).includes(EN.ots_only_title));
  assertNoForbidden("EN PDF ots_only", flat(enPdf.lines), pdfRaw(enPdf.bytes));
});

test("state 5: no TSA token, OpenTimestamps not yet confirmed → pending label WITHOUT a date, amber", async () => {
  const v = humanVerdict(report({
    signature: null,
    provider: null,
    gen_time: WHEN, // even if a date is sitting around, the sentence must not include it
    ots: otsPending,
  }));
  assert.equal(v.kind, "ots_pending");
  assert.equal(v.glyph, "V");
  assert.equal(v.title, FR.ots_pending_title);
  assert.equal(v.sentence, FR.ots_pending_sentence);
  assert.doesNotMatch(v.sentence, /2026|novembre|November|19:08|20:08/);
  assert.equal(displayTone("ots_pending"), "amber");
  const fr = localizedVerdict("ots_pending", "fr", WHEN, "Europe/Paris");
  const en = localizedVerdict("ots_pending", "en", WHEN, "Europe/Paris");
  assert.equal(fr, FR.ots_pending_sentence);
  assert.equal(en, EN.ots_pending_sentence);
  assert.doesNotMatch(fr, /2026|novembre/);
  assert.doesNotMatch(en, /2026|November/);
  assert.doesNotMatch(fr, FORBIDDEN);
  assert.doesNotMatch(en, FORBIDDEN);
  const r = await renderCertificate(model({
    lang: "fr",
    gen_time: WHEN,
    tsa: null,
    ots_status: "pending",
  }));
  const t = flat(r.lines);
  assert.ok(t.includes(FR.ots_pending_title));
  // The pending title/sentence must not carry the token/OTS date. A technical date field on the
  // form (if any) is the document's other metadata; the verdict line itself has no date.
  const titleIdx = r.lines.findIndex((l) => l.includes("Preuve en attente") || l.includes("confirmation"));
  assert.ok(titleIdx >= 0);
  const verdictBlock = r.lines.slice(0, titleIdx + 3).join(" ");
  assert.doesNotMatch(verdictBlock, /22 novembre 2026/);
  assertNoForbidden("FR PDF ots_pending", t, pdfRaw(r.bytes));
  const enPdf = await renderCertificate(model({
    lang: "en",
    gen_time: WHEN,
    tsa: null,
    ots_status: "pending",
  }));
  assert.ok(flat(enPdf.lines).includes(EN.ots_pending_title));
  assertNoForbidden("EN PDF ots_pending", flat(enPdf.lines), pdfRaw(enPdf.bytes));
});

test("V1 locales: new verdict strings live in FR and EN only; 22 others fall back to English", () => {
  for (const k of FR_EN_ONLY_CERT_KEYS) {
    assert.ok(loadLocale("fr").cert[k], `fr missing ${k}`);
    assert.ok(loadLocale("en").cert[k], `en missing ${k}`);
  }
  assert.equal(loadLocale("fr").cert.title_signature_unverified, FR.unverified_title);
  assert.equal(loadLocale("en").cert.title_signature_unverified, EN.unverified_title);
  assert.equal(loadLocale("fr").cert.verdict_signature_unverified, FR.unverified_sentence);
  assert.equal(loadLocale("en").cert.verdict_signature_unverified, EN.unverified_sentence);
  for (const lang of EU_LANGS) {
    if (lang === "fr" || lang === "en") continue;
    const own = loadLocale(lang);
    // Runtime fallback: English wording (existing i18n rule), not a homemade translation.
    for (const k of FR_EN_ONLY_CERT_KEYS) {
      assert.equal(own.cert[k], loadLocale("en").cert[k], `${lang} should fall back to EN for ${k}`);
    }
    const raw = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "locales", `${lang}.json`), "utf8")) as { cert: Record<string, string> };
    for (const k of FR_EN_ONLY_CERT_KEYS) {
      assert.equal(raw.cert[k], undefined, `${lang}.json must omit ${k} so loadLocale falls back to EN`);
    }
  }
});


test("all 5 states: PDF header, title and subject are Rapport de vérification / Verification report — no certificate word in metadata", async () => {
  assert.equal(loadLocale("fr").cert.document_title, DOC_TITLE_FR);
  assert.equal(loadLocale("en").cert.document_title, DOC_TITLE_EN);
  for (const lang of ["fr", "en"] as const) {
    const expected = lang === "fr" ? DOC_TITLE_FR : DOC_TITLE_EN;
    for (const { name, model: m } of fiveStateModels(lang)) {
      const r = await renderCertificate(m);
      const joined = flat(r.lines);
      assert.ok(joined.includes(expected), `${lang} ${name}: visible title missing in: ${joined.slice(0, 200)}`);
      const meta = await pdfMeta(r.bytes);
      assert.equal(meta.title, expected, `${lang} ${name} PDF title`);
      assert.equal(meta.subject, expected, `${lang} ${name} PDF subject`);
      assert.doesNotMatch(meta.title, PUBLIC_CERT_WORD, `${lang} ${name} title`);
      assert.doesNotMatch(meta.subject, PUBLIC_CERT_WORD, `${lang} ${name} subject`);
    }
  }
});

test("PDF filename is rapport-de-verification.pdf (FR) or verification-report-{lang}.pdf", async () => {
  const fake = await startFakeTsa();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-a6-pdf-name-"));
  try {
    const vault = path.join(base, "vault");
    await fs.mkdir(vault);
    await fs.writeFile(path.join(vault, "Acte.md"), "# Acte\n");
    const tsa = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "custom", XVCACHE_TSA_URL: fake.url, XVCACHE_TSA_CA_FILE: fake.caFile }) as TsaProvider;
    const c = new Certifier(certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: path.join(base, "j.jsonl"), tsa }, { XVCACHE_OTS: "off" }));
    const fr = await handleDocument(c, { path: "Acte.md", stamp: true, lang: "fr" });
    assert.equal(fr.glyph, "V", fr.error);
    assert.ok(fr.pdf?.endsWith("rapport-de-verification.pdf"), `FR pdf: ${fr.pdf}`);
    const en = await handleDocument(c, { path: "Acte.md", stamp: false, lang: "en" });
    assert.ok(en.pdf?.endsWith("verification-report-en.pdf"), `EN pdf: ${en.pdf}`);
    const de = await handleDocument(c, { path: "Acte.md", stamp: false, lang: "de" });
    assert.ok(de.pdf?.endsWith("verification-report-de.pdf"), `DE pdf: ${de.pdf}`);
  } finally {
    await fake.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

const CERT_IN_PUBLIC_DESC = /\b(certificat|certificats|certificate|certificates)\b/i;

test("hosted: get_verification_report is an alias of get_report_pdf; get_certificate_pdf description has no certificate word", async () => {
  const fake = await startFakeTsa();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-a6-alias-"));
  const store = new SubscriptionStore(path.join(tmp, "subscriptions.json"));
  const witness = new HostedWitness({
    dataDir: tmp,
    tsa: { id: "certigna", label: "Certigna (test)", url: fake.url, qualified: true, qualifiedBasis: "test", caFile: fake.caFile },
    ots: { enabled: false, calendars: [] },
    batchWindowMs: 200,
    fetchImpl: undefined,
    onAlert: () => {},
  });
  const srv = await startRemoteServer({ store, witness, dataDir: tmp, port: 0 });
  try {
    const listed = async (apiKey?: string) => {
      const c = new Client({ name: "a6-alias", version: "0" });
      const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers } }));
      return c;
    };
    const anon = await listed();
    const names = (await anon.listTools()).tools.map((t) => t.name);
    for (const n of ["get_report_pdf", "get_certificate_pdf", "get_verification_report"]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const tools = (await anon.listTools()).tools;
    for (const n of ["get_report_pdf", "get_certificate_pdf", "get_verification_report"]) {
      const desc = tools.find((x) => x.name === n)?.description ?? "";
      assert.doesNotMatch(desc, CERT_IN_PUBLIC_DESC, `${n} description: ${desc}`);
    }
    const unauth = await anon.callTool({ name: "get_verification_report", arguments: { proof_id: "xvh_aaaaaaaaaaaaaaaaaaaaaa" } });
    assert.equal(unauth.isError, true);
    const unauthBody = JSON.parse((unauth.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "{}");
    assert.equal(unauthBody.code, "PAYMENT_REQUIRED");
    await anon.close();

    const { api_key } = await store.createApiKey({ plan_id: "coffre-horodate", quota: null, status: "active", default_lang: "fr" });
    const c = await listed(api_key);
    const cert = await c.callTool({ name: "certify_hash", arguments: { items: [{ sha256: "ab".repeat(32), label: "Acte" }] } });
    const certBody = JSON.parse((cert.content as { type: string; text?: string }[]).find((x) => x.type === "text")?.text ?? "{}");
    const proofId = certBody.results[0].proof_id as string;
    const a = await c.callTool({ name: "get_report_pdf", arguments: { proof_id: proofId, lang: "fr" } });
    const b = await c.callTool({ name: "get_verification_report", arguments: { proof_id: proofId, lang: "fr" } });
    const cAlias = await c.callTool({ name: "get_certificate_pdf", arguments: { proof_id: proofId, lang: "fr" } });
    assert.equal(a.isError, undefined);
    assert.equal(b.isError, undefined);
    assert.equal(cAlias.isError, undefined);
    const ba = JSON.parse((a.content as { type: string; text?: string }[]).find((x) => x.type === "text")?.text ?? "{}");
    const bb = JSON.parse((b.content as { type: string; text?: string }[]).find((x) => x.type === "text")?.text ?? "{}");
    assert.equal(ba.ok, true);
    assert.equal(bb.ok, true);
    assert.equal(bb.proof_id, ba.proof_id);
    await c.close();
  } finally {
    await srv.close();
    await fake.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("local: get_verification_report is listed and shares the same access as get_report_pdf", async () => {
  const vault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test-vault");
  const fake = await startFakeTsa();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-a6-local-"));
  const logFile = path.join(dataDir, "journal.jsonl");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: {
      ...process.env,
      XVCACHE_VAULT: vault,
      XVCACHE_LOG: logFile,
      XVCACHE_DATA: dataDir,
      XVCACHE_TSA_PROVIDER: "custom",
      XVCACHE_TSA_URL: fake.url,
      XVCACHE_TSA_CA_FILE: fake.caFile,
      XVCACHE_OTS: "off",
    } as Record<string, string>,
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  });
  const c = new Client({ name: "a6-local", version: "0.3.0" });
  try {
    await c.connect(transport);
    const tools = (await c.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["get_report_pdf", "get_certificate_pdf", "get_verification_report"]) {
      assert.ok(names.includes(n), `local missing ${n}: ${names.join(", ")}`);
    }
    for (const n of ["get_report_pdf", "get_certificate_pdf", "get_verification_report"]) {
      const desc = tools.find((x) => x.name === n)?.description ?? "";
      assert.doesNotMatch(desc, CERT_IN_PUBLIC_DESC, `local ${n}: ${desc}`);
    }
    const missing = await c.callTool({ name: "get_verification_report", arguments: { proof_id: "nope.0" } });
    const missingReport = await c.callTool({ name: "get_report_pdf", arguments: { proof_id: "nope.0" } });
    assert.equal(missing.isError, true);
    assert.equal(missingReport.isError, true);
  } finally {
    await c.close().catch(() => {});
    await fake.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
