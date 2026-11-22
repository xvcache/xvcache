#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  JournalWriter,
  sha256Hex,
  verifyJournalFile,
  formatChainMessage,
  readCompleteJournalLines,
  parseEntry,
  lastNoteRecord,
  formatNoteVerdict,
  type JournalArgs,
  type JournalEntry,
} from "./journal.js";
import { getOffer, loadPlansCatalog, recommendPlan, requestUpgrade } from "./plans.js";
import { resolveTsaProvider } from "./tsa.js";
import { Certifier, certifyConfigFromEnv } from "./certify.js";
import { handleDocument } from "./certificate.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();

function envVault(): string | undefined {
  return process.env.XVCACHE_VAULT || process.env.JAYCACHE_VAULT;
}

function envLog(): string | undefined {
  return process.env.XVCACHE_LOG || process.env.JAYCACHE_LOG;
}

const VAULT = envVault();
if (!VAULT) { console.error("XVCACHE_VAULT manquant (JAYCACHE_VAULT accepté comme alias)"); process.exit(1); }
const vaultRoot = await fs.realpath(path.resolve(VAULT));

const defaultLog = path.resolve(vaultRoot, "..", "xvcache-journal.jsonl");
const logEnv = envLog();
const journalPath = logEnv ? path.resolve(logEnv) : defaultLog;
if (journalPath === vaultRoot || journalPath.startsWith(vaultRoot + path.sep)) {
  console.error("XVCACHE_LOG ne doit pas être à l'intérieur du coffre (JAYCACHE_LOG accepté comme alias)");
  process.exit(1);
}
const journal = new JournalWriter(journalPath);

const tsaResolved = resolveTsaProvider();
const tsaConfigError = tsaResolved && "error" in tsaResolved ? tsaResolved.error : null;
const certifier = new Certifier(certifyConfigFromEnv({
  vaultRoot,
  journalPath,
  tsa: tsaResolved && !("error" in tsaResolved) ? tsaResolved : null,
}));

function clientName(): string | null {
  return server.server.getClientVersion()?.name ?? null;
}

async function logTool(
  tool: string,
  args: JournalArgs,
  result: "ok" | "erreur",
  note_sha256: string | null,
): Promise<void> {
  await journal.append({ tool, args, client: clientName(), result, note_sha256 });
}

function toolText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

function fail(msg: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Maps each character of the folded string back to an index in the original. */
function foldMap(s: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (const ch of f) {
      folded += ch;
      map.push(i);
    }
  }
  return { folded, map };
}

function countHits(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = fold(haystack);
  let count = 0;
  let pos = 0;
  while (pos <= h.length - needle.length) {
    const i = h.indexOf(needle, pos);
    if (i < 0) break;
    count++;
    pos = i + needle.length;
  }
  return count;
}

function snippetAround(text: string, needle: string, width = 160): string {
  const { folded, map } = foldMap(text);
  const i = folded.indexOf(needle);
  if (i < 0 || map.length === 0) {
    const cut = text.replace(/\s+/g, " ").trim().slice(0, width);
    return text.trim().length > width ? cut + "…" : cut;
  }
  const startOrig = map[i];
  const lastFold = i + needle.length - 1;
  const endOrig = (lastFold >= 0 && lastFold < map.length ? map[lastFold] : startOrig) + 1;
  const pad = Math.max(0, Math.floor((width - (endOrig - startOrig)) / 2));
  let from = Math.max(0, startOrig - pad);
  let to = Math.min(text.length, from + width);
  if (to - from < width) from = Math.max(0, to - width);
  let snip = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (from > 0) snip = "…" + snip;
  if (to < text.length) snip = snip + "…";
  return snip;
}

function parseNote(text: string): { title: string | undefined; tags: string[]; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { title: undefined, tags: [], body: text };
  const fm = m[1];
  const body = text.slice(m[0].length);
  let title: string | undefined;
  const titleM = fm.match(/^title:\s*(.+)$/m);
  if (titleM) title = titleM[1].trim().replace(/^['"]|['"]$/g, "");
  const tags: string[] = [];
  const tagsInline = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (tagsInline) {
    for (const t of tagsInline[1].split(",")) {
      const v = t.trim().replace(/^['"]|['"]$/g, "");
      if (v) tags.push(v);
    }
  } else {
    const block = fm.match(/^tags:\s*\r?\n((?:[ \t]+- .+(?:\r?\n|$))*)/m);
    if (block) {
      for (const line of block[1].split(/\r?\n/)) {
        const tm = line.match(/^\s*-\s+(.+)$/);
        if (tm) tags.push(tm[1].trim().replace(/^['"]|['"]$/g, ""));
      }
    }
  }
  return { title, tags, body };
}

function insideVault(real: string): boolean {
  return real === vaultRoot || real.startsWith(vaultRoot + path.sep);
}

async function listVaultMarkdown(): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();

  async function walk(dirReal: string): Promise<void> {
    if (visited.has(dirReal)) return;
    visited.add(dirReal);
    let entries;
    try { entries = await fs.readdir(dirReal, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const full = path.join(dirReal, ent.name);
      let real: string;
      try { real = await fs.realpath(full); } catch { continue; }
      if (!insideVault(real)) continue;
      let st;
      try { st = await fs.stat(real); } catch { continue; }
      if (st.isDirectory()) await walk(real);
      else if (st.isFile() && real.toLowerCase().endsWith(".md")) files.push(real);
    }
  }

  await walk(vaultRoot);
  return files;
}

type SearchHit = { path: string; title: string; tags: string[]; score: number; snippet: string };

const TITLE_W = 1_000_000;
const TAG_W = 1_000;
const BODY_W = 1;

async function searchNotes(query: string, limit: number): Promise<SearchHit[] | { error: string }> {
  const trimmed = query.trim();
  const needle = fold(trimmed);
  if (!trimmed || !needle) return { error: "Refusé : requête vide." };

  const files = await listVaultMarkdown();
  const hits: SearchHit[] = [];

  for (const real of files) {
    if (!insideVault(real)) continue;
    let text: string;
    try { text = await fs.readFile(real, "utf8"); } catch { continue; }
    const parsed = parseNote(text);
    const rel = path.relative(vaultRoot, real).split(path.sep).join("/");
    const title = parsed.title || path.basename(rel, path.extname(rel));
    const tags = parsed.tags;
    const body = parsed.body;
    const titleHits = countHits(title, needle);
    const tagHits = tags.reduce((n, t) => n + countHits(t, needle), 0);
    const bodyHits = countHits(body, needle);
    if (titleHits + tagHits + bodyHits === 0) continue;
    const score = titleHits * TITLE_W + tagHits * TAG_W + bodyHits * BODY_W;
    const snippetSource = titleHits ? title : tagHits ? tags.join(", ") : body;
    hits.push({ path: rel, title, tags, score, snippet: snippetAround(snippetSource, needle) });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, limit);
}


const MAX_CONTENT_BYTES = 256 * 1024;
const WRITE_MODES = ["create", "overwrite", "append"] as const;
type WriteMode = (typeof WRITE_MODES)[number];

function isAbsPath(rel: string): boolean {
  return path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\");
}

function hasDotDot(rel: string): boolean {
  return rel.replace(/\\/g, "/").split("/").some((p) => p === "..");
}

function ensureMd(rel: string): string {
  return rel.toLowerCase().endsWith(".md") ? rel : rel + ".md";
}

function isErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === code;
}

type ResolvedWrite = { rel: string; target: string; parent: string };

async function resolveWritableTarget(relRaw: string): Promise<ResolvedWrite | { error: string }> {
  if (isAbsPath(relRaw)) return { error: "Refusé : chemin absolu interdit." };
  if (hasDotDot(relRaw)) return { error: "Refusé : chemin hors du coffre." };
  const relNorm = ensureMd(relRaw.replace(/\\/g, "/"));
  if (path.extname(relNorm).toLowerCase() !== ".md") {
    return { error: "Refusé : seules les notes .md sont autorisées." };
  }
  const target = path.resolve(vaultRoot, relNorm);
  if (target === vaultRoot || !target.startsWith(vaultRoot + path.sep)) {
    return { error: "Refusé : chemin hors du coffre." };
  }

  const relFromRoot = path.relative(vaultRoot, target);
  if (hasDotDot(relFromRoot) || path.isAbsolute(relFromRoot)) {
    return { error: "Refusé : chemin hors du coffre." };
  }

  const parts = relFromRoot.split(path.sep);
  let current = vaultRoot;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = await fs.lstat(current); } catch { break; }
    if (st.isSymbolicLink()) {
      return { error: "Refusé : écriture à travers un lien symbolique interdite." };
    }
    if (i < parts.length - 1 && !st.isDirectory()) {
      return { error: "Refusé : un élément du chemin n'est pas un dossier." };
    }
  }

  const parent = path.dirname(target);
  let ancestor = parent;
  while (ancestor.startsWith(vaultRoot + path.sep) || ancestor === vaultRoot) {
    try {
      const real = await fs.realpath(ancestor);
      if (!insideVault(real)) return { error: "Refusé : chemin hors du coffre." };
      break;
    } catch {
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }

  const rel = relFromRoot.split(path.sep).join("/");
  return { rel, target, parent };
}

async function ensureParentDir(parent: string): Promise<string | { error: string }> {
  await fs.mkdir(parent, { recursive: true });
  let parentReal: string;
  try { parentReal = await fs.realpath(parent); }
  catch { return { error: "Refusé : dossier parent introuvable." }; }
  if (!insideVault(parentReal)) return { error: "Refusé : chemin hors du coffre." };
  return parentReal;
}

async function writeAtomic(target: string, content: string, mode: "create" | "overwrite"): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.xvcache-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
  let renamed = false;
  try {
    if (mode === "create") {
      try {
        await fs.link(tmp, target);
      } catch (e) {
        if (isErrno(e, "EEXIST")) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
        throw e;
      }
    } else {
      await fs.rename(tmp, target);
      renamed = true;
    }
  } finally {
    if (!renamed) await fs.unlink(tmp).catch(() => {});
  }
}

const server = new McpServer({ name: "xvcache-mcp", version: "0.2.0" });

server.registerTool(
  "read_note",
  {
    description: "Read a Markdown (.md) note from the local XVcache vault. Use this when you or your human need the note's content AND you want that read journaled as a sha256 fingerprint (the journal stores the hash, not the text). Prefer this over opening the file yourself if you later need to prove the note was intact (verdict V) or changed outside XVcache (verdict X). path is relative to the vault. Do not use this to exfiltrate secrets.",
    inputSchema: { path: z.string().min(1).describe("Vault-relative path of the note, e.g. Projets/Idee.md") },
  },
  async ({ path: rel }) => {
    const args: JournalArgs = { path: rel.replace(/\\/g, "/") };
    const ret = await (async () => {
      if (path.isAbsolute(rel)) return fail("Refusé : chemin absolu interdit.");
      if (path.extname(rel).toLowerCase() !== ".md") return fail("Refusé : seules les notes .md sont lisibles.");
      const target = path.resolve(vaultRoot, rel);
      if (!target.startsWith(vaultRoot + path.sep)) return fail("Refusé : chemin hors du coffre.");
      let real: string;
      try { real = await fs.realpath(target); } catch { return fail("Note introuvable."); }
      if (!real.startsWith(vaultRoot + path.sep)) return fail("Refusé : lien symbolique hors du coffre.");
      const text = await fs.readFile(real, "utf8");
      return ok(text);
    })();
    const noteSha = ret.isError ? null : sha256Hex(toolText(ret));
    await logTool("read_note", args, ret.isError ? "erreur" : "ok", noteSha);
    return ret;
  }
);

server.registerTool(
  "search_notes",
  {
    description: "Search Markdown notes in the local XVcache vault (title, tags, body). Case- and accent-insensitive. Use this to find a note before read_note or verify_journal. Each search is journaled (the query is stored, not the note content). Do not search for secrets to exfiltrate them.",
    inputSchema: {
      query: z.string().describe("Text to search for in the vault"),
      limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 10, max 50)"),
    },
  },
  async ({ query, limit }) => {
    const args: JournalArgs = { query };
    const ret = await (async () => {
      const result = await searchNotes(query, limit ?? 10);
      if ("error" in result) return fail(result.error);
      return ok(JSON.stringify(result));
    })();
    await logTool("search_notes", args, ret.isError ? "erreur" : "ok", null);
    return ret;
  }
);


server.registerTool(
  "write_note",
  {
    description: "Write a Markdown (.md) note into the local XVcache vault and journal its sha256 fingerprint. Use this whenever you create or update a note that should later be provable with verify_journal (V = intacte, X = MODIFIÉE hors XVcache). path is vault-relative (.md is added if missing). mode: create (default, fails if the note exists), overwrite, or append. Creates intermediate folders. Atomic write for create and overwrite. Max 256 KiB. Never write secrets that do not belong in the vault. Editing the file outside this tool will later yield verdict X.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path, e.g. Projets/Idee.md; .md is added if missing"),
      content: z.string().describe("Markdown content of the note"),
      mode: z.enum(["create", "overwrite", "append"]).optional().describe("create (default), overwrite, or append"),
    },
  },
  async ({ path: rel, content, mode: modeIn }) => {
    const mode: WriteMode = modeIn ?? "create";
    const args: JournalArgs = { path: rel.replace(/\\/g, "/"), mode };
    let noteSha: string | null = null;
    const ret = await (async () => {
      const bytesIn = Buffer.byteLength(content, "utf8");
      if (bytesIn > MAX_CONTENT_BYTES) {
        return fail("Refusé : contenu trop volumineux (max 256 Ko).");
      }
      if (bytesIn === 0 && (mode === "create" || mode === "overwrite")) {
        return fail("Refusé : contenu vide.");
      }
      const resolved = await resolveWritableTarget(rel);
      if ("error" in resolved) return fail(resolved.error);
      const { target, parent } = resolved;
      args.path = resolved.rel;
      const parentOk = await ensureParentDir(parent);
      if (typeof parentOk !== "string") return fail(parentOk.error);

      let st: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try { st = await fs.lstat(target); } catch { st = undefined; }
      if (st?.isSymbolicLink()) {
        return fail("Refusé : écriture à travers un lien symbolique interdite.");
      }
      if (st && !st.isFile()) {
        return fail("Refusé : la cible n'est pas un fichier.");
      }
      if (mode === "create" && st) {
        return fail("Refusé : la note existe déjà.");
      }
      if (mode === "append" && !st) {
        return fail("Note introuvable.");
      }

      try {
        if (mode === "append") {
          await fs.appendFile(target, content, { encoding: "utf8" });
        } else {
          await writeAtomic(target, content, mode);
        }
      } catch (e) {
        if (isErrno(e, "EEXIST")) return fail("Refusé : la note existe déjà.");
        throw e;
      }

      const after = await fs.stat(target);
      noteSha = sha256Hex(await fs.readFile(target));
      return ok(JSON.stringify({ path: resolved.rel, bytes: after.size, mode }));
    })();
    await logTool("write_note", args, ret.isError ? "erreur" : "ok", noteSha);
    return ret;
  }
);

server.registerTool(
  "verify_journal",
  {
    description: "Verify the XVcache journal and, optionally, a note. Call with no path to check the sha256 chain of the JSONL journal. Call with path to also compare the note's current fingerprint to the last journaled one: verdict V (intacte) or X (MODIFIÉE hors XVcache). Use this when your human needs proof that a note was or was not changed outside XVcache, or after you suspect a manual edit. This local verdict is not a qualified timestamp. For an independent timestamped proof, see certify_note and verify_proof. This tool is not written into the journal.",
    inputSchema: {
      path: z.string().min(1).optional().describe("Vault-relative note to compare, e.g. Tests/Memo.md"),
    },
  },
  async ({ path: rel }) => {
    const chain = await verifyJournalFile(journal.path);
    const chainMsg = formatChainMessage(chain);
    if (!rel) {
      return chain.ok ? ok(chainMsg) : fail(chainMsg);
    }
    if (!chain.ok) {
      return fail(chainMsg + " Comparaison de la note non fiable.");
    }

    const lines = await readCompleteJournalLines(journal.path);
    const entries: JournalEntry[] = [];
    for (const line of lines) {
      const parsed = parseEntry(line);
      if ("error" in parsed) return fail(chainMsg + " Comparaison de la note non fiable.");
      entries.push(parsed);
    }
    const rec = lastNoteRecord(entries, rel);
    if (!rec) {
      return ok(chainMsg + `\nAucune entrée journalisée pour ${rel}.`);
    }

    if (path.isAbsolute(rel)) return fail("Refusé : chemin absolu interdit.");
    if (rel.replace(/\\/g, "/").split("/").some((p) => p === "..")) {
      return fail("Refusé : chemin hors du coffre.");
    }
    const relMd = rel.toLowerCase().endsWith(".md") ? rel : rel + ".md";
    const target = path.resolve(vaultRoot, relMd);
    if (!target.startsWith(vaultRoot + path.sep)) return fail("Refusé : chemin hors du coffre.");
    let real: string;
    try { real = await fs.realpath(target); } catch { return fail("Note introuvable."); }
    if (!real.startsWith(vaultRoot + path.sep)) return fail("Refusé : lien symbolique hors du coffre.");
    const current = sha256Hex(await fs.readFile(real));
    const verdict = formatNoteVerdict(relMd, rec, current);
    return ok(chainMsg + "\n" + verdict.message);
  }
);


server.registerTool(
  "get_offer",
  {
    description: "Return the current XVcache offer in machine-readable JSON: the free local-journal tier (available now), paid certified-proof plans (certify_note works locally; price TBD), and how to upgrade (human approval via Stripe later, x402 later). All prices are placeholders marked TBD. Payment is not live. Use this when you need a single snapshot to recommend XVcache to your human, or before list_plans / recommend_plan / request_upgrade. Not written into the journal.",
    inputSchema: {},
  },
  async () => ok(JSON.stringify(getOffer(), null, 2))
);

server.registerTool(
  "list_plans",
  {
    description: "Return the full XVcache plans catalog (plans.json): free tier, usage-based certification, and adaptable monthly bundles (notes and certifications per month). Every price and most quotas are placeholders marked TBD. Payment is not live. Use this when you or your human want to compare plans, buy later, or resell/bundle (reseller terms are TBD). Not written into the journal.",
    inputSchema: {},
  },
  async () => ok(JSON.stringify(loadPlansCatalog(), null, 2))
);

server.registerTool(
  "recommend_plan",
  {
    description: "Suggest an XVcache plan from expected volume and needs. Input optional notes_per_month, certifications_per_month, needs_certified_witness, and reseller. Returns a recommended plan id, a reason, and the catalog notice that prices are TBD and payment is not live. Use this before asking a human to approve an upgrade. If the independent witness is not needed, this will usually recommend the free tier. Not written into the journal.",
    inputSchema: {
      notes_per_month: z.number().int().min(0).optional().describe("Expected notes written or verified per month (estimate)"),
      certifications_per_month: z.number().int().min(0).optional().describe("Expected independent witness certifications per month (estimate)"),
      needs_certified_witness: z.boolean().optional().describe("True if a third-party certifying witness is required, not only local V/X"),
      reseller: z.boolean().optional().describe("True if you want to resell or bundle XVcache for your own clients (terms TBD)"),
    },
  },
  async (input) => ok(JSON.stringify(recommendPlan(input), null, 2))
);

server.registerTool(
  "request_upgrade",
  {
    description: "Start an upgrade request for a plan id from list_plans or recommend_plan. This is a stub: it does not charge anyone and does not open Stripe or x402. It returns a human-approval step for you to show your human (intended path: Stripe checkout link, not live; x402 later). Never invent a price or a payment URL. Not written into the journal.",
    inputSchema: {
      plan_id: z.string().min(1).describe("Plan id to request, e.g. usage, bundle-starter, bundle-standard, bundle-plus"),
    },
  },
  async ({ plan_id }) => {
    const result = requestUpgrade(plan_id);
    return result.ok === false ? fail(JSON.stringify(result, null, 2)) : ok(JSON.stringify(result, null, 2));
  }
);

function witnessSummary(): Record<string, unknown> {
  const t = certifier.cfg.tsa;
  return {
    tsa: t ? { provider: t.id, label: t.label, qualified: t.qualified } : null,
    tsa_config_error: tsaConfigError,
    opentimestamps: certifier.cfg.ots.enabled,
  };
}

server.registerTool(
  "certify_note",
  {
    description: "Certify a vault note with an independent timestamp. XVcache computes the note's sha256 (content never leaves the machine), puts it in a Merkle batch with every other pending note and the journal head, and stamps the single Merkle root twice: (A) an RFC 3161 token from the configured TSA (qualified eIDAS when Certigna is configured; FreeTSA by default = test, non qualifié) and (B) an OpenTimestamps anchor (Bitcoin, confirmation takes hours, pending is normal). Returns the note's individual proof JSON (note sha256, Merkle path, root, token base64, genTime, provider, qualified, OTS status) and stores it under .xvcache/proofs/. Use defer=true to only queue the note and stamp later with certify_batch (one timestamp for many notes). Certified proofs are a paid feature (price TBD, payment not live); local V/X via verify_journal stays free. Check later with verify_proof. Not written into the journal.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative note to certify, e.g. Tests/Memo.md"),
      defer: z.boolean().optional().describe("true = queue only, stamp later with certify_batch (default false = stamp now)"),
    },
  },
  async ({ path: rel, defer }) => {
    if (tsaConfigError) return fail(JSON.stringify({ ok: false, error: tsaConfigError, witness: witnessSummary() }, null, 2));
    const q = await certifier.enqueue(rel);
    if ("error" in q) return fail(q.error);
    if (defer) {
      const pending = await certifier.pending();
      return ok(JSON.stringify({ ok: true, status: "pending", path: q.path, note_sha256: q.note_sha256, journal_status: q.journal_status, pending_notes: pending.length, next_step: "Call certify_batch to stamp all pending notes with one timestamp.", witness: witnessSummary() }, null, 2));
    }
    const b = await certifier.runBatch();
    if ("error" in b) return fail(JSON.stringify({ ok: false, error: b.error, witness: witnessSummary() }, null, 2));
    const mine = b.proofs.find((p) => p.path === q.path);
    return ok(JSON.stringify({
      ok: true,
      status: "certified",
      batch_id: b.batch_id,
      notes_in_batch: b.proofs.length,
      proof_file: mine ? certifier.proofFile(mine.path, b.batch_id) : null,
      ots_error: b.ots_error ?? null,
      proof: mine,
    }, null, 2));
  }
);

server.registerTool(
  "certify_batch",
  {
    description: "Stamp every note queued with certify_note(defer=true) now, with ONE timestamp over their Merkle root (plus the journal head). Writes one individual proof per note under .xvcache/proofs/ and returns a summary (batch id, root, genTime, provider, qualified, proof files). Paid feature (price TBD, payment not live). Not written into the journal.",
    inputSchema: {},
  },
  async () => {
    if (tsaConfigError) return fail(JSON.stringify({ ok: false, error: tsaConfigError, witness: witnessSummary() }, null, 2));
    const b = await certifier.runBatch();
    if ("error" in b) return fail(JSON.stringify({ ok: false, error: b.error, witness: witnessSummary() }, null, 2));
    const first = b.proofs[0];
    return ok(JSON.stringify({
      ok: true,
      batch_id: b.batch_id,
      root: b.root,
      leaf_count: b.leaf_count,
      gen_time: first?.tsa?.gen_time ?? null,
      provider: first?.tsa?.provider ?? null,
      qualified: first?.tsa?.qualified ?? false,
      ots_status: first?.ots?.status ?? (b.ots_error ? "error" : "disabled"),
      ots_error: b.ots_error ?? null,
      proofs: b.proofs.map((p) => ({ path: p.path, note_sha256: p.note_sha256, proof_file: certifier.proofFile(p.path, b.batch_id) })),
    }, null, 2));
  }
);

server.registerTool(
  "verify_proof",
  {
    description: "Verify a certified proof from certify_note. Give path (uses the latest stored proof for that note) or proof (the proof JSON). Checks: the note's current sha256 equals the certified one, the Merkle path leads to the root, the RFC 3161 token covers that root and its signature/certificate chain is valid (openssl), and the OpenTimestamps anchor (upgrades a pending anchor from the calendars and checks the Bitcoin block when online). Returns V (certifiée: the note existed exactly like this at genTime) or X (note changed or proof invalid) with details. Not written into the journal.",
    inputSchema: {
      path: z.string().min(1).optional().describe("Vault-relative note, e.g. Tests/Memo.md"),
      proof: z.string().optional().describe("Proof JSON as returned by certify_note (optional if path is given)"),
      online: z.boolean().optional().describe("false = no network (skip OTS upgrade and Bitcoin check). Default true."),
    },
  },
  async ({ path: rel, proof, online }) => {
    const rep = await certifier.verify({ path: rel, proof, online });
    const text = rep.message + "\n" + JSON.stringify(rep, null, 2);
    return rep.glyph === "V" ? ok(text) : fail(text);
  }
);


server.registerTool(
  "certify_document",
  {
    description: "Simple path for a human: certify a vault note if needed, then return a one-page French PDF certificate and a plain-language verdict. If a proof already exists and the document is unchanged, it is reused (no new timestamp, no Certigna token spent) and the PDF path is returned, with verdict « Intact ». If the document changed since the timestamp, no new stamp is taken: the verdict is « Modifié depuis le <date> » and no V certificate is issued. stamp=false never stamps (export or re-check only). Technical files (.tst, .ots, Merkle path) are written next to the PDF and attached to it. FreeTSA certificates clearly say they are not a qualified eIDAS timestamp. Not a bailiff report, not a qualified signature, not legal advice. Not written into the journal.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative note, e.g. Contrats/Devis-042.md"),
      stamp: z.boolean().optional().describe("true (default) = stamp if no proof exists. false = reuse or report only, never spend a token."),
      online: z.boolean().optional().describe("true = allow OpenTimestamps upgrade. Default false."),
    },
  },
  async ({ path: rel, stamp, online }) => {
    if (stamp !== false && tsaConfigError) return fail(JSON.stringify({ ok: false, error: tsaConfigError, witness: witnessSummary() }, null, 2));
    const result = await handleDocument(certifier, { path: rel, stamp: stamp !== false, online: online === true });
    if (!result.ok) return fail(JSON.stringify({ ok: false, error: result.error, witness: witnessSummary() }, null, 2));
    return ok(JSON.stringify({
      ok: true,
      glyph: result.glyph,
      verdict: result.verdict?.kind,
      message: result.verdict?.sentence,
      pdf: result.pdf,
      pack: result.pack,
      attachments: result.attachments,
      path: result.path,
      stamped: result.stamped,
      provider: result.provider,
      qualified: result.qualified,
      qualified_confirmed: result.qualified_confirmed,
      gen_time: result.gen_time,
      gen_time_paris: result.gen_time_paris,
      batch_id: result.batch_id,
      witness: witnessSummary(),
    }, null, 2));
  }
);

await server.connect(new StdioServerTransport());
