import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Certifier, certifyConfigFromEnv, type Proof } from "./certify.js";
import { resolveTsaProvider, CERTIGNA_QUALIFIED_POLICY_OID, type TsaProvider } from "./tsa.js";
import { JournalWriter, sha256Hex } from "./journal.js";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";
import {
  formatParisDateTime,
  formatGroupedHex,
  otsHuman,
  humanVerdict,
  handleDocument,
  writeCertificatePack,
  type DocumentResult,
} from "./certificate.js";
import type { VerifyReport } from "./certify.js";
import { inflateSync } from "node:zlib";

/**
 * Inflate FlateDecode streams so tests can assert on visible PDF strings.
 * Embedded (Identity-H) fonts draw glyph ids: decode them through each ToUnicode CMap.
 */
function pdfText(buf: Buffer): string {
  const chunks = [buf.toString("latin1")];
  const raw = buf.toString("binary");
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  const inflated: string[] = [];
  while ((m = re.exec(raw))) {
    try { inflated.push(inflateSync(Buffer.from(m[1], "binary")).toString("latin1")); }
    catch { /* not a flate stream */ }
  }
  chunks.push(...inflated);
  const all = chunks.join("\n");
  const decoded: string[] = [all];
  for (const hex of all.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    try { decoded.push(Buffer.from(hex[1].replace(/\s+/g, ""), "hex").toString("latin1")); }
    catch { /* ignore */ }
  }
  const cmaps: Map<number, string>[] = [];
  for (const s of inflated) {
    if (!s.includes("begincmap")) continue;
    const map = new Map<number, string>();
    const u16 = (h: string) => Buffer.from(h, "hex").swap16().toString("utf16le");
    for (const b of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const e of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(e[1], 16), u16(e[2]));
    }
    for (const b of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const e of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(e[1], 16), hi = parseInt(e[2], 16), base = parseInt(e[3], 16);
        for (let g = lo; g <= hi; g++) map.set(g, String.fromCodePoint(base + g - lo));
      }
    }
    cmaps.push(map);
  }
  const hexes = [...all.matchAll(/<([0-9A-Fa-f]{4,})>\s*Tj/g)].map((h) => h[1]);
  for (const map of cmaps) {
    for (const h of hexes) {
      let out = "";
      for (let i = 0; i + 4 <= h.length; i += 4) out += map.get(parseInt(h.slice(i, i + 4), 16)) ?? "";
      decoded.push(out);
    }
  }
  return decoded.join("\n");
}


let fake: FakeTsa;
let tmp: string;

before(async () => {
  fake = await startFakeTsa();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-cert-test-"));
});
after(async () => {
  await fake.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function setup(name: string): Promise<{ c: Certifier; vault: string; journal: string }> {
  const base = path.join(tmp, name);
  const vault = path.join(base, "vault");
  await fs.mkdir(vault, { recursive: true });
  const journal = path.join(base, "journal.jsonl");
  const tsa = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "custom", XVCACHE_TSA_URL: fake.url, XVCACHE_TSA_CA_FILE: fake.caFile }) as TsaProvider;
  const cfg = certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: journal, tsa }, { XVCACHE_OTS: "off" });
  return { c: new Certifier(cfg), vault, journal };
}

const SECRET = "CONTENU-CONFIDENTIEL-NE-DOIT-PAS-FUIR";

function emptyReport(over: Partial<VerifyReport> & { glyph: "V" | "X" }): VerifyReport {
  return {
    message: "",
    path: "Note.md",
    batch_id: "b",
    root: "0".repeat(64),
    gen_time: "2026-11-22T19:08:39.000Z",
    provider: "certigna",
    qualified: true,
    qualified_confirmed: true,
    signature: "verified",
    qualification: null,
    checks: {},
    ots: null,
    ...over,
  };
}

test("Paris time, fingerprint grouping, OTS wording, human V/X", () => {
  const t = formatParisDateTime("2026-11-22T19:08:39.000Z");
  assert.equal(t.short, "22 novembre 2026 à 20\u00a0h\u00a008");
  assert.equal(t.long, "22 novembre 2026 à 20\u00a0h\u00a008 min\u00a039\u00a0s");
  assert.equal(t.tz, "heure de Paris");
  assert.equal(formatGroupedHex("28166173085740a1"), "2816 6173 0857 40a1");
  assert.match(otsHuman("pending"), /attente de confirmation/i);
  const v = humanVerdict(emptyReport({ glyph: "V" }));
  assert.equal(v.kind, "intact");
  assert.match(v.sentence, /Intact/);
  assert.match(v.sentence, /22 novembre 2026 à 20/);
  assert.match(v.sentence, /heure de Paris/);
  const x = humanVerdict(emptyReport({ glyph: "X", checks: { note: { ok: false, detail: "modifiée" } } }));
  assert.equal(x.kind, "modifie");
  assert.equal(x.sentence, "Modifié depuis le 22 novembre 2026 à 20\u00a0h\u00a008 (heure de Paris).");
});

test("handleDocument writes a one-page PDF on V, no secret, FreeTSA-style warning, attachments; reuse spends no token; tamper is X without PDF", async () => {
  const { c, vault, journal } = await setup("pdf");
  const jw = new JournalWriter(journal);
  const text = `# Devis\n${SECRET}\n`;
  await fs.writeFile(path.join(vault, "Devis.md"), text);
  await jw.append({ tool: "write_note", args: { path: "Devis.md", mode: "create" }, client: "test", result: "ok", note_sha256: sha256Hex(text) });

  const first = await handleDocument(c, { path: "Devis.md", stamp: true, online: false });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.glyph, "V");
  assert.equal(first.stamped, true);
  assert.ok(first.pdf && existsSync(first.pdf));
  assert.equal(first.qualified, false);
  const pdf = await fs.readFile(first.pdf!);
  assert.ok(pdf.subarray(0, 5).toString() === "%PDF-");
  const raw = pdfText(pdf);
  assert.ok(!raw.includes(SECRET), "note content leaked into the PDF");
  assert.match(raw, /XVcache/);
  assert.match(raw, /Devis\.md/);
  assert.match(raw, /PAS un horodatage qualifi/);
  assert.match(raw, /huissier/);
  assert.match(raw, /SHA-256/);
  assert.ok(first.attachments && first.attachments.some((a) => a.name === "jeton.tst"));
  assert.ok(first.attachments!.some((a) => a.name === "chemin-de-preuve.json"));
  for (const a of first.attachments ?? []) assert.ok(existsSync(a.path));

  const before = fake.requests;
  const again = await handleDocument(c, { path: "Devis.md", stamp: true, online: false });
  assert.equal(again.ok, true);
  assert.equal(again.glyph, "V");
  assert.equal(again.stamped, false, "existing intact proof must be reused");
  assert.equal(fake.requests, before, "reusing a proof must not spend a timestamp");

  await fs.appendFile(path.join(vault, "Devis.md"), "changement\n");
  const changed = await handleDocument(c, { path: "Devis.md", stamp: true, online: false });
  assert.equal(changed.ok, true);
  assert.equal(changed.glyph, "X");
  assert.equal(changed.verdict?.kind, "modifie");
  assert.equal(changed.pdf, null);
  assert.equal(changed.stamped, false);
  assert.equal(fake.requests, before, "a modified document must not spend a new token");
  assert.match(changed.verdict!.sentence, /Modifié depuis le /);
});

test("uploaded bytes are checked instead of the vault copy", async () => {
  const { c, vault } = await setup("upload");
  await fs.writeFile(path.join(vault, "Idee.md"), "# Idée\norigin\n");
  const r = await handleDocument(c, { path: "Idee.md", stamp: true, online: false });
  assert.equal(r.glyph, "V");
  const intact = await handleDocument(c, { filename: "Idee.md", content: Buffer.from("# Idée\norigin\n"), stamp: false, online: false });
  assert.equal(intact.glyph, "V");
  assert.ok(intact.pdf);
  const edited = await handleDocument(c, { filename: "Idee.md", content: Buffer.from("# Idée\nmodifié\n"), stamp: false, online: false });
  assert.equal(edited.glyph, "X");
  assert.equal(edited.verdict?.kind, "modifie");
  assert.equal(edited.pdf, null);
});

test("Certigna-style certificate: qualified only from the token (Certigna OID + chain + verified signature), real OID and serial; never the FreeTSA warning", async () => {
  const cg = await startFakeTsa({ policy: CERTIGNA_QUALIFIED_POLICY_OID });
  try {
    const base = path.join(tmp, "label");
    const vault = path.join(base, "vault");
    await fs.mkdir(vault, { recursive: true });
    const tsa: TsaProvider = {
      id: "certigna", label: "Certigna (horodatage qualifié eIDAS)", url: cg.url, qualified: true, qualifiedBasis: "eIDAS", caFile: cg.caFile,
      qualifiedTrust: { name: "Certigna (simulated)", policyOids: [CERTIGNA_QUALIFIED_POLICY_OID], caFile: cg.caFile },
    };
    const c = new Certifier(certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: path.join(base, "journal.jsonl"), tsa }, { XVCACHE_OTS: "off" }));
    await fs.writeFile(path.join(vault, "Acte.md"), "# Acte\n");
    await c.enqueue("Acte.md");
    const b = await c.runBatch();
    if ("error" in b) assert.fail(b.error);
    const proof = b.proofs[0];
    assert.equal(proof.tsa!.qualified, true);
    assert.equal(proof.tsa!.policy, CERTIGNA_QUALIFIED_POLICY_OID);
    const rep = await c.verify({ proof, online: false });
    assert.equal(rep.glyph, "V");
    assert.equal(rep.qualified, true);
    const pack = await writeCertificatePack({ proof, dataDir: c.cfg.dataDir, batchesDir: c.batchesDir(), otsStatus: "pending", qualification: rep.qualification });
    const raw = pdfText(await fs.readFile(pack.pdf));
    assert.match(raw, /Certigna/);
    assert.match(raw, /1\.2\.250\.1\.177\.2\.9\.1/);
    assert.match(raw, /eIDAS/);
    assert.doesNotMatch(raw, /FreeTSA/);
    assert.doesNotMatch(raw, /PAS un horodatage qualifi/);
    assert.doesNotMatch(raw, /NON QUALIFI/);
    assert.match(raw, /huissier/);
    assert.match(raw, /OpenTimestamps/i);
    // Same proof, no qualification passed: recomputed against the REAL bundled Certigna chain → not qualified.
    const pack2 = await writeCertificatePack({ proof, dataDir: path.join(c.cfg.dataDir, "again"), batchesDir: c.batchesDir() });
    const raw2 = pdfText(await fs.readFile(pack2.pdf));
    assert.match(raw2, /NON QUALIFI/);
  } finally {
    await cg.close();
  }
});

test("a proof JSON claiming qualified=true with a non-Certigna token is NOT qualified (config/JSON never decides)", async () => {
  const { c, vault } = await setup("forged");
  await fs.writeFile(path.join(vault, "Faux.md"), "# Faux\n");
  await c.enqueue("Faux.md");
  const b = await c.runBatch();
  if ("error" in b) assert.fail(b.error);
  const proof = JSON.parse(JSON.stringify(b.proofs[0])) as Proof;
  proof.tsa = { ...proof.tsa!, provider: "certigna", label: "Certigna (horodatage qualifié eIDAS)", qualified: true, policy: CERTIGNA_QUALIFIED_POLICY_OID };
  const rep = await c.verify({ proof, online: false });
  assert.equal(rep.qualified, false);
  assert.equal(rep.qualification?.status, "policy_not_qualified");
  assert.equal(rep.qualification?.policy, "1.2.3.4.99", "the OID shown is the one read in the token");
  const pack = await writeCertificatePack({ proof, dataDir: c.cfg.dataDir, batchesDir: c.batchesDir(), qualification: rep.qualification });
  const raw = pdfText(await fs.readFile(pack.pdf));
  assert.match(raw, /NON QUALIFI/);
  assert.match(raw, /1\.2\.3\.4\.99/);
  assert.doesNotMatch(raw, /1\.2\.250\.1\.177\.2\.9\.1/);
});

test("without a proof and without stamp, handleDocument refuses rather than calling the TSA", async () => {
  const { c, vault } = await setup("nostamp");
  await fs.writeFile(path.join(vault, "Seul.md"), "# Seul\n");
  const before = fake.requests;
  const r: DocumentResult = await handleDocument(c, { path: "Seul.md", stamp: false, online: false });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /pas encore été horodaté/);
  assert.equal(fake.requests, before);
});
