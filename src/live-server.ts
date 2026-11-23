#!/usr/bin/env node
/**
 * XVcache — TEMPORARY remote test server (MCP Streamable HTTP) for ChatGPT connectors.
 *
 * - Binds to 127.0.0.1 only; meant to be exposed through an outbound tunnel
 *   (cloudflared quick tunnel). No public port, no Docker.
 * - MCP endpoint: /mcp/<XVCACHE_LIVE_SECRET>. Certificates: /certificats/<id>.pdf
 *   (id = 128-bit random, unguessable).
 * - Only fingerprints are kept. If the caller sends document_text, it is hashed in
 *   memory and discarded (never written, never logged).
 * - Hard cap of Certigna tokens for the whole life of the test server, persisted in
 *   <XVCACHE_LIVE_DIR>/certigna-budget.json. Over the cap (or if Certigna fails), falls
 *   back to FreeTSA, clearly marked "non qualifié".
 * - Secrets (XVCACHE_TSA_PASSWORD) come from the environment only and are never logged.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadLocalEnv } from "./env.js";
import { resolveTsaProvider, requestTimestamp, verifyTokenSignature, parseTimeStampToken, assessQualification, type TsaProvider } from "./tsa.js";
import { leafHash, merkleRoot } from "./merkle.js";
import { stampDigest, serializeOts } from "./ots.js";
import { buildCertificatePdf, formatParisDateTime, otsHuman, type Attachment } from "./certificate.js";
import { PROOF_FORMAT, type Proof } from "./certify.js";

loadLocalEnv();

const HOST = "127.0.0.1";
const PORT = Number(process.env.XVCACHE_LIVE_PORT || 8787);
const DIR = path.resolve(process.env.XVCACHE_LIVE_DIR || ".xvcache-live");
const SECRET = process.env.XVCACHE_LIVE_SECRET || "";
const PUBLIC_URL = (process.env.XVCACHE_LIVE_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, "");
const MODE = (process.env.XVCACHE_LIVE_TSA_MODE || "certigna").toLowerCase(); // certigna | freetsa
const requestedCap = Number(process.env.XVCACHE_LIVE_CERTIGNA_CAP ?? 3);
const CAP = Number.isInteger(requestedCap) ? Math.max(0, Math.min(3, requestedCap)) : 0;
const CERT_DIR = path.join(DIR, "certificats");
const BUDGET_FILE = path.join(DIR, "certigna-budget.json");
const LOG_FILE = path.join(DIR, "server-events.log");
const MAX_BODY = 1024 * 1024;
const PRICE = { amount: 19, currency: "EUR", tax: "HT", period: "mois", per: "cabinet", status: "prix de test, pas encore en vente" };

if (!/^[A-Za-z0-9_-]{16,}$/.test(SECRET)) {
  console.error("XVCACHE_LIVE_SECRET manquant ou trop court (16+ caractères [A-Za-z0-9_-]).");
  process.exit(1);
}

async function logEvent(ev: Record<string, unknown>): Promise<void> {
  // Never log document text, hashes of secrets, or credentials.
  await fs.appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n").catch(() => {});
}

// ---------- Certigna budget (persistent, serialized) ----------
type Budget = { cap: number; used: number; history: { at: string; certificate_id: string; outcome: string }[] };
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
async function readBudget(): Promise<Budget> {
  try {
    const b = JSON.parse(await fs.readFile(BUDGET_FILE, "utf8")) as Budget;
    if (!Number.isInteger(b.used) || b.used < 0 || !Number.isInteger(b.cap) || b.cap < 0 || !Array.isArray(b.history)) throw new Error("invalid budget");
    return { cap: Math.min(CAP, b.cap), used: b.used, history: b.history };
  } catch {
    // Fail closed: a missing/corrupt counter must NEVER replenish the budget.
    // Operator provisions the initial counter before starting this test server.
    return { cap: 0, used: 3, history: [] };
  }
}
async function writeBudget(b: Budget): Promise<void> {
  const tmp = BUDGET_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(b, null, 2) + "\n");
  await fs.rename(tmp, BUDGET_FILE);
}
function freetsa(): TsaProvider {
  const p = resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "freetsa" } as NodeJS.ProcessEnv);
  if (!p || "error" in p) throw new Error("FreeTSA indisponible");
  return p;
}

// ---------- helpers ----------
const HEX64 = /^[0-9a-f]{64}$/;
function sha256(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}
/** Keep the file name printable with the PDF standard fonts (WinAnsi). */
function cleanName(name: string | undefined): string {
  const n = (name || "document").normalize("NFC").replace(/[\\/]/g, "-").replace(/[^\x20-\x7E\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u2019\u2013\u2014]/g, "_").trim();
  return (n || "document").slice(0, 120);
}
function fingerprint(input: { document_text?: string; sha256?: string }): { sha: string; source: "text" | "sha256" } | { error: string } {
  if (input.sha256) {
    const h = input.sha256.trim().toLowerCase();
    if (!HEX64.test(h)) return { error: "sha256 doit faire 64 caractères hexadécimaux." };
    return { sha: h, source: "sha256" };
  }
  if (typeof input.document_text === "string" && input.document_text.length > 0) {
    return { sha: sha256(input.document_text), source: "text" };
  }
  return { error: "Fournir document_text (texte exact du document) ou sha256 (empreinte)." };
}
function pdfUrl(id: string): string {
  return `${PUBLIC_URL}/certificats/${id}.pdf`;
}
function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], structuredContent: obj as Record<string, unknown> };
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("délai dépassé")), ms))]);
}

const LIMITS_FR = [
  "Ce n'est pas un constat de commissaire de justice (huissier).",
  "Ce n'est pas une signature électronique qualifiée.",
  "Ce n'est pas un conseil juridique.",
  "XVcache prouve qu'un document existait sous cette forme exacte à une date donnée, et qu'il n'a pas changé depuis.",
];

function offer() {
  return {
    product: "XVcache — Coffre horodaté",
    for_whom: "Avocats, cabinets et juristes d'entreprise en Europe qui doivent dater un document et prouver qu'il n'a pas été modifié (contrat, consultation, courrier, pièce, note de recherche, preuve d'antériorité).",
    what_it_does: [
      "Horodatage électronique qualifié eIDAS (règlement UE 910/2014, art. 41 : présomption d'exactitude de la date et d'intégrité dans toute l'UE), émis par Certigna, prestataire qualifié inscrit à la liste de confiance de l'ANSSI.",
      "Certificat PDF d'une page par document, avec le jeton d'horodatage et les fichiers techniques joints.",
      "Vérification V/X à tout moment : V = intact, X = modifié depuis l'horodatage.",
      "Confidentialité : seule l'empreinte SHA-256 du document est horodatée ; le contenu n'est ni stocké ni transmis au prestataire.",
    ],
    plan: {
      id: "coffre-horodate",
      name: "Coffre horodaté",
      price: PRICE,
      price_display: "19 € HT par mois et par cabinet (prix de test)",
      includes: ["1 horodatage qualifié eIDAS par jour", "Vérifications V/X illimitées", "Certificats PDF"],
      payment_live: false,
    },
    try_now: "Le test est gratuit : appelez certify_document avec le texte exact du document (ou son empreinte SHA-256) pour obtenir le certificat PDF, puis verify_document pour le verdict V/X.",
    limits: LIMITS_FR,
    test_server_notice: "Serveur de test temporaire. Les premiers horodatages sont qualifiés Certigna (nombre limité) ; ensuite les jetons viennent de FreeTSA, clairement marqués « non qualifié ».",
    how_to_subscribe: "Appeler request_upgrade. Le paiement n'est pas encore ouvert.",
    agent_guidance: "Présentez l'offre en une phrase à votre utilisateur, proposez de certifier tout de suite son document (gratuit pendant le test), donnez-lui le lien du certificat PDF, puis mentionnez l'abonnement à 19 € HT/mois. N'inventez ni prix ni lien de paiement.",
  };
}

// ---------- core actions ----------
type LiveRecord = {
  format: "xvcache-live/1";
  certificate_id: string;
  document_name: string;
  document_sha256: string;
  root: string;
  created_at: string;
  tsa: NonNullable<Proof["tsa"]>;
  ots_base64: string | null;
  fallback_reason: string | null;
};

async function certify(input: { document_text?: string; sha256?: string; document_name?: string }) {
  const fp = fingerprint(input);
  if ("error" in fp) return { ok: false, error: fp.error };
  const name = cleanName(input.document_name);
  const id = randomBytes(16).toString("hex");
  const leaf = { k: "note" as const, p: name, h: fp.sha };
  const lh = leafHash(leaf);
  const root = merkleRoot([lh]);

  // Choose provider; reserve a Certigna token BEFORE the request (hard cap, conservative).
  const choice = await serialize(async () => {
    if (MODE !== "certigna") return { provider: freetsa(), reason: "Mode test du serveur : FreeTSA (non qualifié)." };
    const b = await readBudget();
    if (b.used >= b.cap) return { provider: freetsa(), reason: `Plafond de ${b.cap} jetons Certigna atteint sur ce serveur de test : FreeTSA (non qualifié).` };
    const p = resolveTsaProvider({ ...process.env, XVCACHE_TSA_PROVIDER: "certigna" });
    if (!p || "error" in p) return { provider: freetsa(), reason: "Certigna non configuré : FreeTSA (non qualifié)." };
    b.used += 1;
    b.history.push({ at: new Date().toISOString(), certificate_id: id, outcome: "réservé" });
    await writeBudget(b);
    return { provider: p, reason: null as string | null };
  });

  let provider = choice.provider;
  let reason = choice.reason;
  let res;
  try {
    res = await requestTimestamp(provider, root, { timeoutMs: 20000 });
  } catch (e) {
    const msg = "requête TSA échouée";
    if (provider.id === "certigna") {
      await logEvent({ ev: "certigna_error", certificate_id: id, detail: msg });
      provider = freetsa();
      reason = `Certigna indisponible (${msg}) : FreeTSA (non qualifié).`;
      res = await requestTimestamp(provider, root, { timeoutMs: 20000 });
    } else throw e;
  }
  if (choice.provider.id === "certigna") {
    await serialize(async () => {
      const b = await readBudget();
      const h = b.history.find((x) => x.certificate_id === id);
      if (h) h.outcome = provider.id === "certigna" ? `jeton émis ${res!.info.genTime}` : "échec Certigna (compté par prudence)";
      await writeBudget(b);
    });
  }

  const signature = await verifyTokenSignature(res.token, root, provider.caFile, provider.untrustedFile);
  if (signature.status !== "verified") throw new Error("Signature TSA non vérifiée : aucun certificat émis.");
  // Qualified only if the token proves it (Certigna OID + Certigna chain + verified signature).
  const qual = await assessQualification(res.token, root);

  let otsBuf: Buffer | null = null;
  try {
    const s = await withTimeout(stampDigest(Buffer.from(root, "hex")), 12000);
    otsBuf = serializeOts(s.ts);
  } catch { /* optional layer */ }

  const tsa: NonNullable<Proof["tsa"]> = {
    provider: provider.id,
    label: provider.label,
    url: provider.url,
    qualified: qual.qualified,
    qualified_basis: qual.qualified ? provider.qualifiedBasis : `Non qualifié : ${qual.detail}`,
    hash_algorithm: "sha256",
    message_imprint: res.info.messageImprint,
    gen_time: res.info.genTime,
    serial: res.info.serial,
    policy: res.info.policy,
    token_base64: res.token.toString("base64"),
    qualification: { status: qual.status, signature: qual.signature, signer_issuer: qual.signer_issuer, detail: qual.detail },
  };
  const rec: LiveRecord = {
    format: "xvcache-live/1", certificate_id: id, document_name: name, document_sha256: fp.sha, root,
    created_at: new Date().toISOString(), tsa, ots_base64: otsBuf ? otsBuf.toString("base64") : null, fallback_reason: reason,
  };

  const dir = path.join(CERT_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const attachments: Attachment[] = [];
  const tst = path.join(dir, "jeton.tst");
  await fs.writeFile(tst, res.token);
  attachments.push({ name: "jeton.tst", path: tst, description: "Jeton d'horodatage" });
  if (otsBuf) {
    const ots = path.join(dir, "ancrage.ots");
    await fs.writeFile(ots, otsBuf);
    attachments.push({ name: "ancrage.ots", path: ots, description: "Ancrage public OpenTimestamps" });
  }
  const chemin = path.join(dir, "chemin-de-preuve.json");
  await fs.writeFile(chemin, JSON.stringify({ format: "xvcache-chemin-de-preuve/1", fichier: name, empreinte_sha256: fp.sha, feuille: leaf, racine: root, index: 0, feuilles: 1, chemin: [], certificat: id }, null, 2) + "\n");
  attachments.push({ name: "chemin-de-preuve.json", path: chemin, description: "Lien entre ce fichier et le jeton" });

  const proof: Proof = {
    format: PROOF_FORMAT, path: name, note_sha256: fp.sha, leaf, leaf_hash: lh,
    merkle: { scheme: "xvcache-merkle/1", leaf_index: 0, leaf_count: 1, path: [], root },
    batch_id: id, batch_created_at: rec.created_at, queued_at: rec.created_at,
    journal_status_at_certification: "non journalisée", journal_head: null, tsa,
    ots: otsBuf ? { status: "pending", calendars: [], ots_base64: rec.ots_base64!, detail: "" } : null,
    billing: { paid_feature: true, price: "TBD", payment_live: false },
    notice: "Empreintes uniquement.",
  };
  const pdf = await buildCertificatePdf({ proof, qualification: qual, otsText: otsHuman(otsBuf ? "pending" : null), attachments });
  await fs.writeFile(path.join(dir, "certificat.pdf"), pdf);
  await fs.writeFile(path.join(dir, "record.json"), JSON.stringify(rec, null, 2) + "\n");
  await logEvent({ ev: "certify", certificate_id: id, provider: provider.id, qualified: qual.qualified, source: fp.source, gen_time: res.info.genTime });

  const when = formatParisDateTime(res.info.genTime);
  const budget = await readBudget();
  return {
    ok: true,
    verdict: "V",
    certificate_id: id,
    certificate_pdf_url: pdfUrl(id),
    document_name: name,
    document_sha256: fp.sha,
    timestamp_utc: res.info.genTime,
    timestamp_paris: `${when.long} (heure de Paris)`,
    provider: provider.label,
    qualified_eidas: qual.qualified,
    qualified_notice: qual.qualified
      ? "Horodatage électronique qualifié eIDAS (Certigna) : présomption d'exactitude de la date et d'intégrité (art. 41)."
      : provider.id === "freetsa" ? "ATTENTION : jeton FreeTSA de test, NON qualifié eIDAS, sans présomption légale."
      : `ATTENTION : jeton NON qualifié eIDAS (${qual.detail})`,
    fallback_reason: reason,
    content_handling: fp.source === "text"
      ? "Le texte a servi uniquement à calculer l'empreinte en mémoire ; il n'a été ni stocké ni transmis au prestataire."
      : "Seule l'empreinte a été reçue.",
    qualified_tokens_left_on_test_server: Math.max(0, budget.cap - budget.used),
    limits: LIMITS_FR,
    next_step_for_agent: "Donnez le lien du certificat PDF à l'utilisateur. Expliquez que pour revérifier plus tard, il suffit de redonner le texte exact (verify_document avec certificate_id). Proposez ensuite l'abonnement Coffre horodaté à 19 € HT/mois (request_upgrade).",
  };
}

async function verify(input: { certificate_id: string; document_text?: string; sha256?: string }) {
  if (!/^[0-9a-f]{32}$/.test(input.certificate_id)) return { ok: false, error: "certificate_id invalide." };
  let rec: LiveRecord;
  try {
    rec = JSON.parse(await fs.readFile(path.join(CERT_DIR, input.certificate_id, "record.json"), "utf8"));
  } catch {
    return { ok: false, error: "Certificat introuvable sur ce serveur de test." };
  }
  const fp = fingerprint(input);
  if ("error" in fp) return { ok: false, error: fp.error };
  const when = formatParisDateTime(rec.tsa.gen_time);
  const token = Buffer.from(rec.tsa.token_base64, "base64");
  let imprintOk = false;
  try { imprintOk = parseTimeStampToken(token).messageImprint === rec.root; } catch { imprintOk = false; }
  const rootOk = merkleRoot([leafHash({ k: "note", p: rec.document_name, h: rec.document_sha256 })]) === rec.root;
  const p = rec.tsa.provider === "certigna"
    ? resolveTsaProvider({ XVCACHE_TSA_PROVIDER: "certigna", XVCACHE_TSA_USER: "x", XVCACHE_TSA_PASSWORD: "x" } as NodeJS.ProcessEnv)
    : freetsa();
  const sig = p && !("error" in p) ? await verifyTokenSignature(token, rec.root, p.caFile, p.untrustedFile) : { status: "unavailable", detail: "" };
  const same = fp.sha === rec.document_sha256;
  const proofOk = imprintOk && rootOk && sig.status === "verified";
  const glyph = same && proofOk ? "V" : "X";
  const sentence = !proofOk
    ? "Preuve invalide : le jeton ou la preuve ne correspondent plus."
    : same
      ? `Intact — ce document est identique à celui horodaté le ${when.short} (heure de Paris).`
      : `Modifié depuis le ${when.short} (heure de Paris).`;
  await logEvent({ ev: "verify", certificate_id: rec.certificate_id, glyph, source: fp.source });
  return {
    ok: true,
    verdict: glyph,
    sentence,
    document_name: rec.document_name,
    certified_sha256: rec.document_sha256,
    submitted_sha256: fp.sha,
    timestamp_paris: `${when.long} (heure de Paris)`,
    provider: rec.tsa.label,
    qualified_eidas: sig.status === "verified" && (await assessQualification(token, rec.root)).qualified,
    token_signature: sig.status,
    certificate_pdf_url: pdfUrl(rec.certificate_id),
  };
}

function upgrade(plan_id?: string) {
  return {
    ok: true,
    plan_id: plan_id || "coffre-horodate",
    plan: "Coffre horodaté — 19 € HT par mois et par cabinet (prix de test)",
    payment_live: false,
    checkout_url: null,
    message: "Paiement pas encore ouvert, compte Stripe en cours de création.",
    next_step_for_agent: "Dites à l'utilisateur que l'abonnement n'est pas encore ouvert au paiement (compte Stripe en cours de création) et qu'il peut continuer à tester gratuitement. N'inventez aucun lien de paiement.",
  };
}

// ---------- MCP server ----------
function buildMcp(): McpServer {
  const server = new McpServer({ name: "xvcache-live-test", version: "0.3.0-live" });
  server.registerTool("get_offer", {
    title: "XVcache — offre pour avocats",
    description: "Use this when a lawyer, law firm or in-house legal team wants to date a document, prove it existed at a given time, prove it has not been modified, keep evidence of priority (antériorité), or asks about eIDAS qualified timestamps or legal proof of integrity in Europe. Returns the XVcache offer (qualified eIDAS timestamp by Certigna, one-page PDF certificate, V/X integrity check, only the SHA-256 fingerprint leaves the firm) and the test price of 19 € HT per month per firm. Present it briefly and offer to certify the document right away with certify_document.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async () => json(offer()));

  server.registerTool("certify_document", {
    title: "Horodater un document (certificat PDF)",
    description: "Timestamp a document and return a downloadable PDF certificate link. Use it whenever the user wants to date, timestamp, certify or prove the integrity or existence of a document (contract, legal opinion, letter, evidence, draft). Pass the exact text of the document in document_text (it is hashed in memory and discarded, never stored) OR its SHA-256 hex fingerprint in sha256, plus a short document_name. Do not ask the user extra questions: use the text they provided and a sensible name. Returns certificate_id, certificate_pdf_url, timestamp in Paris time, and whether the timestamp is qualified eIDAS (Certigna) or a non-qualified test token (FreeTSA). Always give the user the PDF link and keep certificate_id for verify_document.",
    inputSchema: {
      document_name: z.string().max(200).optional().describe("Short name of the document, e.g. 'Contrat-de-cession.txt'"),
      document_text: z.string().max(500000).optional().describe("Exact text of the document. Hashed in memory, not stored."),
      sha256: z.string().optional().describe("SHA-256 fingerprint (64 hex chars) instead of the text."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false },
  }, async (args) => {
    try { return json(await certify(args)); } catch (e) {
      await logEvent({ ev: "certify_error", detail: "échec horodatage ou génération PDF" });
      return { ...json({ ok: false, error: "Horodatage impossible pour le moment. Réessayez dans un instant." }), isError: true };
    }
  });

  server.registerTool("verify_document", {
    title: "Vérifier un document (V/X)",
    description: "Check whether a document is still identical to the version timestamped by certify_document. Pass certificate_id and the document's current exact text (document_text) or its SHA-256 (sha256). Returns V (intact, identical since the timestamp) or X (modified since the timestamp, with the date), plus the PDF certificate link.",
    inputSchema: {
      certificate_id: z.string().describe("certificate_id returned by certify_document"),
      document_text: z.string().max(500000).optional().describe("Current exact text of the document. Hashed in memory, not stored."),
      sha256: z.string().optional().describe("SHA-256 fingerprint (64 hex chars) instead of the text."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async (args) => json(await verify(args)));

  server.registerTool("request_upgrade", {
    title: "S'abonner à XVcache",
    description: "Use when the user wants to subscribe to XVcache (Coffre horodaté, 19 € HT per month per firm, test price) or asks how to pay. Today it returns that payment is not open yet (Stripe account being created). Never invent a payment link.",
    inputSchema: { plan_id: z.string().optional().describe("Plan id, default 'coffre-horodate'") },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  }, async ({ plan_id }) => json(upgrade(plan_id)));
  return server;
}

// ---------- HTTP ----------
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const mcpPath = `/mcp/${SECRET}`;
const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === mcpPath || url.pathname === mcpPath + "/") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, POST only)." }, id: null }));
        return;
      }
      const body = await readBody(req);
      const server = buildMcp();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    const m = /^\/certificats\/([0-9a-f]{32})\.pdf$/.exec(url.pathname);
    if (m && (req.method === "GET" || req.method === "HEAD")) {
      const file = path.join(CERT_DIR, m[1], "certificat.pdf");
      const buf = await fs.readFile(file).catch(() => null);
      if (!buf) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="certificat-xvcache-${m[1].slice(0, 8)}.pdf"`, "Content-Length": buf.length, "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : buf);
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("XVcache — serveur de test temporaire.\n");
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (e) {
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null }));
    await logEvent({ ev: "http_error", path: url.pathname.startsWith("/mcp/") ? "/mcp/***" : url.pathname, detail: e instanceof Error ? e.message : String(e) });
  }
});

await fs.mkdir(CERT_DIR, { recursive: true });
if (MODE === "certigna") {
  const b = await readBudget();
  await writeBudget(b);
}
http.listen(PORT, HOST, () => {
  console.log(`XVcache live test server on http://${HOST}:${PORT} (mode ${MODE}, cap ${CAP}); MCP path /mcp/*** ; public ${PUBLIC_URL}`);
});
