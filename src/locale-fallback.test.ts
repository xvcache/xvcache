/**
 * V1: the npm package ships only en.json and fr.json. A requested EU language
 * whose file is absent must not throw, and the PDF must come out in English.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLocale, localesDir, setLocalesDirForTests } from "./i18n.js";
import { renderCertificate, type CertificateModel } from "./certificate.js";

const repoLocales = localesDir();

after(() => { setLocalesDirForTests(undefined); });

function model(lang: string): CertificateModel {
  return {
    lang,
    tz: "Europe/Paris",
    label: "Acte.md",
    sha256: "ab".repeat(32),
    gen_time: "2026-11-22T19:08:39.000Z",
    verdict: "V",
    tsa: { provider: "qualified", label: "x", qualified: true, policy: "1.2.250.1.177.2.9.1", serial: "ab", signature: "verified" },
    ots_status: "confirmed",
    attachments: [],
  };
}

function flat(lines: { text: string }[]): string {
  return lines.map((l) => l.text).join("\n");
}

test("missing EU locale file: loadLocale does not throw and falls back to English", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-locales-"));
  try {
    await fs.copyFile(path.join(repoLocales, "en.json"), path.join(tmp, "en.json"));
    await fs.copyFile(path.join(repoLocales, "fr.json"), path.join(tmp, "fr.json"));
    setLocalesDirForTests(tmp);
    const de = loadLocale("de");
    assert.equal(de.lang, "en");
    assert.equal(de.cert.legal_not_certificate, loadLocale("en").cert.legal_not_certificate);
    const it = loadLocale("it");
    assert.equal(it.lang, "en");
    const fr = loadLocale("fr");
    assert.equal(fr.lang, "fr");
    assert.match(fr.cert.legal_not_certificate, /n'est pas un certificat/);
  } finally {
    setLocalesDirForTests(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("PDF requested in German with no de.json is English, one page, no throw", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-locales-pdf-"));
  try {
    await fs.copyFile(path.join(repoLocales, "en.json"), path.join(tmp, "en.json"));
    await fs.copyFile(path.join(repoLocales, "fr.json"), path.join(tmp, "fr.json"));
    setLocalesDirForTests(tmp);
    const r = await renderCertificate(model("de"));
    const text = r.lines.join("\n");
    assert.match(text, /This verification report is not a certificate/);
    assert.doesNotMatch(text, /Ce rapport de vérification n'est pas un certificat/);
    assert.ok(r.bytes.length > 100);
  } finally {
    setLocalesDirForTests(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

