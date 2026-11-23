/**
 * A6: "Intact" is only shown when the fingerprint matches AND the token
 * signature is verified. Glyph V is unchanged when the fingerprint matches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EU_LANGS, loadLocale, fill, formatLocalDateTime } from "./i18n.js";
import {
  humanVerdict,
  localizedVerdict,
  renderCertificate,
  type CertificateModel,
  type HumanVerdict,
} from "./certificate.js";
import type { VerifyReport } from "./certify.js";

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    glyph: "V",
    message: "V  certifiée — Note Acte.md existait telle quelle.",
    path: "Acte.md",
    batch_id: "batch",
    root: "0".repeat(64),
    gen_time: "2026-11-22T19:08:39.000Z",
    provider: "certigna",
    qualified: false,
    qualified_confirmed: false,
    signature: "unavailable",
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
    gen_time: "2026-11-22T19:08:39.000Z",
    tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "unavailable" },
    attachments: [],
    ...over,
  };
}

const FR_TITLE = "Empreinte conforme — signature non vérifiée";
const EN_TITLE = "Fingerprint matches — signature not verified";

test("A6: Intact only when V and signature verified; otherwise a distinct honest label, glyph still V", () => {
  const intact = humanVerdict(report({ signature: "verified", qualified: true, qualified_confirmed: true }));
  assert.equal(intact.glyph, "V");
  assert.equal(intact.kind, "intact");
  assert.equal(intact.title, "Intact");
  assert.match(intact.sentence, /^Intact — /);

  const cases: Array<VerifyReport["signature"]> = ["unavailable", "failed", null];
  for (const signature of cases) {
    const v = humanVerdict(report({ signature }));
    assert.equal(v.glyph, "V", `glyph stays V when fingerprint matches (signature=${signature})`);
    assert.equal(v.kind, "signature_unverified");
    assert.equal(v.title, FR_TITLE);
    assert.match(v.sentence, /Empreinte conforme — signature non vérifiée/);
    assert.doesNotMatch(v.sentence, /^Intact\b/);
    assert.doesNotMatch(v.title, /Intact/i);
  }

  const x: HumanVerdict = humanVerdict(report({
    glyph: "X",
    signature: "unavailable",
    checks: { note: { ok: false, detail: "modifiée" } },
  }));
  assert.equal(x.glyph, "X");
  assert.equal(x.kind, "modifie");
  assert.equal(x.sentence, "Modifié depuis le 22 novembre 2026 à 20\u00a0h\u00a008 (heure de Paris).");
  assert.doesNotMatch(x.sentence, /Empreinte conforme/);
});

test("A6: localized FR/EN sentences, and every locale has the new keys", () => {
  const when = "2026-11-22T19:08:39.000Z";
  const fr = localizedVerdict("signature_unverified", "fr", when, "Europe/Paris");
  const en = localizedVerdict("signature_unverified", "en", when, "Europe/Paris");
  const frDate = formatLocalDateTime(when, "fr", "Europe/Paris");
  const enDate = formatLocalDateTime(when, "en", "Europe/Paris");
  const dateFr = `${frDate.local} (${frDate.tz}) — ${frDate.utc} UTC`;
  const dateEn = `${enDate.local} (${enDate.tz}) — ${enDate.utc} UTC`;
  assert.equal(fr, fill(loadLocale("fr").cert.verdict_signature_unverified, { date: dateFr }));
  assert.equal(en, fill(loadLocale("en").cert.verdict_signature_unverified, { date: dateEn }));
  assert.equal(loadLocale("fr").cert.title_signature_unverified, FR_TITLE);
  assert.equal(loadLocale("en").cert.title_signature_unverified, EN_TITLE);
  assert.match(fr, /Empreinte conforme — signature non vérifiée/);
  assert.doesNotMatch(fr, /^Intact\b/);
  assert.match(en, /Fingerprint matches — signature not verified/);
  assert.doesNotMatch(en, /^Intact\b/);
  assert.equal(localizedVerdict("intact", "fr", when, "Europe/Paris").startsWith("Intact — "), true);
  assert.equal(localizedVerdict("modifie", "fr", when, "Europe/Paris").startsWith("Modifié depuis "), true);

  for (const lang of EU_LANGS) {
    const L = loadLocale(lang).cert;
    for (const k of ["title_signature_unverified", "subtitle_signature_unverified", "verdict_signature_unverified"] as const) {
      assert.ok(typeof L[k] === "string" && L[k].length > 0, `${lang}: ${k} missing`);
      assert.doesNotMatch(L[k], /^Intact\b/);
      assert.doesNotMatch(L.title_signature_unverified, /Document intact/i);
    }
    assert.match(L.verdict_signature_unverified, /\{date\}/);
  }
});

test("A6: PDF title is not Intact when the signature is unverified (fr + en); X and verified V unchanged", async () => {
  for (const lang of ["fr", "en"] as const) {
    const r = await renderCertificate(model({ lang }));
    const t = r.lines.join(" ").replace(/\s+/g, " ");
    const L = loadLocale(lang).cert;
    assert.ok(t.includes(L.title_signature_unverified), `${lang} missing new title: ${t.slice(0, 400)}`);
    assert.ok(t.includes(L.subtitle_signature_unverified), `${lang} missing new subtitle`);
    assert.ok(!t.includes(L.title_intact), `${lang} still shows Intact title`);
    assert.ok(!t.includes(L.subtitle_intact), `${lang} still shows Intact subtitle`);
    assert.match(t, lang === "fr" ? /NON QUALIFIÉ/ : /NOT QUALIFIED/);
    assert.ok(r.lines.includes("V"), "badge stays V");
    assert.equal(r.pages, 1);
    assert.equal(r.overflow, false);
  }

  const ok = await renderCertificate(model({
    lang: "fr",
    tsa: { provider: "certigna", label: "Certigna", qualified: true, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "verified" },
  }));
  const okText = ok.lines.join(" ").replace(/\s+/g, " ");
  assert.ok(okText.includes(loadLocale("fr").cert.title_intact));
  assert.ok(!okText.includes(FR_TITLE));

  const x = await renderCertificate(model({
    lang: "fr",
    verdict: "X",
    tsa: { provider: "freetsa", label: "FreeTSA", qualified: false, signature: "verified" },
  }));
  const xText = x.lines.join(" ").replace(/\s+/g, " ");
  assert.ok(xText.includes(loadLocale("fr").cert.title_modified));
  assert.ok(!xText.includes(FR_TITLE));
  assert.ok(!xText.includes(loadLocale("fr").cert.title_intact));
});
