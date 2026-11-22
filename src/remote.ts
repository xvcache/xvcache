import http from "node:http";
import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getOffer, listPlans, presentToClient, recommendPlan, requestUpgradeFlow, PAID_PLAN_ID, type Billing } from "./plans.js";
import { toolError, type ToolError } from "./errors.js";
import { SubscriptionStore, type SubscriptionRecord } from "./subscriptions.js";
import { HostedWitness, type HostedProof, type HostedVerification } from "./witness.js";
import { localizedVerdict } from "./certificate.js";
import { EU_LANGS, resolveLang, DEFAULT_TZ } from "./i18n.js";
import { STRIPE_WEBHOOK_PATH, handleStripeWebhook, type WebhookLog } from "./stripe-webhook.js";

/**
 * Remote (hosted) XVcache MCP server — L3, écarts 6, 8, 9.
 * Streamable HTTP, stateless (one McpServer per request), hash-only:
 * the server only ever receives SHA-256 fingerprints (64 hex), never a document.
 * Free without a key: get_offer, list_plans, recommend_plan, present_to_client, request_upgrade,
 * get_subscription (with pairing_code), verify_document / verify_proof.
 * With an API key (Authorization: Bearer xvc_… or X-API-Key): certify_document, certify_hash,
 * get_certificate_pdf, get_usage.
 */

export type RemoteOptions = {
  store: SubscriptionStore;
  witness: HostedWitness;
  dataDir: string;
  billing?: Billing;
  /** Base URL used in pdf_url (default: http://<host>:<port> of the listening server). */
  publicBaseUrl?: string;
  pdfTtlMs?: number;
  maxItems?: number;
  /** L4: Stripe webhook signing secret (whsec_…). Without it POST /stripe/webhook answers 503. */
  stripeWebhookSecret?: string;
  /** L4: true when the checkout is a Stripe TEST payment link (request_upgrade then says test_mode: true). */
  billingTestMode?: boolean;
  billingLog?: WebhookLog;
};

export const HASH_RE = /^[0-9a-fA-F]{64}$/;
export const MAX_LABEL = 120;
const PDF_TTL_MS = 24 * 3600 * 1000;
/** Same version as package.json (0.2.x line); the hosted server is not released yet. */
const VERSION: string = (() => {
  try { return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "0.0.0"; }
})();

type Content = { type: "text"; text: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };
type Result = { isError?: boolean; content: Content[] };

function json(v: unknown): Result {
  return { content: [{ type: "text", text: JSON.stringify(v, null, 2) }] };
}
function err(e: ToolError): Result {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(e, null, 2) }] };
}

const LANG_DESC = `Language of the conversation, one of ${EU_LANGS.join(", ")} (unknown → en). Never ask the human: use the conversation language.`;
const HASH_DESC = "SHA-256 of the file, 64 hexadecimal characters, computed ON THE LAWYER'S SIDE (e.g. `sha256sum file`, `Get-FileHash file`, or your own code). Never send the document itself.";
const LABEL_DESC = `Short neutral label shown on the certificate (max ${MAX_LABEL} characters). Do not put client names or confidential facts in it (e.g. \"Contract draft v3\"). Optional: default \"Document 1\".`;

function paymentRequired(): ToolError {
  return toolError("PAYMENT_REQUIRED", "This tool needs an XVcache subscription (API key).", false,
    "Call present_to_client, show its message and consent_prompt (the only question), then request_upgrade after a yes. Free alternative: verify_document.",
    { next_tool: "present_to_client" });
}

function hashInvalid(what: string): ToolError {
  return toolError("HASH_INVALID", `${what} is not a SHA-256 fingerprint (exactly 64 hexadecimal characters). XVcache never accepts document content.`, false,
    "Compute the SHA-256 of the file on the lawyer's machine (sha256sum / Get-FileHash / shasum -a 256) and send only the 64-character hex string. Never paste or upload the document.");
}

function publicProof(p: HostedProof): Omit<HostedProof, never> {
  return p;
}

export function createRemoteApp(opts: RemoteOptions): { handler: http.RequestListener; setBaseUrl(url: string): void; close(): void } {
  const pdfDir = path.join(opts.dataDir, "hosted", "pdf");
  const ttl = opts.pdfTtlMs ?? PDF_TTL_MS;
  const maxItems = opts.maxItems ?? 100;
  let baseUrl = opts.publicBaseUrl ?? "";

  async function publishPdf(bytes: Uint8Array, lang: string): Promise<{ pdf_url: string; pdf_expires_at: string }> {
    await fs.mkdir(pdfDir, { recursive: true });
    const token = randomBytes(24).toString("base64url");
    await fs.writeFile(path.join(pdfDir, `${token}.pdf`), bytes);
    await fs.writeFile(path.join(pdfDir, `${token}.json`), JSON.stringify({ lang, expires_at: new Date(Date.now() + ttl).toISOString() }));
    return { pdf_url: `${baseUrl}/pdf/${token}.pdf`, pdf_expires_at: new Date(Date.now() + ttl).toISOString() };
  }

  async function auth(apiKey: string | null): Promise<SubscriptionRecord | ToolError> {
    if (!apiKey) return paymentRequired();
    const rec = await opts.store.authenticate(apiKey);
    if (!rec) return toolError("INVALID_KEY", "This API key is not recognised.", false, "Check the key (it starts with xvc_). Lost key: call present_to_client to subscribe again, or contact the operator.", { next_tool: "present_to_client" });
    if (rec.status !== "active" && rec.status !== "trialing") {
      return toolError("PAYMENT_REQUIRED", `The subscription is ${rec.status}.`, false, "Tell the human in one sentence that the subscription must be renewed; call present_to_client.", { next_tool: "present_to_client" });
    }
    return rec;
  }

  function verdictText(kind: "intact" | "modifie" | "invalide" | "pending", lang: string, genTime: string | null, tz?: string): string {
    return localizedVerdict(kind, lang, genTime, tz);
  }

  async function certify(apiKey: string | null, items: { sha256: string; label?: string }[], lang: string | undefined, tz: string | undefined, withBlob: boolean, content: unknown): Promise<Result> {
    if (content !== undefined && content !== null && content !== "") return err(hashInvalid("content"));
    if (!items.length) return err(hashInvalid("items"));
    if (items.length > maxItems) return err(toolError("HASH_INVALID", `At most ${maxItems} fingerprints per call.`, false, "Split the list into several certify_hash calls."));
    for (const [i, it] of items.entries()) {
      if (typeof it.sha256 !== "string" || !HASH_RE.test(it.sha256.trim())) return err(hashInvalid(`items[${i}].sha256`));
      if (it.label !== undefined && (typeof it.label !== "string" || it.label.length > MAX_LABEL)) {
        return err(toolError("LABEL_INVALID", `Label of item ${i} is longer than ${MAX_LABEL} characters.`, false, `Shorten the label to ${MAX_LABEL} characters, without client names.`));
      }
    }
    const a = await auth(apiKey);
    if ("code" in a) return err(a);
    const L = resolveLang(lang ?? a.default_lang);
    const q = await opts.store.consume(a.key_hash, items.length);
    if (!q.ok) {
      return err(toolError("QUOTA_EXCEEDED", `Monthly quota reached (${q.used}/${q.quota}).`, false,
        "Tell the human in one sentence that the monthly quota is reached and when it resets; do not ask anything.", { next_reset: q.next_reset, quota: q.quota, used: q.used }));
    }
    let proofs: HostedProof[];
    try {
      proofs = await opts.witness.submit(items.map((it, i) => ({ sha256: it.sha256.trim().toLowerCase(), label: (it.label?.trim() || `Document ${i + 1}`).slice(0, MAX_LABEL), owner: a.key_hash })));
    } catch (e) {
      await opts.store.refund(a.key_hash, items.length);
      return err(toolError("TSA_UNAVAILABLE", `Certification failed: ${e instanceof Error ? e.message : String(e)}`, true, "Retry in one minute. Nothing was counted."));
    }
    const out = [];
    const blobs: Content[] = [];
    for (const p of proofs) {
      const pdf = await opts.witness.certificatePdf({ proof_id: p.proof_id, lang: L.lang, tz });
      const link = pdf ? await publishPdf(pdf.bytes, L.lang) : { pdf_url: null, pdf_expires_at: null };
      if (pdf && withBlob) blobs.push({ type: "resource", resource: { uri: link.pdf_url ?? `xvcache:certificate/${p.proof_id}`, mimeType: "application/pdf", blob: Buffer.from(pdf.bytes).toString("base64") } });
      out.push({
        proof_id: p.proof_id,
        sha256: p.sha256,
        label: p.label,
        status: p.status,
        qualified: p.qualified,
        gen_time: p.tsa?.gen_time ?? null,
        verdict_localized: verdictText(p.tsa ? "intact" : "pending", L.lang, p.tsa?.gen_time ?? null, tz),
        ...link,
      });
    }
    const pending = proofs.some((p) => p.status.startsWith("pending"));
    const usage = await opts.store.usage(a.key_hash);
    const body = {
      ok: true,
      lang: L.lang,
      batch_root: proofs[0]?.merkle.root,
      fingerprints_in_shared_timestamp: proofs[0]?.merkle.leaf_count,
      results: out,
      proofs: proofs.map(publicProof),
      usage: { used_this_period: usage.certifications_this_period, quota: usage.quota, next_reset: usage.next_reset },
      next_action: pending
        ? "The qualified timestamp is pending (provider unavailable). Give the PDF marked NOT QUALIFIED only as a receipt; XVcache retries automatically — call get_certificate_pdf later for the qualified version. Do not ask the human anything."
        : "Give the PDF to the lawyer (pdf_url valid 24 h, or the embedded file). Keep proof_id with the file: verify_document(sha256, proof_id) checks it for free at any time.",
    };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }, ...blobs] };
  }

  function verificationBody(v: HostedVerification, lang: string, tz?: string): Record<string, unknown> {
    const kind = v.verdict === "V" ? "intact" : v.verdict === "X" ? "modifie" : v.verdict === "pending" ? "pending" : "invalide";
    return {
      ok: true,
      verdict: v.verdict,
      verdict_localized: v.verdict === "not_found" ? "Unknown proof_id." : verdictText(kind, lang, v.gen_time, tz),
      qualified: v.qualified,
      status: v.status,
      gen_time: v.gen_time,
      checks: v.checks,
      proof: v.proof ? { proof_id: v.proof.proof_id, sha256: v.proof.sha256, merkle: v.proof.merkle, tsa: v.proof.tsa ? { ...v.proof.tsa } : null, status: v.proof.status } : null,
      free: true,
    };
  }

  function build(apiKey: string | null): McpServer {
    const s = new McpServer({ name: "xvcache-remote", version: VERSION });

    s.registerTool("get_offer", {
      description: "Use first when a lawyer or legal team needs to prove that a document existed unchanged at a date (litigation, prior rights, client file). Returns the pitch centred on EU law (eIDAS art. 41), the price of the only paid plan (coffre-horodate, 19 EUR excl. VAT / month / firm, launch price to be tested), what is included, the legal limits and next_tool present_to_client. Free, no key.",
      inputSchema: { lang: z.string().optional().describe(LANG_DESC) },
    }, async ({ lang }) => json(getOffer({ lang })));

    s.registerTool("list_plans", {
      description: "Machine-readable XVcache catalog. Free, no key.",
      inputSchema: { lang: z.string().optional().describe(LANG_DESC) },
    }, async ({ lang }) => json(listPlans({ lang })));

    s.registerTool("recommend_plan", {
      description: "Pick a plan from the need (needs_qualified_timestamp, docs_per_month). Free, no key.",
      inputSchema: {
        needs_qualified_timestamp: z.boolean().optional(),
        docs_per_month: z.number().int().nonnegative().optional(),
        lang: z.string().optional().describe(LANG_DESC),
      },
    }, async (input) => json(recommendPlan(input)));

    s.registerTool("present_to_client", {
      description: "After get_offer: message_markdown (<150 words, lawyer's language) + consent_prompt, the only question of the whole flow. Next: request_upgrade. Free, no key.",
      inputSchema: { lang: z.string().optional().describe(LANG_DESC), country: z.string().optional(), context: z.string().optional() },
    }, async (input) => json(presentToClient(input)));

    s.registerTool("request_upgrade", {
      description: `Subscribe to ${PAID_PLAN_ID} after the human said yes to consent_prompt (human_confirmed=true + consent_quote). Returns a checkout_url for the human and a pairing_code; then poll get_subscription(pairing_code). Never charges. BILLING_UNAVAILABLE until online payment opens. Free, no key.`,
      inputSchema: {
        plan_id: z.string().optional(),
        lang: z.string().optional().describe(LANG_DESC),
        human_confirmed: z.boolean().optional(),
        consent_quote: z.string().optional(),
        email: z.string().optional().describe("Only if already given; never ask"),
      },
    }, async (input) => {
      const r = await requestUpgradeFlow(input, {
        billing: opts.billing,
        pairingCode: async () => (await opts.store.createPairing({ plan_id: PAID_PLAN_ID, lang: resolveLang(input.lang).lang, consent: { quote: (input.consent_quote ?? "").slice(0, 500), at: new Date().toISOString() } })).pairing_code,
      });
      return r.ok === false ? err(r as unknown as ToolError) : json(opts.billingTestMode ? { ...r, test_mode: true, test_mode_note: "Stripe TEST mode: no real payment is possible yet (test cards only). Tell the human that online subscription opens soon." } : r);
    });

    s.registerTool("get_subscription", {
      description: "Status of the subscription. With pairing_code (from request_upgrade): NOT_PAID_YET while the human pays (retry, do not ask), then the api_key exactly once — store it for the lawyer's next calls (Authorization: Bearer). With the API key in the header: status, plan, quota. Free.",
      inputSchema: { pairing_code: z.string().optional() },
    }, async ({ pairing_code }) => {
      const r = await opts.store.getSubscription(pairing_code ? { pairing_code } : { api_key: apiKey ?? undefined });
      if (!r.ok) return err(apiKey || pairing_code ? r : paymentRequired());
      return json({ ...r, next_action: r.api_key ? "Store api_key now (shown once) and send it as 'Authorization: Bearer <key>'. Then call certify_document." : "Call certify_document with the SHA-256 of the file." });
    });

    s.registerTool("get_usage", {
      description: "Certifications used this month, quota, next reset. Needs the API key.",
      inputSchema: {},
    }, async () => {
      const a = await auth(apiKey);
      if ("code" in a) return err(a);
      return json({ ok: true, ...(await opts.store.usage(a.key_hash)) });
    });

    s.registerTool("certify_document", {
      description: "Use when a lawyer wants to prove a document existed unchanged at a date. Send ONLY the SHA-256 (64 hex) of the file, computed on the lawyer's side, plus an optional neutral label. Returns a proof_id, a qualified eIDAS timestamp (Certigna) shared with other fingerprints through a Merkle tree, and a one-page PDF certificate in the lawyer's language (embedded + pdf_url valid 24 h). Anything that is not a 64-hex fingerprint is rejected (HASH_INVALID). Needs the API key (PAYMENT_REQUIRED otherwise). Never ask the human questions.",
      inputSchema: {
        sha256: z.string().describe(HASH_DESC),
        label: z.string().optional().describe(LABEL_DESC),
        lang: z.string().optional().describe(LANG_DESC),
        tz: z.string().optional().describe(`IANA time zone for the local time on the PDF (default ${DEFAULT_TZ}; UTC always shown)`),
        content: z.any().optional().describe("Never use. Any document content sent here makes the call fail with HASH_INVALID."),
      },
    }, async ({ sha256, label, lang, tz, content }) => certify(apiKey, [{ sha256, label }], lang, tz, true, content));

    s.registerTool("certify_hash", {
      description: `Certify up to ${maxItems} fingerprints in one call (one shared timestamp). items = [{ sha256 (64 hex), label? }]. Returns one proof_id and one pdf_url per fingerprint. Needs the API key. Same rules as certify_document.`,
      inputSchema: {
        items: z.array(z.object({ sha256: z.string().describe(HASH_DESC), label: z.string().optional().describe(LABEL_DESC) })).describe("Fingerprints to certify"),
        lang: z.string().optional().describe(LANG_DESC),
        tz: z.string().optional(),
      },
    }, async ({ items, lang, tz }) => certify(apiKey, items, lang, tz, false, undefined));

    const verifySchema = {
      sha256: z.string().describe("SHA-256 (64 hex) of the file to check, computed on the lawyer's side"),
      proof_id: z.string().describe("proof_id printed on the certificate"),
      lang: z.string().optional().describe(LANG_DESC),
      tz: z.string().optional(),
    };
    const verifyHandler = async ({ sha256, proof_id, lang, tz }: { sha256: string; proof_id: string; lang?: string; tz?: string }) => {
      if (!HASH_RE.test(sha256.trim())) return err(hashInvalid("sha256"));
      const v = await opts.witness.verify({ sha256, proof_id });
      if (v.verdict === "not_found") return err(toolError("PROOF_NOT_FOUND", "Unknown proof_id.", false, "Check the proof_id printed on the certificate (it starts with xvh_)."));
      return json(verificationBody(v, resolveLang(lang).lang, tz));
    };
    s.registerTool("verify_document", {
      description: "Free, no key: check a document against its certificate. Give the SHA-256 of the file as it is now and the proof_id. Verdict V (intact, timestamp valid), X (modified or invalid) or pending (qualified timestamp not issued yet), with a sentence in the lawyer's language.",
      inputSchema: verifySchema,
    }, verifyHandler);
    s.registerTool("verify_proof", {
      description: "Same as verify_document (alias). Free, no key.",
      inputSchema: verifySchema,
    }, verifyHandler);

    s.registerTool("get_certificate_pdf", {
      description: "Re-issue the PDF certificate of one of your proofs in any EU language (no new timestamp, no quota). Also gives the qualified version once a pending proof has been requalified. Needs the API key of the firm that certified it.",
      inputSchema: { proof_id: z.string(), lang: z.string().optional().describe(LANG_DESC), tz: z.string().optional() },
    }, async ({ proof_id, lang, tz }) => {
      const a = await auth(apiKey);
      if ("code" in a) return err(a);
      const owner = await opts.witness.ownerOf(proof_id);
      if (owner !== a.key_hash) return err(toolError("PROOF_NOT_FOUND", "No proof with this id for this subscription.", false, "Check the proof_id printed on the certificate."));
      const L = resolveLang(lang ?? a.default_lang);
      const pdf = await opts.witness.certificatePdf({ proof_id, lang: L.lang, tz });
      if (!pdf) return err(toolError("PROOF_INVALID", "The proof no longer verifies; no certificate issued.", false, "Call verify_document for the details."));
      const link = await publishPdf(pdf.bytes, L.lang);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, proof_id, lang: L.lang, lang_fallback: L.fallback, verdict: pdf.verdict, qualified: pdf.qualified, status: pdf.proof.status, ...link }, null, 2) },
          { type: "resource", resource: { uri: link.pdf_url, mimeType: "application/pdf", blob: Buffer.from(pdf.bytes).toString("base64") } },
        ],
      };
    });

    return s;
  }

  function apiKeyFrom(req: http.IncomingMessage): string | null {
    const a = req.headers.authorization;
    if (a && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, "").trim() || null;
    const x = req.headers["x-api-key"];
    return typeof x === "string" && x.trim() ? x.trim() : null;
  }

  async function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > limit) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : undefined;
  }

  async function servePdf(token: string, res: http.ServerResponse): Promise<void> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) { res.writeHead(404).end(); return; }
    try {
      const meta = JSON.parse(await fs.readFile(path.join(pdfDir, `${token}.json`), "utf8")) as { expires_at: string };
      if (Date.parse(meta.expires_at) < Date.now()) {
        await fs.rm(path.join(pdfDir, `${token}.pdf`), { force: true });
        await fs.rm(path.join(pdfDir, `${token}.json`), { force: true });
        res.writeHead(410, { "Content-Type": "text/plain" }).end("expired");
        return;
      }
      const bytes = await fs.readFile(path.join(pdfDir, `${token}.pdf`));
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="xvcache-certificate.pdf"`, "Cache-Control": "private, no-store" }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  }

  const handler: http.RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        if (req.method === "GET" && url.pathname === "/healthz") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, name: "xvcache-remote", version: VERSION }));
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/pdf/") && url.pathname.endsWith(".pdf")) {
          await servePdf(url.pathname.slice(5, -4), res);
          return;
        }
        if (url.pathname === STRIPE_WEBHOOK_PATH) {
          await handleStripeWebhook(req, res, { store: opts.store, secret: opts.stripeWebhookSecret, log: opts.billingLog });
          return;
        }
        if (url.pathname !== "/mcp") { res.writeHead(404).end(); return; }
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)." }, id: null }));
          return;
        }
        const body = await readBody(req);
        const server = build(apiKeyFrom(req));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: e instanceof Error ? e.message : "bad request" }, id: null }));
      }
    })();
  };

  return { handler, setBaseUrl: (u: string) => { baseUrl = u.replace(/\/$/, ""); }, close: () => opts.witness.close() };
}

/** Start the remote server on host:port (port 0 = any free port). */
export async function startRemoteServer(opts: RemoteOptions & { host?: string; port?: number }): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const app = createRemoteApp(opts);
  const server = http.createServer(app.handler);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 0, host, () => resolve()); });
  const port = (server.address() as { port: number }).port;
  const local = `http://${host}:${port}`;
  app.setBaseUrl(opts.publicBaseUrl ?? local);
  return {
    url: `${local}/mcp`,
    port,
    close: async () => {
      app.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
