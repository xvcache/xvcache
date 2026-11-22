import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GENESIS_PREV_HASH,
  verifyJournalFile,
  parseEntry,
  type JournalEntry,
} from "./journal.js";
import { startFakeTsa } from "./test-tsa.js";

const execFileAsync = promisify(execFile);

const vaultDir = path.resolve(process.env.XVCACHE_VAULT ?? process.env.JAYCACHE_VAULT ?? "./test-vault");
const journalPath = path.join(os.tmpdir(), `xvcache-journal-test-${process.pid}.jsonl`);
await fs.rm(journalPath, { force: true }).catch(() => {});
const fakeTsa = await startFakeTsa();
const certDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-data-test-"));

function serverEnv(logFile: string): Record<string, string> {
  return {
    ...process.env,
    XVCACHE_VAULT: process.env.XVCACHE_VAULT ?? process.env.JAYCACHE_VAULT ?? "./test-vault",
    XVCACHE_LOG: logFile,
    XVCACHE_DATA: certDataDir,
    XVCACHE_TSA_PROVIDER: "custom",
    XVCACHE_TSA_URL: fakeTsa.url,
    XVCACHE_TSA_CA_FILE: fakeTsa.caFile,
    XVCACHE_OTS: "off",
  } as Record<string, string>;
}

async function openClient(logFile: string, name = "xvcache-test"): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/server.js"],
    env: serverEnv(logFile),
  });
  const c = new Client({ name, version: "0.1.0" });
  await c.connect(transport);
  return c;
}

let client = await openClient(journalPath);

function toolText(result: Awaited<ReturnType<typeof client.callTool>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

function parseHits(result: Awaited<ReturnType<typeof client.callTool>>): { path: string; title: string; tags: string[]; score: number; snippet: string }[] {
  if (result.isError) throw new Error("outil en erreur : " + toolText(result));
  const parsed = JSON.parse(toolText(result));
  if (!Array.isArray(parsed)) throw new Error("réponse non liste : " + toolText(result));
  return parsed;
}

const tools = await client.listTools();
console.log("1) tools/list :", tools.tools.map(t => t.name).join(", "));
const ok = await client.callTool({ name: "read_note", arguments: { path: "Projets/Sphere-3D.md" } });
console.log("2) read_note Projets/Sphere-3D.md :", JSON.stringify(ok));
const bad = await client.callTool({ name: "read_note", arguments: { path: "../etc/passwd" } });
console.log("3) read_note ../etc/passwd :", JSON.stringify(bad));
const bad2 = await client.callTool({ name: "read_note", arguments: { path: "../../../../etc/passwd.md" } });
console.log("3b) read_note ../../../../etc/passwd.md :", JSON.stringify(bad2));

const r4 = await client.callTool({ name: "search_notes", arguments: { query: "sphere" } });
console.log("4) search_notes sphere :", JSON.stringify(r4));
const hits4 = parseHits(r4);
if (!hits4.some((h) => h.path === "Projets/Sphere-3D.md")) {
  console.error("FAIL 4: Projets/Sphere-3D.md introuvable pour query=sphere (insensible aux accents vs 'Sphère')");
  await client.close();
  process.exit(1);
}

const r5 = await client.callTool({ name: "search_notes", arguments: { query: "xvcache" } });
console.log("5) search_notes xvcache :", JSON.stringify(r5));
const hits5 = parseHits(r5);
if (hits5.length === 0) {
  console.error("FAIL 5: aucun résultat pour le tag xvcache");
  await client.close();
  process.exit(1);
}

const absent = "xyzzy-absent-42";
const r6 = await client.callTool({ name: "search_notes", arguments: { query: absent } });
console.log("6) search_notes mot absent :", JSON.stringify(r6));
const hits6 = parseHits(r6);
if (hits6.length !== 0) {
  console.error("FAIL 6: attendu liste vide pour une requête absente, obtenu", JSON.stringify(hits6));
  await client.close();
  process.exit(1);
}

const r7secret = await client.callTool({ name: "search_notes", arguments: { query: "secret" } });
const r7body = await client.callTool({ name: "search_notes", arguments: { query: "factice" } });
console.log("7) search_notes secret + factice (exclusion .txt) :", JSON.stringify({ secret: r7secret, factice: r7body }));
const hits7 = [...parseHits(r7secret), ...parseHits(r7body)];
if (hits7.some((h) => h.path.includes("pas-une-note") || h.path.toLowerCase().endsWith(".txt"))) {
  console.error("FAIL 7: pas-une-note.txt ne doit jamais apparaître");
  await client.close();
  process.exit(1);
}
if (parseHits(r7secret).length !== 0) {
  console.error("FAIL 7: 'secret' n'existe que dans pas-une-note.txt, la liste doit être vide");
  await client.close();
  process.exit(1);
}

console.log("OK: tests 1-7 passés");

async function listRelFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      const rel = path.relative(dir, full);
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        out.push(rel + "/");
        await walk(full);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

const vaultBefore = await listRelFiles(vaultDir);

function parseWrite(result: Awaited<ReturnType<typeof client.callTool>>): { path: string; bytes: number; mode: string } {
  if (result.isError) throw new Error("outil en erreur : " + toolText(result));
  const parsed = JSON.parse(toolText(result));
  if (!parsed || typeof parsed.path !== "string" || typeof parsed.bytes !== "number" || typeof parsed.mode !== "string") {
    throw new Error("réponse write_note invalide : " + toolText(result));
  }
  return parsed;
}

const NOTE_DIR = "Tests-write";
const NOTE_PATH = NOTE_DIR + "/tmp-write-note.md";
const NOTE_PATH_NOEXT = NOTE_DIR + "/tmp-write-note";
const TOKEN_CREATE = "zyxwv-write-note-token-7c1e9";
const TOKEN_APPEND = "zyxwv-append-token-4b2a";
const TOKEN_OVERWRITE = "zyxwv-overwrite-token-8d3f";
const SYMLINK_IN = path.join(vaultDir, "lien-ecriture.md");
const SYMLINK_DIR = path.join(vaultDir, "lien-dossier");
let failed = false;
let outsideDir: string | undefined;
let outsideFile: string | undefined;

async function cleanupWriteTests(): Promise<void> {
  const leftovers = [
    path.join(vaultDir, NOTE_PATH),
    path.join(vaultDir, NOTE_DIR),
    SYMLINK_IN,
    SYMLINK_DIR,
    path.join(vaultDir, "hors-lien.md"),
  ];
  for (const f of leftovers) {
    await fs.lstat(f).then(() => fs.rm(f, { recursive: true, force: true })).catch(() => {});
  }
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  // remove any leftover temp files in the vault
  async function sweep(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name.startsWith(".xvcache-tmp-") || ent.name.startsWith(".jaycache-tmp-")) {
        await fs.rm(full, { force: true }).catch(() => {});
      } else if (ent.isDirectory() && !ent.isSymbolicLink()) {
        await sweep(full);
      }
    }
  }
  await sweep(vaultDir);
}

await cleanupWriteTests();
outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "xvcache-write-"));
outsideFile = path.join(outsideDir, "dehors.md");

try {
  const names = tools.tools.map((t) => t.name);
  const required = [
    "write_note", "read_note", "search_notes", "verify_journal",
    "get_offer", "list_plans", "recommend_plan", "request_upgrade", "certify_note", "certify_batch", "verify_proof",
  ];
  const missing = required.filter((n) => !names.includes(n));
  if (missing.length) {
    console.error("FAIL 1b: outils manquants dans tools/list :", missing.join(", "), "; obtenu :", names.join(", "));
    failed = true;
  }

  const content8 = `---\ntitle: Note temporaire write_note\ntags: [test]\n---\n# Note temporaire\nMarqueur ${TOKEN_CREATE}\n`;
  const r8 = await client.callTool({ name: "write_note", arguments: { path: NOTE_PATH_NOEXT, content: content8 } });
  console.log("8) write_note create (+ .md ajouté) :", JSON.stringify(r8));
  if (r8.isError) {
    console.error("FAIL 8: create a échoué :", toolText(r8));
    failed = true;
  } else {
    const w8 = parseWrite(r8);
    if (w8.path !== NOTE_PATH || w8.mode !== "create" || w8.bytes !== Buffer.byteLength(content8, "utf8")) {
      console.error("FAIL 8: réponse inattendue", w8);
      failed = true;
    }
    const read8 = await client.callTool({ name: "read_note", arguments: { path: NOTE_PATH } });
    if (read8.isError || toolText(read8) !== content8) {
      console.error("FAIL 8: read_note n'a pas retrouvé le contenu créé");
      failed = true;
    }
    const search8 = parseHits(await client.callTool({ name: "search_notes", arguments: { query: TOKEN_CREATE } }));
    if (!search8.some((h) => h.path === NOTE_PATH)) {
      console.error("FAIL 8: search_notes n'a pas retrouvé la note créée", JSON.stringify(search8));
      failed = true;
    }
  }

  const r9 = await client.callTool({ name: "write_note", arguments: { path: NOTE_PATH, content: content8, mode: "create" } });
  console.log("9) write_note create sur note existante :", JSON.stringify(r9));
  if (!r9.isError || !toolText(r9).includes("existe déjà")) {
    console.error("FAIL 9: create sur une note existante doit échouer");
    failed = true;
  }

  const appendText = `\nSuite ${TOKEN_APPEND}\n`;
  const r10 = await client.callTool({ name: "write_note", arguments: { path: NOTE_PATH, content: appendText, mode: "append" } });
  console.log("10) write_note append :", JSON.stringify(r10));
  if (r10.isError) {
    console.error("FAIL 10: append a échoué :", toolText(r10));
    failed = true;
  } else {
    const w10 = parseWrite(r10);
    if (w10.mode !== "append" || w10.bytes !== Buffer.byteLength(content8 + appendText, "utf8")) {
      console.error("FAIL 10: réponse append inattendue", w10);
      failed = true;
    }
    const read10 = toolText(await client.callTool({ name: "read_note", arguments: { path: NOTE_PATH } }));
    if (!read10.includes(TOKEN_CREATE) || !read10.includes(TOKEN_APPEND) || read10 !== content8 + appendText) {
      console.error("FAIL 10: read_note après append incorrect");
      failed = true;
    }
    const search10 = parseHits(await client.callTool({ name: "search_notes", arguments: { query: TOKEN_APPEND } }));
    if (!search10.some((h) => h.path === NOTE_PATH)) {
      console.error("FAIL 10: search_notes n'a pas retrouvé le texte ajouté");
      failed = true;
    }
  }

  const content11 = `---\ntitle: Note écrasée\ntags: [test]\n---\n# Écrasée\nMarqueur ${TOKEN_OVERWRITE}\n`;
  const r11 = await client.callTool({ name: "write_note", arguments: { path: NOTE_PATH, content: content11, mode: "overwrite" } });
  console.log("11) write_note overwrite :", JSON.stringify(r11));
  if (r11.isError) {
    console.error("FAIL 11: overwrite a échoué :", toolText(r11));
    failed = true;
  } else {
    const w11 = parseWrite(r11);
    if (w11.mode !== "overwrite" || w11.bytes !== Buffer.byteLength(content11, "utf8")) {
      console.error("FAIL 11: réponse overwrite inattendue", w11);
      failed = true;
    }
    const read11 = toolText(await client.callTool({ name: "read_note", arguments: { path: NOTE_PATH } }));
    if (read11 !== content11) {
      console.error("FAIL 11: contenu après overwrite incorrect");
      failed = true;
    }
    if (read11.includes(TOKEN_CREATE) || read11.includes(TOKEN_APPEND)) {
      console.error("FAIL 11: l'ancien contenu est encore présent après overwrite");
      failed = true;
    }
    const searchOld = parseHits(await client.callTool({ name: "search_notes", arguments: { query: TOKEN_CREATE } }));
    const searchNew = parseHits(await client.callTool({ name: "search_notes", arguments: { query: TOKEN_OVERWRITE } }));
    if (searchOld.some((h) => h.path === NOTE_PATH)) {
      console.error("FAIL 11: search_notes trouve encore l'ancien jeton après overwrite");
      failed = true;
    }
    if (!searchNew.some((h) => h.path === NOTE_PATH)) {
      console.error("FAIL 11: search_notes n'a pas retrouvé le contenu écrasé");
      failed = true;
    }
  }

  const r12a = await client.callTool({ name: "write_note", arguments: { path: "../x.md", content: "intrusion", mode: "create" } });
  const r12b = await client.callTool({ name: "write_note", arguments: { path: "/tmp/xvcache-abs.md", content: "intrusion", mode: "create" } });
  console.log("12) write_note ../x.md + chemin absolu :", JSON.stringify({ rel: r12a, abs: r12b }));
  if (!r12a.isError) {
    console.error("FAIL 12: ../x.md doit être refusé");
    failed = true;
  }
  if (!r12b.isError || !toolText(r12b).toLowerCase().includes("absolu")) {
    console.error("FAIL 12: un chemin absolu doit être refusé");
    failed = true;
  }
  const escaped = path.resolve(vaultDir, "../x.md");
  try {
    await fs.access(escaped);
    console.error("FAIL 12: le fichier hors coffre a été créé :", escaped);
    failed = true;
    await fs.rm(escaped, { force: true }).catch(() => {});
  } catch { /* attendu : absent */ }

  await fs.writeFile(outsideFile!, "dehors\n", "utf8");
  await fs.symlink(path.join(vaultDir, "Bienvenue.md"), SYMLINK_IN);
  await fs.symlink(outsideDir!, SYMLINK_DIR);
  const bienvenueBefore = await fs.readFile(path.join(vaultDir, "Bienvenue.md"), "utf8");
  const r13a = await client.callTool({ name: "write_note", arguments: { path: "lien-ecriture.md", content: "piratage " + TOKEN_OVERWRITE, mode: "overwrite" } });
  const r13b = await client.callTool({ name: "write_note", arguments: { path: "lien-dossier/dehors.md", content: "piratage", mode: "overwrite" } });
  console.log("13) write_note via lien symbolique :", JSON.stringify({ file: r13a, dir: r13b }));
  if (!r13a.isError) {
    console.error("FAIL 13: écriture à travers un lien symbolique (fichier) doit être refusée");
    failed = true;
  }
  if (!r13b.isError) {
    console.error("FAIL 13: écriture à travers un lien symbolique (dossier) doit être refusée");
    failed = true;
  }
  const bienvenueAfter = await fs.readFile(path.join(vaultDir, "Bienvenue.md"), "utf8");
  if (bienvenueAfter !== bienvenueBefore) {
    console.error("FAIL 13: Bienvenue.md a été modifié via le lien");
    failed = true;
  }
  const outsideAfter = await fs.readFile(outsideFile!, "utf8");
  if (outsideAfter !== "dehors\n") {
    console.error("FAIL 13: un fichier hors coffre a été modifié via le lien");
    failed = true;
  }

  const tooBig = "x".repeat(256 * 1024 + 1);
  const r14 = await client.callTool({ name: "write_note", arguments: { path: NOTE_DIR + "/trop-gros.md", content: tooBig, mode: "create" } });
  console.log("14) write_note contenu trop gros :", r14.isError, toolText(r14).slice(0, 80));
  if (!r14.isError || !toolText(r14).includes("volumineux")) {
    console.error("FAIL 14: un contenu > 256 Ko doit être refusé");
    failed = true;
  }
  try {
    await fs.access(path.join(vaultDir, NOTE_DIR, "trop-gros.md"));
    console.error("FAIL 14: le fichier trop gros a été écrit");
    failed = true;
  } catch { /* attendu */ }

  const r15 = await client.callTool({ name: "write_note", arguments: { path: NOTE_DIR + "/vide.md", content: "", mode: "create" } });
  console.log("15) write_note contenu vide :", JSON.stringify(r15));
  if (!r15.isError || !toolText(r15).toLowerCase().includes("vide")) {
    console.error("FAIL 15: un contenu vide en create doit être refusé");
    failed = true;
  }
} finally {
  await cleanupWriteTests();
}


const JOURNAL_NOTE_DIR = "Tests-journal";
const JOURNAL_NOTE = JOURNAL_NOTE_DIR + "/temoin.md";
const JOURNAL_TOKEN = "zyxwv-temoin-journal-a91c";

async function cleanupJournalTests(): Promise<void> {
  const dir = path.join(vaultDir, JOURNAL_NOTE_DIR);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function readJournalEntries(file: string): Promise<JournalEntry[]> {
  let raw = "";
  try { raw = await fs.readFile(file, "utf8"); } catch { return []; }
  const entries: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseEntry(line);
    if ("error" in parsed) throw new Error("ligne de journal illisible : " + parsed.error + " :: " + line);
    entries.push(parsed);
  }
  return entries;
}

async function runCli(file: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", ["dist/verify-journal.js", file], { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

try {

  // 16) la chaîne se construit
  const entries16 = await readJournalEntries(journalPath);
  console.log("16) journal :", entries16.length, "entrées");
  if (entries16.length === 0) {
    console.error("FAIL 16: le journal est vide après les tests 1-15");
    failed = true;
  } else {
    if (entries16[0].prev_hash !== GENESIS_PREV_HASH) {
      console.error("FAIL 16: prev_hash de la première ligne doit être 64 zéros");
      failed = true;
    }
    const chain16 = await verifyJournalFile(journalPath);
    if (!chain16.ok) {
      console.error("FAIL 16: la chaîne est déjà invalide :", chain16.issue);
      failed = true;
    }
    const toolsLogged = new Set(entries16.map((e) => e.tool));
    for (const t of ["read_note", "search_notes", "write_note"]) {
      if (!toolsLogged.has(t)) {
        console.error("FAIL 16: aucune entrée pour", t);
        failed = true;
      }
    }
    if (!entries16.some((e) => e.result === "ok") || !entries16.some((e) => e.result === "erreur")) {
      console.error("FAIL 16: le journal doit contenir des succès et des refus");
      failed = true;
    }
    if (!entries16.every((e, i) => e.seq === i + 1)) {
      console.error("FAIL 16: seq non consécutifs");
      failed = true;
    }
    if (entries16.some((e) => "content" in e.args)) {
      console.error("FAIL 16: le contenu complet d'une note ne doit pas figurer dans args");
      failed = true;
    }
    if (entries16.some((e) => e.tool === "write_note" && (JSON.stringify(e.args).includes(TOKEN_CREATE) || JSON.stringify(e.args).includes(TOKEN_APPEND) || JSON.stringify(e.args).includes(TOKEN_OVERWRITE)))) {
      console.error("FAIL 16: write_note a journalisé le contenu de la note dans args");
      failed = true;
    }
    if (!entries16.some((e) => e.client === "xvcache-test")) {
      console.error("FAIL 16: le nom du client initialize est absent");
      failed = true;
    }
    if (!entries16.some((e) => e.tool === "write_note" && e.result === "ok" && e.note_sha256 && /^[0-9a-f]{64}$/.test(e.note_sha256))) {
      console.error("FAIL 16: un write réussi doit porter un note_sha256");
      failed = true;
    }
    if (entries16.some((e) => e.tool === "verify_journal")) {
      console.error("FAIL 16: verify_journal ne doit pas s'écrire dans le journal");
      failed = true;
    }
  }

  // 21) tools for agents: catalog, recommendation, upgrade stub, certify stub — not journaled, no live payment
  const before21 = await readJournalEntries(journalPath);
  const rOffer = await client.callTool({ name: "get_offer", arguments: {} });
  const rPlans = await client.callTool({ name: "list_plans", arguments: {} });
  const rRecFree = await client.callTool({ name: "recommend_plan", arguments: { needs_certified_witness: false } });
  const rRecBundle = await client.callTool({
    name: "recommend_plan",
    arguments: { notes_per_month: 80, certifications_per_month: 15, needs_certified_witness: true },
  });
  const rRecReseller = await client.callTool({
    name: "recommend_plan",
    arguments: { certifications_per_month: 30, reseller: true },
  });
  const rUp = await client.callTool({ name: "request_upgrade", arguments: { plan_id: "bundle-starter" } });
  const rUpBad = await client.callTool({ name: "request_upgrade", arguments: { plan_id: "does-not-exist" } });
  const rCert = await client.callTool({ name: "certify_note", arguments: { path: "Bienvenue.md" } });
  const rVerif = await client.callTool({ name: "verify_proof", arguments: { path: "Bienvenue.md", online: false } });
  const after21 = await readJournalEntries(journalPath);
  console.log("21) get_offer/list_plans/recommend_plan/request_upgrade/certify_note/verify_proof appelés");

  function asJson(result: Awaited<ReturnType<typeof client.callTool>>): Record<string, unknown> {
    return JSON.parse(toolText(result)) as Record<string, unknown>;
  }

  if (rOffer.isError || rPlans.isError || rRecFree.isError || rRecBundle.isError || rRecReseller.isError || rUp.isError || rCert.isError) {
    console.error("FAIL 21: un outil commercial a échoué à tort", {
      offer: toolText(rOffer), plans: toolText(rPlans), rec: toolText(rRecFree), up: toolText(rUp), cert: toolText(rCert),
    });
    failed = true;
  } else {
    const offer = asJson(rOffer);
    const plans = asJson(rPlans);
    const recFree = asJson(rRecFree);
    const recBundle = asJson(rRecBundle);
    const recReseller = asJson(rRecReseller);
    const up = asJson(rUp);
    const cert = asJson(rCert);
    if (offer.payment_live !== false || plans.payment_live !== false || plans.prices_status !== "TBD") {
      console.error("FAIL 21: le catalogue doit déclarer payment_live=false et prices_status=TBD");
      failed = true;
    }
    if (!Array.isArray(plans.plans) || (plans.plans as unknown[]).length < 3) {
      console.error("FAIL 21: list_plans doit renvoyer le catalogue complet");
      failed = true;
    }
    if (recFree.recommended_plan_id !== "free") {
      console.error("FAIL 21: sans témoin certifié, recommend_plan doit suggérer free, obtenu :", recFree.recommended_plan_id);
      failed = true;
    }
    if (recBundle.recommended_plan_id !== "bundle-starter") {
      console.error("FAIL 21: 15 certifications / 80 notes devraient suggérer bundle-starter (quotas placeholder), obtenu :", recBundle.recommended_plan_id);
      failed = true;
    }
    if (recReseller.reseller == null) {
      console.error("FAIL 21: recommend_plan avec reseller=true doit inclure le champ reseller (termes TBD)");
      failed = true;
    }
    if (up.payment_live !== false || up.status !== "needs_human_approval") {
      console.error("FAIL 21: request_upgrade doit rester un stub d'approbation humaine, sans paiement :", up);
      failed = true;
    }
    const approval = up.approval as { checkout_url?: unknown } | undefined;
    if (!approval || approval.checkout_url != null) {
      console.error("FAIL 21: aucun lien de paiement ne doit être renvoyé", approval);
      failed = true;
    }
    if (!rUpBad.isError) {
      console.error("FAIL 21: request_upgrade sur un plan inconnu doit échouer");
      failed = true;
    }
    const proof = cert.proof as { merkle?: { root?: string }; tsa?: { qualified?: boolean; token_base64?: string; gen_time?: string } } | undefined;
    if (cert.ok !== true || cert.status !== "certified" || !proof?.merkle?.root || !proof.tsa?.token_base64 || !proof.tsa.gen_time) {
      console.error("FAIL 21: certify_note doit renvoyer une preuve horodatée :", cert);
      failed = true;
    } else if (proof.tsa.qualified !== false) {
      console.error("FAIL 21: une TSA custom non déclarée ne doit pas être marquée qualifiée");
      failed = true;
    }
    if (rVerif.isError || !toolText(rVerif).startsWith("V")) {
      console.error("FAIL 21: verify_proof doit rendre V sur une note certifiée intacte :", toolText(rVerif));
      failed = true;
    }
  }
  if (after21.length !== before21.length) {
    console.error("FAIL 21: get_offer, list_plans, recommend_plan, request_upgrade et certify_note ne doivent pas s'écrire dans le journal");
    failed = true;
  }

  // 17) verify_journal ok
  const r17 = await client.callTool({ name: "verify_journal", arguments: {} });
  console.log("17) verify_journal :", JSON.stringify(r17));
  const t17 = toolText(r17);
  if (r17.isError || !t17.includes("Journal intact")) {
    console.error("FAIL 17: verify_journal doit confirmer que la chaîne est intacte, obtenu :", t17);
    failed = true;
  }
  const cli17 = await runCli(journalPath);
  if (cli17.code !== 0 || !cli17.stdout.includes("Journal intact")) {
    console.error("FAIL 17: npm run verify-journal devrait confirmer l'intégrité", cli17);
    failed = true;
  }

  // 18) modification d'une note hors outil détectée
  await cleanupJournalTests();
  const content18 = `# Témoin\nMarqueur ${JOURNAL_TOKEN}\n`;
  const r18w = await client.callTool({ name: "write_note", arguments: { path: JOURNAL_NOTE, content: content18, mode: "create" } });
  console.log("18) write_note témoin :", JSON.stringify(r18w));
  if (r18w.isError) {
    console.error("FAIL 18: impossible d'écrire la note témoin :", toolText(r18w));
    failed = true;
  } else {
    const r18ok = await client.callTool({ name: "verify_journal", arguments: { path: JOURNAL_NOTE } });
    const t18ok = toolText(r18ok);
    console.log("18) verify_journal avant altération :", t18ok);
    if (r18ok.isError || !t18ok.includes("V  intacte") || !t18ok.includes("intacte depuis") || !t18ok.includes("xvcache-test")) {
      console.error("FAIL 18: la note vient d'être écrite, elle doit être intacte :", t18ok);
      failed = true;
    }
    await fs.writeFile(path.join(vaultDir, JOURNAL_NOTE), content18 + "altéré à la main\n", "utf8");
    const r18bad = await client.callTool({ name: "verify_journal", arguments: { path: JOURNAL_NOTE } });
    const t18bad = toolText(r18bad);
    console.log("18) verify_journal après altération hors outil :", t18bad);
    if (r18bad.isError || !t18bad.includes("X  MODIFIÉE hors XVcache") || !t18bad.includes("MODIFIÉE hors XVcache après")) {
      console.error("FAIL 18: une modification hors outil doit être signalée, obtenu :", t18bad);
      failed = true;
    }
  }

  // 19) reprise de chaîne après redémarrage du serveur
  const before19 = await readJournalEntries(journalPath);
  const last19 = before19[before19.length - 1];
  await client.close();
  client = await openClient(journalPath, "xvcache-test-reprise");
  const r19 = await client.callTool({ name: "read_note", arguments: { path: JOURNAL_NOTE } });
  console.log("19) read_note après redémarrage :", r19.isError ? toolText(r19).slice(0, 80) : "ok");
  if (r19.isError) {
    console.error("FAIL 19: lecture après redémarrage a échoué :", toolText(r19));
    failed = true;
  } else {
    const after19 = await readJournalEntries(journalPath);
    const added = after19.slice(before19.length);
    if (added.length !== 1) {
      console.error("FAIL 19: attendu exactement 1 nouvelle entrée après redémarrage, obtenu", added.length);
      failed = true;
    } else {
      if (added[0].seq !== last19.seq + 1) {
        console.error("FAIL 19: seq non repris, attendu", last19.seq + 1, "obtenu", added[0].seq);
        failed = true;
      }
      if (added[0].prev_hash !== last19.hash) {
        console.error("FAIL 19: prev_hash n'enchaîne pas sur le hash précédent");
        failed = true;
      }
      if (added[0].client !== "xvcache-test-reprise" || added[0].tool !== "read_note") {
        console.error("FAIL 19: entrée de reprise inattendue", added[0]);
        failed = true;
      }
    }
    const chain19 = await verifyJournalFile(journalPath);
    const r19v = await client.callTool({ name: "verify_journal", arguments: {} });
    if (!chain19.ok || r19v.isError || !toolText(r19v).includes("Journal intact")) {
      console.error("FAIL 19: la chaîne n'est plus intacte après redémarrage", chain19.issue, toolText(r19v));
      failed = true;
    }
  }

  // 20) altération d'une ligne du journal détectée
  const raw20 = await fs.readFile(journalPath, "utf8");
  const lines20 = raw20.split("\n").filter((l) => l.length > 0);
  if (lines20.length < 2) {
    console.error("FAIL 20: journal trop court pour tester une altération");
    failed = true;
  } else {
    const targetIdx = 1; // deuxième ligne
    let line = lines20[targetIdx];
    if (line.includes('"result":"ok"')) line = line.replace('"result":"ok"', '"result":"erreur"');
    else if (line.includes('"result":"erreur"')) line = line.replace('"result":"erreur"', '"result":"ok"');
    else line = line.replace('"tool":', '"tool":"tampered"-');
    if (line === lines20[targetIdx]) {
      console.error("FAIL 20: impossible d'altérer la ligne cible");
      failed = true;
    } else {
      lines20[targetIdx] = line;
      await fs.writeFile(journalPath, lines20.join("\n") + "\n", "utf8");
      const r20 = await client.callTool({ name: "verify_journal", arguments: {} });
      const t20 = toolText(r20);
      console.log("20) verify_journal journal altéré :", t20);
      const parsedTarget = JSON.parse(line) as { seq: number };
      if (!r20.isError || !t20.includes("Journal altéré") || !t20.includes("première ligne cassée") || !t20.includes(`seq=${parsedTarget.seq}`)) {
        console.error("FAIL 20: l'altération du journal doit être signalée (seq=" + parsedTarget.seq + "), obtenu :", t20);
        failed = true;
      }
      const cli20 = await runCli(journalPath);
      if (cli20.code !== 1 || !(cli20.stderr + cli20.stdout).includes("Journal altéré") || !(cli20.stderr + cli20.stdout).includes(`seq=${parsedTarget.seq}`)) {
        console.error("FAIL 20: le CLI doit échouer sur un journal altéré", cli20);
        failed = true;
      }
    }
  }

} finally {
  await cleanupJournalTests();
  await fs.rm(journalPath, { force: true }).catch(() => {});
}

const vaultAfter = await listRelFiles(vaultDir);
if (vaultAfter.join("\n") !== vaultBefore.join("\n")) {
  console.error("FAIL cleanup: le coffre a changé\navant:", vaultBefore, "\naprès:", vaultAfter);
  failed = true;
}

if (failed) {
  console.error("FAIL: un ou plusieurs tests ont échoué");
  await client.close().catch(() => {});
  await fakeTsa.close().catch(() => {});
  process.exit(1);
}

console.log("OK: tests 1-21 passés");
await client.close();
await fakeTsa.close();
await fs.rm(certDataDir, { recursive: true, force: true });
