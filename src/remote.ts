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
import { KEY_PAGE_PREFIX, handleKeyPage, type KeyDeliveryService } from "./key-delivery.js";

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
  /** 0.3.0: email delivery of a one-time link to the key after payment (off unless given). */
  keyDelivery?: KeyDeliveryService;
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
const LABEL_DESC = `Short neutral label shown on the PDF report (max ${MAX_LABEL} characters). Do not put client names or confidential facts in it (e.g. \"Contract draft v3\"). Optional: default \"Document 1\".`;

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
  // Usage is counted when a proof obtains its token (never while pending).
  opts.witness.useUsageCounter((owner, n) => opts.store.recordTimestamped(owner, n));

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


  /** Public usage: informational counter only. Proofs are not capped; never expose quota or next_reset. */
  function publicUsage(u: { plan_id?: string; status?: string; certifications_this_period: number; total_certified?: number; period_start?: string; quota?: unknown; remaining?: unknown; next_reset?: unknown }) {
    return {
      plan_id: u.plan_id,
      status: u.status,
      certifications_this_period: u.certifications_this_period,
      used_this_period: u.certifications_this_period,
      total_certified: u.total_certified,
      period_start: u.period_start,
    };
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
    // Proofs are not capped (decision of 23/11/2026): informational counter only. Never QUOTA_EXCEEDED.
    let proofs: HostedProof[];
    try {
      proofs = await opts.witness.submit(items.map((it, i) => ({ sha256: it.sha256.trim().toLowerCase(), label: (it.label?.trim() || `Document ${i + 1}`).slice(0, MAX_LABEL), owner: a.key_hash })));
    } catch (e) {
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
        // Recomputed from the token (OID + Certigna chain + verified signature), never from config.
        status: pdf ? pdf.proof.status : p.status,
        qualified: pdf ? pdf.qualified : false,
        gen_time: p.tsa?.gen_time ?? null,
        ...(p.merkle ? {} : { anchor_due_at: p.anchor_due_at ?? null }),
        verdict_localized: verdictText(p.tsa ? "intact" : "pending", L.lang, p.tsa?.gen_time ?? null, tz),
        ...link,
      });
    }
    const pending = proofs.some((p) => p.status.startsWith("pending"));
    const usage = await opts.store.usage(a.key_hash);
    const body = {
      ok: true,
      lang: L.lang,
      batch_root: proofs[0]?.merkle?.root ?? null,
      fingerprints_in_shared_timestamp: proofs[0]?.merkle?.leaf_count ?? null,
      results: out,
      proofs: proofs.map(publicProof),
      usage: publicUsage(usage),
      next_action: proofs.some((p) => !p.merkle)
        ? `Queued for the daily shared timestamp (one Merkle root for all subscribers, stamped once a day; the certified date will be the issue time of that daily token, not the submission time; due ${proofs.find((p) => !p.merkle)?.anchor_due_at ?? "today"}). The PDF given now is only a receipt marked NOT QUALIFIED. After that time, call get_report_pdf(proof_id) (or get_certificate_pdf, deprecated) for the report with the timestamp token (The hosted endpoint, currently in demo, requests its tokens from Certigna, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified.). A pending proof is not counted. Do not ask the human anything.`
        : pending
        ? "The qualified timestamp is pending (provider unavailable). Give the PDF marked NOT QUALIFIED only as a receipt; XVcache retries automatically — call get_certificate_pdf later for the qualified version. A pending proof is not counted. Do not ask the human anything."
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
      signature: v.signature,
      qualification: v.qualification,
      gen_time: v.gen_time,
      checks: v.checks,
      proof: v.proof ? { proof_id: v.proof.proof_id, sha256: v.proof.sha256, merkle: v.proof.merkle, tsa: v.proof.tsa ? { ...v.proof.tsa } : null, status: v.proof.status } : null,
      free: true,
    };
  }

  function build(apiKey: string | null): McpServer {
    const s = new McpServer({ name: "xvcache-remote", version: VERSION });

    s.registerTool("get_offer", {
      description: "Use first when a lawyer or legal team needs dated evidence that a document existed unchanged at a date (litigation, prior rights, client file). Returns the offer: the planned XVcache Coffre horodaté subscription, published by RENO'LINE SARL, not on sale yet. Planned pricing, not on sale yet: Essentiel €29 excl. VAT / month · Cabinet €59 excl. VAT / month · launch price €19 excl. VAT / month for Essentiel, for the first 50 organisations, while the subscription stays active · professionals only · demos by application. The planned subscription will use qualified eIDAS timestamps issued by Certigna, a qualified trust service provider (legal presumption of date and integrity, eIDAS art. 41(2); recognised in all Member States, art. 24a(6)). The hosted endpoint, currently in demo, requests its tokens from Certigna, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. XVcache itself is not a qualified trust service provider. States the legal limits and the pending case. Next tool: present_to_client. Free, no key.",
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
      description: "After get_offer: message_markdown (<180 words, lawyer's language) + consent_prompt, the only question of the whole flow. Next: request_upgrade. Free, no key.",
      inputSchema: { lang: z.string().optional().describe(LANG_DESC), country: z.string().optional(), context: z.string().optional() },
    }, async (input) => json(presentToClient(input)));

    s.registerTool("request_upgrade", {
      description: `Subscribe to ${PAID_PLAN_ID} after the human said yes to consent_prompt (human_confirmed=true + consent_quote). Never charges. Until sales are open, returns BILLING_UNAVAILABLE (no payment link). When sales open, returns a pairing_code to poll get_subscription. Free, no key.`,
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
        allowTestCheckout: opts.billingTestMode === true,
        pairingCode: async () => (await opts.store.createPairing({ plan_id: PAID_PLAN_ID, lang: resolveLang(input.lang).lang, consent: { quote: (input.consent_quote ?? "").slice(0, 500), at: new Date().toISOString() } })).pairing_code,
      });
      return r.ok === false ? err(r as unknown as ToolError) : json(opts.billingTestMode ? { ...r, test_mode: true, test_mode_note: "Stripe TEST mode: no real payment is possible (test cards only). Tell the human that online subscription is not open yet (sales opening to be confirmed) and that nothing was charged." } : r);
    });

    s.registerTool("get_subscription", {
      description: "Status of the subscription. With pairing_code (from request_upgrade): NOT_PAID_YET while the human pays (retry about every 20 s, do not ask), then api_key EXACTLY ONCE. When api_key is returned: show it to the human immediately in your reply, once, and tell them to save it now in a password manager, because this tool never returns it again. Keep it for the next calls (Authorization: Bearer <key>). With the API key in the header: status, plan, usage. Free.",
      inputSchema: { pairing_code: z.string().optional() },
    }, async ({ pairing_code }) => {
      const r = await opts.store.getSubscription(pairing_code ? { pairing_code } : { api_key: apiKey ?? undefined });
      if (!r.ok) return err(apiKey || pairing_code ? r : paymentRequired());
      const once = "Show api_key to the human NOW, once, in your reply, and tell them to save it immediately (password manager): it will never be returned again by this tool."
        + (opts.keyDelivery ? " A one-time link to view it once was also emailed to the payer (the key itself is never emailed; the link expires after 24 h)." : "")
        + " Then send it as 'Authorization: Bearer <key>' and call certify_document.";
      const pub: Record<string, unknown> = { ...r, next_action: r.api_key ? once : "Call certify_document with the SHA-256 of the file." };
      delete pub.quota;
      delete pub.next_reset;
      return json(pub);
    });

    s.registerTool("get_usage", {
      description: "Usage information for this month (informational counter; proofs are not capped). Needs the API key.",
      inputSchema: {},
    }, async () => {
      const a = await auth(apiKey);
      if ("code" in a) return err(a);
      return json({ ok: true, ...publicUsage(await opts.store.usage(a.key_hash)) });
    });

    s.registerTool("certify_document", {
      description: "Use when a lawyer wants dated evidence that a document existed unchanged at a date. Send the SHA-256 (64 hex) of the file, computed on the client side, plus an optional neutral label (max 120 characters, no client names or confidential facts); the server also processes the caller's IP address. Never send the document. Returns a proof_id at once. The hosted endpoint, currently in demo, requests its tokens from Certigna, with no fallback to FreeTSA. The Coffre horodaté subscription is not on sale yet. Local version: FreeTSA by default, not qualified. In the planned Coffre horodaté subscription, from version 0.3.0 of the hosted server, fingerprints will be grouped into one daily Merkle root shared by all customers, timestamped once a day (around 21:50 UTC) by Certigna (qualified eIDAS). The timestamp time is that of the daily token, not the time of submission; until then the proof is pending and the one-page PDF report (embedded + pdf_url valid 24 h) is a receipt marked NOT QUALIFIED. After anchor_due_at, get_report_pdf (preferred) or get_certificate_pdf (deprecated alias) returns the report with the token. If Certigna does not issue a token (service unavailable or supply incident), the request stays pending (pending_qualified), with no fallback to FreeTSA. Pending proofs are not counted. Anything that is not a 64-hex fingerprint is rejected (HASH_INVALID). Needs the API key (PAYMENT_REQUIRED otherwise). Never ask the human questions.",
      inputSchema: {
        sha256: z.string().describe(HASH_DESC),
        label: z.string().optional().describe(LABEL_DESC),
        lang: z.string().optional().describe(LANG_DESC),
        tz: z.string().optional().describe(`IANA time zone for the local time on the PDF (default ${DEFAULT_TZ}; UTC always shown)`),
        content: z.any().optional().describe("Never use. Any document content sent here makes the call fail with HASH_INVALID."),
      },
    }, async ({ sha256, label, lang, tz, content }) => certify(apiKey, [{ sha256, label }], lang, tz, true, content));

    s.registerTool("certify_hash", {
      description: `Timestamp up to ${maxItems} fingerprints in one call (from 0.3.0 they join the planned daily shared timestamp). items = [{ sha256 (64 hex), label? }]. Returns one proof_id and one pdf_url per fingerprint. Needs the API key. Same rules as certify_document.`,
      inputSchema: {
        items: z.array(z.object({ sha256: z.string().describe(HASH_DESC), label: z.string().optional().describe(LABEL_DESC) })).describe("Fingerprints to certify"),
        lang: z.string().optional().describe(LANG_DESC),
        tz: z.string().optional(),
      },
    }, async ({ items, lang, tz }) => certify(apiKey, items, lang, tz, false, undefined));

    const verifySchema = {
      sha256: z.string().describe("SHA-256 (64 hex) of the file to check, computed on the lawyer's side"),
      proof_id: z.string().describe("proof_id printed on the PDF report"),
      lang: z.string().optional().describe(LANG_DESC),
      tz: z.string().optional(),
    };
    const verifyHandler = async ({ sha256, proof_id, lang, tz }: { sha256: string; proof_id: string; lang?: string; tz?: string }) => {
      if (!HASH_RE.test(sha256.trim())) return err(hashInvalid("sha256"));
      const v = await opts.witness.verify({ sha256, proof_id });
      if (v.verdict === "not_found") return err(toolError("PROOF_NOT_FOUND", "Unknown proof_id.", false, "Check the proof_id printed on the PDF report (it starts with xvh_)."));
      return json(verificationBody(v, resolveLang(lang).lang, tz));
    };
    s.registerTool("verify_document", {
      description: "Free, no key: check a document against its PDF report. Give the SHA-256 of the file as it is now and the proof_id. Verdict V (checks passed: same fingerprint, valid timestamp token), X (modified or invalid) or pending (timestamp not issued yet), with a sentence in the lawyer's language.",
      inputSchema: verifySchema,
    }, verifyHandler);
    s.registerTool("verify_proof", {
      description: "Same as verify_document (alias). Free, no key.",
      inputSchema: verifySchema,
    }, verifyHandler);

    const getReportPdfHandler = async ({ proof_id, lang, tz }: { proof_id: string; lang?: string; tz?: string }) => {
      const a = await auth(apiKey);
      if ("code" in a) return err(a);
      const owner = await opts.witness.ownerOf(proof_id);
      if (owner !== a.key_hash) return err(toolError("PROOF_NOT_FOUND", "No proof with this id for this subscription.", false, "Check the proof_id printed on the PDF report."));
      const L = resolveLang(lang ?? a.default_lang);
      const pdf = await opts.witness.certificatePdf({ proof_id, lang: L.lang, tz });
      if (!pdf) return err(toolError("PROOF_INVALID", "The proof no longer verifies; no PDF report issued.", false, "Call verify_document for the details."));
      const link = await publishPdf(pdf.bytes, L.lang);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ok: true, proof_id, lang: L.lang, lang_fallback: L.fallback, verdict: pdf.verdict, qualified: pdf.qualified, status: pdf.proof.status, ...link }, null, 2) },
          { type: "resource" as const, resource: { uri: link.pdf_url ?? "", mimeType: "application/pdf", blob: Buffer.from(pdf.bytes).toString("base64") } },
        ],
      };
    };
    const reportPdfSchema = { proof_id: z.string(), lang: z.string().optional().describe(LANG_DESC), tz: z.string().optional() };
    s.registerTool("get_report_pdf", {
      description: "Re-issues the PDF report (not a certificate) of one of your proofs in any EU language, without a new timestamp. Also gives the version with the timestamp token once a pending proof has been timestamped (from 0.3.0, daily anchor or retry; the planned subscription uses Certigna). Needs the API key of the firm that certified it.",
      inputSchema: reportPdfSchema,
    }, getReportPdfHandler);
    s.registerTool("get_certificate_pdf", {
      description: "Deprecated: use get_report_pdf. Re-issues the PDF report (not a certificate). Same arguments and result as get_report_pdf. Kept for compatibility.",
      inputSchema: reportPdfSchema,
    }, getReportPdfHandler);

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
          await handleStripeWebhook(req, res, { store: opts.store, secret: opts.stripeWebhookSecret, log: opts.billingLog, onKeyDelivery: opts.keyDelivery ? (d) => opts.keyDelivery!.deliver(d) : undefined });
          return;
        }
        if (url.pathname.startsWith(KEY_PAGE_PREFIX)) {
          await handleKeyPage(req, res, url.pathname.slice(KEY_PAGE_PREFIX.length), opts.store, `${baseUrl}/mcp`);
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
