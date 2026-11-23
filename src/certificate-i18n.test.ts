import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { EU_LANGS, loadLocale, resolveLang, formatLocalDateTime, FR_EN_ONLY_CERT_KEYS } from "./i18n.js";
import { renderCertificate, localizedVerdict, type CertificateModel } from "./certificate.js";

const SNAP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "snapshots", "certificate");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function model(lang: string, over: Partial<CertificateModel> = {}): CertificateModel {
  return {
    lang,
    tz: "Europe/Brussels",
    kind: "timestamp",
    verdict: "V",
    label: "Contrat-de-cession-2026-11.pdf",
    sha256: SHA,
    gen_time: "2026-11-22T19:08:39.000Z",
    tsa: { provider: "certigna", label: "Certigna (horodatage qualifié eIDAS)", qualified: true, policy: "1.2.250.1.177.2.9.1", serial: "28166173085740a1b113a8edcb465c87", signature: "verified" },
    ots_status: "pending",
    proof_id: "20261122T190839000Z-1a2b3c4d.0",
    attachments: [
      { name: "token.tst", description: "RFC 3161", bytes: new Uint8Array([1, 2, 3]) },
      { name: "merkle-path.json", description: "Merkle", bytes: new Uint8Array([123, 125]) },
    ],
    fixed_date: "2026-11-22T19:08:39.000Z",
    ...over,
  };
}

test("i18n: 24 EU languages, every locale has every English key, unknown → en", () => {
  assert.equal(EU_LANGS.length, 24);
  const en = loadLocale("en");
  for (const code of EU_LANGS) {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "locales", `${code}.json`);
    assert.ok(existsSync(file), `locales/${code}.json missing`);
    const own = JSON.parse(readFileSync(file, "utf8")) as { cert: Record<string, string> };
    const frEnOnly = new Set<string>(FR_EN_ONLY_CERT_KEYS);
    for (const k of Object.keys(en.cert)) {
      if (frEnOnly.has(k) && code !== "en" && code !== "fr") {
        assert.equal(own.cert[k], undefined, `${code}: cert.${k} must be omitted (V1 falls back to English)`);
        continue;
      }
      assert.ok(typeof own.cert[k] === "string" && own.cert[k].length > 0, `${code}: cert.${k} missing`);
    }
  }
  assert.deepEqual(resolveLang("de-AT"), { lang: "de", requested: "de-AT", fallback: false });
  assert.deepEqual(resolveLang("ja"), { lang: "en", requested: "ja", fallback: true });
  assert.equal(resolveLang(undefined).lang, "en");
  const t = formatLocalDateTime("2026-11-22T19:08:39.000Z", "en");
  assert.equal(t.tz, "Europe/Brussels");
  assert.match(t.utc, /19:08:39/);
  assert.match(t.local, /20:08:39/);
});


for (const lang of EU_LANGS) {
  test(`PDF ${lang}: one page, no overflow, no missing glyph, snapshot`, async () => {
    const r = await renderCertificate(model(lang));
    assert.equal(r.lang, lang);
    assert.equal(r.pages, 1);
    assert.equal(r.overflow, false, `${lang} overflows the page`);
    assert.deepEqual(r.missing_glyphs, [], `${lang} missing glyphs`);
    const doc = await PDFDocument.load(r.bytes);
    assert.equal(doc.getPageCount(), 1);
    const L = loadLocale(lang).cert;
    const text = r.lines.join("\n");
    assert.ok(text.includes(L.title_intact), "localized title");
    assert.ok(r.lines.some((l) => l.includes("1.2.250.1.177.2.9.1")), "Certigna policy OID");
    assert.ok(text.includes("Art. 41") || text.includes("art. 41") || text.includes("41"), "eIDAS art. 41");
    const reviewed = (JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "locales", `${lang}.json`), "utf8")) as { reviewed?: boolean }).reviewed === true;
    if (lang !== "en" && !reviewed) {
      assert.ok(text.replace(/\n/g, " ").includes("English version prevails"), "English fallback notice");
      assert.ok(text.replace(/\n/g, " ").includes("Regulation (EU) No 910/2014"), "English legal paragraph");
    }
    if (lang !== "en" && reviewed) assert.ok(!text.replace(/\n/g, " ").includes("English version prevails"), "reviewed locale: no fallback notice");
    assert.ok(!text.includes(L.banner_not_qualified), "qualified PDF must not carry the NOT QUALIFIED banner");

    const snapFile = path.join(SNAP_DIR, `${lang}.txt`);
    const snap = r.lines.join("\n") + "\n";
    if (UPDATE || !existsSync(snapFile)) {
      await fs.mkdir(SNAP_DIR, { recursive: true });
      await fs.writeFile(snapFile, snap, "utf8");
    } else {
      assert.equal(snap, await fs.readFile(snapFile, "utf8"), `snapshot ${lang} changed (UPDATE_SNAPSHOTS=1 to accept)`);
    }
  });
}

test("worst case in every language (pending Certigna token, 120-char label, X verdict) still fits one page with the NOT QUALIFIED banner", async () => {
  for (const lang of EU_LANGS) {
    const L = loadLocale(lang).cert;
    for (const over of [
      { verdict: "pending" as const, pending_qualified: true, tsa: null, gen_time: null, label: "D".repeat(120) },
      { verdict: "X" as const, kind: "verification" as const, tsa: { provider: "freetsa", label: "FreeTSA (test)", qualified: false, serial: "abcd" }, label: "Ä".repeat(120) },
      { verdict: "V" as const, kind: "verification" as const, tsa: { provider: "certigna", label: "Certigna", qualified: false, policy: "1.2.250.1.177.2.9.1", serial: "abcd", signature: "unavailable" as const }, label: "D".repeat(120) },
    ]) {
      const r = await renderCertificate(model(lang, over));
      assert.equal(r.pages, 1, lang);
      assert.equal(r.overflow, false, `${lang} overflow (${over.verdict})`);
      assert.deepEqual(r.missing_glyphs, [], lang);
      const text = r.lines.join("\n");
      assert.ok(text.includes(L.banner_not_qualified), `${lang}: NOT QUALIFIED banner missing`);
      assert.ok(!text.includes(L.provider_qualified), `${lang}: must not claim a qualified timestamp`);
    }
  }
});

test("localized verdict sentences carry UTC and local time", () => {
  const de = localizedVerdict("modifie", "de", "2026-11-22T19:08:39.000Z");
  assert.match(de, /^Geändert seit /);
  assert.match(de, /UTC/);
  assert.match(localizedVerdict("intact", "el", "2026-11-22T19:08:39.000Z"), /Αναλλοίωτο/);
  assert.equal(localizedVerdict("pending", "xx", null), loadLocale("en").cert.verdict_pending);
});

import os from "node:os";
import { Certifier, certifyConfigFromEnv } from "./certify.js";
import { resolveTsaProvider, type TsaProvider } from "./tsa.js";
import { startFakeTsa } from "./test-tsa.js";
import { handleDocument, reissueCertificate } from "./certificate.js";

test("certify_document in German, then get_certificate_pdf in Greek: same proof, no new token; modified note → X, no PDF", async () => {
  const fake = await startFakeTsa();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-i18n-"));
  try {
    const vault = path.join(base, "vault");
    await fs.mkdir(vault);
    await fs.writeFile(path.join(vault, "Vertrag.md"), "# Vertrag\n");
    const tsa = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "custom", XVCACHE_TSA_URL: fake.url, XVCACHE_TSA_CA_FILE: fake.caFile }) as TsaProvider;
    const c = new Certifier(certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: path.join(base, "j.jsonl"), tsa }, { XVCACHE_OTS: "off" }));
    const de = await handleDocument(c, { path: "Vertrag.md", stamp: true, lang: "de" });
    assert.equal(de.glyph, "V", de.error);
    assert.equal(de.lang, "de");
    assert.match(de.verdict_localized ?? "", /^Unverändert/);
    assert.ok(de.pdf?.endsWith("verification-report-de.pdf"));
    assert.ok(de.proof_id);
    const tokens = fake.requests;

    const el = await reissueCertificate(c, { proof_id: de.proof_id!, lang: "el" });
    assert.equal(el.ok, true, el.error);
    assert.equal(el.glyph, "V");
    assert.ok(el.pdf?.endsWith("verification-report-el.pdf") && existsSync(el.pdf));
    assert.match(el.verdict_localized ?? "", /Αναλλοίωτο/);
    assert.equal(fake.requests, tokens, "reissuing must not spend a token");

    const none = await reissueCertificate(c, { proof_id: "nope.0", lang: "fr" });
    assert.equal(none.ok, false);
    assert.match(none.error ?? "", /PROOF_NOT_FOUND/);

    await fs.appendFile(path.join(vault, "Vertrag.md"), "geändert\n");
    const x = await reissueCertificate(c, { proof_id: de.proof_id!, lang: "pl" });
    assert.equal(x.glyph, "X");
    assert.equal(x.pdf, null);
    assert.match(x.verdict_localized ?? "", /^Zmieniony od/);
    assert.equal(fake.requests, tokens);
  } finally {
    await fake.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
