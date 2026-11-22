import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Certifier, certifyConfigFromEnv, type Proof } from "./certify.js";
import { resolveTsaProvider, type TsaProvider } from "./tsa.js";
import { JournalWriter, sha256Hex } from "./journal.js";
import { startFakeTsa, type FakeTsa } from "./test-tsa.js";

let fake: FakeTsa;
let tmp: string;

before(async () => {
  fake = await startFakeTsa();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-certify-test-"));
});
after(async () => {
  await fake.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function setup(name: string): Promise<{ c: Certifier; vault: string; journal: string }> {
  const base = path.join(tmp, name);
  const vault = path.join(base, "vault");
  await fs.mkdir(path.join(vault, "Dossier"), { recursive: true });
  const journal = path.join(base, "journal.jsonl");
  const tsa = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "custom", XVCACHE_TSA_URL: fake.url, XVCACHE_TSA_CA_FILE: fake.caFile }) as TsaProvider;
  const cfg = certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: journal, tsa }, { XVCACHE_OTS: "off" });
  return { c: new Certifier(cfg), vault, journal };
}

const SECRET_MARK = "CONTENU-CONFIDENTIEL-NE-DOIT-PAS-FUIR";

test("provider selection: FreeTSA by default (not qualified), Certigna needs credentials, never hardcoded", () => {
  const def = resolveTsaProvider({}) as TsaProvider;
  assert.equal(def.id, "freetsa");
  assert.equal(def.qualified, false);
  assert.match(def.label, /test, non qualifié/);
  const missing = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "certigna" });
  assert.ok(missing && "error" in missing);
  const cg = resolveTsaProvider({ XVCACHE_TSA_USER: "u", XVCACHE_TSA_PASSWORD: "p" }) as TsaProvider;
  assert.equal(cg.id, "certigna");
  assert.equal(cg.qualified, true);
  assert.equal(cg.url, "https://timestamp.dhimyotis.com/api/v1/");
  assert.equal(resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "off" }), null);
  const custom = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "custom", XVCACHE_TSA_URL: "http://x" }) as TsaProvider;
  assert.equal(custom.qualified, false);
});

test("certify 3 notes with ONE timestamp, verify V, tamper -> X; no content in proofs", async () => {
  const { c, vault, journal } = await setup("batch");
  const jw = new JournalWriter(journal);
  for (const n of ["Un", "Deux", "Dossier/Trois"]) {
    const text = `# ${n}\n${SECRET_MARK}\n`;
    await fs.writeFile(path.join(vault, `${n}.md`), text);
    await jw.append({ tool: "write_note", args: { path: `${n}.md`, mode: "create" }, client: "test", result: "ok", note_sha256: sha256Hex(text) });
  }
  for (const n of ["Un.md", "Deux", "Dossier/Trois.md"]) {
    const q = await c.enqueue(n);
    assert.ok(!("error" in q));
    if (!("error" in q)) assert.equal(q.journal_status, "V");
  }
  const before = fake.requests;
  const b = await c.runBatch();
  assert.ok(!("error" in b), JSON.stringify(b));
  if ("error" in b) return;
  assert.equal(fake.requests - before, 1, "one TSA request for the whole batch");
  assert.equal(b.proofs.length, 3);
  assert.equal(b.leaf_count, 4, "3 notes + journal head");
  const roots = new Set(b.proofs.map((p) => p.merkle.root));
  assert.equal(roots.size, 1);
  assert.equal(new Set(b.proofs.map((p) => p.tsa!.token_base64)).size, 1);
  assert.ok(b.proofs[0].journal_head);
  assert.equal(b.proofs[0].tsa!.qualified, false);
  assert.equal((await c.pending()).length, 0);

  // proofs and batch files contain hashes only
  const all: string[] = [];
  async function walk(d: string) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f); else all.push(await fs.readFile(f, "latin1"));
    }
  }
  await walk(c.cfg.dataDir);
  assert.ok(all.length >= 5);
  for (const t of all) assert.ok(!t.includes(SECRET_MARK), "note content leaked into .xvcache");

  for (const n of ["Un.md", "Deux.md", "Dossier/Trois.md"]) {
    const r = await c.verify({ path: n, online: false });
    assert.equal(r.glyph, "V", r.message + JSON.stringify(r.checks));
    assert.equal(r.checks.tsa_signature.ok, true);
  }

  // tamper one note -> X for that note only
  await fs.appendFile(path.join(vault, "Deux.md"), "ajout hors XVcache\n");
  const x = await c.verify({ path: "Deux.md", online: false });
  assert.equal(x.glyph, "X");
  assert.equal(x.checks.note.ok, false);
  assert.match(x.message, /^X/);
  assert.equal((await c.verify({ path: "Un.md", online: false })).glyph, "V");
});

test("tampered proof (merkle path, note hash, token, date) -> X", async () => {
  const { c, vault } = await setup("tamper");
  await fs.writeFile(path.join(vault, "A.md"), "# A\n");
  await fs.writeFile(path.join(vault, "B.md"), "# B\n");
  await c.enqueue("A.md");
  await c.enqueue("B.md");
  const b = await c.runBatch();
  if ("error" in b) assert.fail(b.error);
  const good = b.proofs.find((p) => p.path === "A.md")!;
  assert.equal((await c.verify({ proof: JSON.stringify(good), online: false })).glyph, "V");

  const clone = (): Proof => JSON.parse(JSON.stringify(good));

  const p1 = clone(); p1.merkle.path[0].hash = "f".repeat(64);
  const r1 = await c.verify({ proof: JSON.stringify(p1), online: false });
  assert.equal(r1.glyph, "X"); assert.equal(r1.checks.merkle.ok, false);

  const p2 = clone(); p2.note_sha256 = sha256Hex("autre");
  assert.equal((await c.verify({ proof: JSON.stringify(p2), online: false })).glyph, "X");

  const p3 = clone(); p3.merkle.root = "a".repeat(64);
  const r3 = await c.verify({ proof: JSON.stringify(p3), online: false });
  assert.equal(r3.glyph, "X");

  const p4 = clone(); p4.tsa!.gen_time = "2020-01-01T00:00:00.000Z";
  const r4 = await c.verify({ proof: JSON.stringify(p4), online: false });
  assert.equal(r4.glyph, "X"); assert.equal(r4.checks.tsa_token.ok, false);

  const p5 = clone();
  const tok = Buffer.from(p5.tsa!.token_base64, "base64");
  tok[tok.length - 10] ^= 0xff; // flip a byte in the CMS signature
  p5.tsa!.token_base64 = tok.toString("base64");
  const r5 = await c.verify({ proof: JSON.stringify(p5), online: false });
  assert.equal(r5.glyph, "X", r5.message);

  const p6 = clone(); p6.path = "B.md";
  assert.equal((await c.verify({ proof: JSON.stringify(p6), online: false })).glyph, "X");

  assert.equal((await c.verify({ proof: "{pas du json", online: false })).glyph, "X");
  assert.equal((await c.verify({ path: "Inexistante.md", online: false })).glyph, "X");
});

test("defer queues notes; certify_batch stamps them later; refuses paths outside the vault", async () => {
  const { c, vault } = await setup("defer");
  await fs.writeFile(path.join(vault, "Q.md"), "# Q\n");
  assert.ok("error" in (await c.enqueue("../etc/passwd")));
  assert.ok("error" in (await c.enqueue("/etc/passwd")));
  assert.ok("error" in (await c.runBatch()), "empty batch is refused");
  const q = await c.enqueue("Q");
  assert.ok(!("error" in q));
  if (!("error" in q)) assert.equal(q.journal_status, "non journalisée");
  assert.equal((await c.pending()).length, 1);
  const b = await c.runBatch();
  if ("error" in b) assert.fail(b.error);
  assert.equal(b.leaf_count, 1);
  assert.equal(b.proofs[0].merkle.path.length, 0);
  assert.equal((await c.verify({ path: "Q.md", online: false })).glyph, "V");
});

test("TSA down -> error and notes stay pending", async () => {
  const base = path.join(tmp, "down");
  const vault = path.join(base, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "Z.md"), "# Z\n");
  const tsa = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "custom", XVCACHE_TSA_URL: "http://127.0.0.1:9/tsr" }) as TsaProvider;
  const c = new Certifier(certifyConfigFromEnv({ vaultRoot: await fs.realpath(vault), journalPath: path.join(base, "j.jsonl"), tsa }, { XVCACHE_OTS: "off" }));
  await c.enqueue("Z.md");
  const b = await c.runBatch();
  assert.ok("error" in b);
  assert.equal((await c.pending()).length, 1);
});
