/**
 * A6 (Sophie's wording, FR authoritative): five distinct verdicts.
 * "Intact" only when the token signature is verified. The other four states
 * must not render Intact / certifié / certificat / certified / certificate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EU_LANGS, loadLocale, fill, formatLocalDateTime, FR_EN_ONLY_CERT_KEYS } from "./i18n.js";
import {
  humanVerdict,
  localizedVerdict,
  renderCertificate,
  displayTone,
  type CertificateModel,
} from "./certificate.js";
import type { VerifyReport } from "./certify.js";
import type { OtsStatus } from "./ots.js";

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
  ots_pending_sentence: "Ce document a la même empreinte. La preuve OpenTimestamps n'est pas encore confirmée sur la blockchain Bitcoin. Aucun jeton d'horodatage n'est joint.",
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
  ots_pending_sentence: "This document has the same fingerprint. The OpenTimestamps proof is not yet confirmed on the Bitcoin blockchain. No timestamp token is attached.",
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
