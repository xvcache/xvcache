import type http from "node:http";
import type { PendingKeyDelivery, SubscriptionStore } from "./subscriptions.js";

/**
 * 0.3.0 — delivery of the API key after payment, by email, through Cloudflare Email Sending (REST API).
 * The email NEVER contains the key: it contains a one-time link, valid a short time (24 h by default),
 * to a page of this server. GET only shows a button (mail scanners that pre-open links do not consume it);
 * POST reveals the key once, then the encrypted copy is erased.
 * Disabled by default: XVCACHE_KEY_EMAIL=on plus the settings below are required (see remote-server.ts).
 * Nothing here creates anything at Cloudflare; the sending domain must be onboarded by the operator first.
 */

export const KEY_PAGE_PREFIX = "/key/";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type MailMessage = { to: string; subject: string; text: string; html: string };
export type Mailer = { send(m: MailMessage): Promise<{ message_id?: string }> };
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Cloudflare Email Sending REST API: POST /accounts/{account_id}/email/sending/send (token permission "Email Sending: Edit"). */
export function cloudflareMailer(o: { accountId: string; apiToken: string; from: string; fromName?: string; replyTo?: string; fetchImpl?: FetchFn; apiBase?: string }): Mailer {
  const f: FetchFn = o.fetchImpl ?? (fetch as unknown as FetchFn);
  const url = `${o.apiBase ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(o.accountId)}/email/sending/send`;
  return {
    async send(m) {
      const payload: Record<string, unknown> = {
        to: m.to,
        from: o.fromName ? { address: o.from, name: o.fromName } : o.from,
        subject: m.subject,
        text: m.text,
        html: m.html,
      };
      if (o.replyTo) payload.reply_to = o.replyTo;
      const r = await f(url, { method: "POST", headers: { Authorization: `Bearer ${o.apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.success !== true) {
        const e = Array.isArray(j?.errors) && j.errors[0] ? `${j.errors[0].code ?? ""} ${j.errors[0].message ?? ""}`.trim() : "";
        throw new Error(`Cloudflare Email Sending HTTP ${r.status}${e ? ` (${e})` : ""}`);
      }
      const res = j.result ?? {};
      if (Array.isArray(res.permanent_bounces) && res.permanent_bounces.length) throw new Error("permanent bounce");
      if (Array.isArray(res.suppressed_recipients) && res.suppressed_recipients.length) throw new Error("recipient suppressed");
      return { message_id: typeof res.message_id === "string" ? res.message_id : undefined };
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function parisTime(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" }).format(new Date(iso)) + (lang === "fr" ? " (heure de Paris)" : " (Paris time)");
}

export const PUBLISHER_LINE = "XVcache est édité par RENO'LINE SARL, 6 rue du Commerce, 68420 Herrlisheim-près-Colmar, RCS Colmar 832 059 513.";
const PUBLISHER_LINE_EN = "XVcache is published by RENO'LINE SARL, 6 rue du Commerce, 68420 Herrlisheim-près-Colmar, France, RCS Colmar 832 059 513.";

/** The email: a link, its expiry, never the key. */
export function keyLinkEmail(o: { link: string; expires_at: string; lang: string }): { subject: string; text: string; html: string } {
  const fr = o.lang === "fr";
  const until = parisTime(o.expires_at, fr ? "fr" : "en");
  const lines = fr
    ? [
        "Bonjour,",
        "",
        "Merci pour votre abonnement XVcache Coffre horodaté.",
        "Votre clé d'accès s'affiche une seule fois dans votre assistant IA. Si vous ne l'avez pas notée, ce lien personnel vous permet de l'afficher une seule fois :",
        "",
        o.link,
        "",
        `Le lien fonctionne une seule fois et expire le ${until}. Ne le transférez pas. Pour votre sécurité, la clé n'est jamais envoyée par email.`,
        "Si vous n'êtes pas à l'origine de cet abonnement, ignorez ce message et répondez-nous.",
        "",
        "Vos factures, votre moyen de paiement et la résiliation se gèrent depuis l'espace client Stripe indiqué dans vos emails de facturation.",
        "",
        PUBLISHER_LINE,
      ]
    : [
        "Hello,",
        "",
        "Thank you for subscribing to XVcache Coffre horodaté.",
        "Your access key is shown once in your AI assistant. If you did not save it, this personal link shows it once:",
        "",
        o.link,
        "",
        `The link works once and expires on ${until}. Do not forward it. For your security, the key is never sent by email.`,
        "If you did not subscribe, ignore this message and reply to let us know.",
        "",
        "Invoices, payment method and cancellation are managed in the Stripe customer portal linked in your billing emails.",
        "",
        PUBLISHER_LINE_EN,
      ];
  const subject = fr ? "XVcache : votre lien pour afficher votre clé d'accès (usage unique)" : "XVcache: your link to view your access key (one-time)";
  const html = `<!doctype html><html lang="${fr ? "fr" : "en"}"><body style="font-family:Arial,Helvetica,sans-serif;color:#0E1626;line-height:1.5;max-width:560px">`
    + lines.map((l) => (l === o.link
      ? `<p><a href="${esc(o.link)}" style="display:inline-block;background:#0E1626;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${fr ? "Afficher ma clé (une seule fois)" : "Show my key (once)"}</a></p>`
      : l === "" ? "" : `<p>${esc(l)}</p>`)).join("")
    + `</body></html>`;
  return { subject, text: lines.join("\n"), html };
}

export type DeliveryLog = (line: Record<string, unknown>) => void;

/** Sends the link email after the webhook has answered Stripe; retries a few times, never logs the address nor the token. */
export class KeyDeliveryService {
  private inflight = new Set<Promise<void>>();
  private baseOverride: string | undefined;
  constructor(private o: { store: SubscriptionStore; mailer: Mailer; publicBaseUrl: () => string; log?: DeliveryLog; retryDelaysMs?: number[] }) {}

  /** Bound once the listen port is known, so resume-on-start uses a real URL. */
  setPublicBaseUrl(url: string): void {
    this.baseOverride = url.replace(/\/$/, "");
  }

  private log(l: Record<string, unknown>): void {
    (this.o.log ?? ((x) => process.stderr.write(`xvcache-key-delivery ${JSON.stringify(x)}\n`)))(l);
  }

  linkFor(token: string): string {
    const base = (this.baseOverride || this.o.publicBaseUrl()).replace(/\/$/, "");
    return `${base}${KEY_PAGE_PREFIX}${token}`;
  }

  deliver(d: PendingKeyDelivery): void {
    const p = this.run(d).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** After a restart: re-queue unsent deliveries whose token was persisted (wrapped) before the Stripe 200. */
  async resume(): Promise<number> {
    const pending = await this.o.store.listRecoverableDeliveries();
    for (const d of pending) this.deliver(d);
    if (pending.length) this.log({ ok: true, resumed: pending.length });
    return pending.length;
  }

  /** Tests / shutdown: wait for every pending send. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async run(d: PendingKeyDelivery): Promise<void> {
    if (await this.o.store.deliveryAlreadySent(d.token_hash)) return;
    const mail = keyLinkEmail({ link: this.linkFor(d.token), expires_at: d.expires_at, lang: d.lang });
    const delays = this.o.retryDelaysMs ?? [0, 60_000, 600_000];
    const id = d.token_hash.slice(0, 12);
    let last = "";
    for (const [i, wait] of delays.entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait).unref?.());
      try {
        await this.o.mailer.send({ to: d.email, ...mail });
        await this.o.store.markDeliverySent(d.token_hash, { ok: true });
        this.log({ ok: true, delivery: id, attempt: i + 1 });
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        this.log({ ok: false, delivery: id, attempt: i + 1, error: last });
      }
    }
    await this.o.store.markDeliverySent(d.token_hash, { ok: false, error: last });
    this.log({ ok: false, delivery: id, operator_alert: "key link email not delivered; the customer still sees the key once in the AI assistant, otherwise issue a new key" });
  }
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function page(lang: string, title: string, body: string): string {
  return `<!doctype html><html lang="${lang === "fr" ? "fr" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>`
    + `<style>body{font-family:Arial,Helvetica,sans-serif;background:#f5f6f8;color:#0E1626;margin:0;padding:24px}main{max-width:560px;margin:40px auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.08)}button{background:#0E1626;color:#fff;border:0;border-radius:6px;padding:12px 18px;font-size:16px;cursor:pointer}code{display:block;word-break:break-all;background:#0E1626;color:#fff;padding:14px;border-radius:6px;font-size:15px;user-select:all}small{color:#555}</style></head>`
    + `<body><main><h1 style="font-size:20px">${esc(title)}</h1>${body}<p><small>${esc(lang === "fr" ? PUBLISHER_LINE : PUBLISHER_LINE_EN)}</small></p></main></body></html>`;
}

function send(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": PAGE_CSP,
  }).end(html);
}

function gone(res: http.ServerResponse, state: string, lang: string): void {
  const fr = lang === "fr";
  const msg = state === "revealed"
    ? (fr ? "Ce lien a déjà été utilisé : la clé ne s'affiche qu'une fois. Si vous ne l'avez pas sauvegardée, répondez à l'email reçu pour obtenir une nouvelle clé." : "This link has already been used: the key is shown only once. If you did not save it, reply to the email to get a new key.")
    : state === "expired"
    ? (fr ? "Ce lien a expiré. Votre clé reste valable ; si vous ne l'avez pas, répondez à l'email reçu pour obtenir une nouvelle clé." : "This link has expired. Your key remains valid; if you do not have it, reply to the email to get a new key.")
    : (fr ? "Lien inconnu." : "Unknown link.");
  send(res, state === "unknown" ? 404 : 410, page(lang, fr ? "Lien indisponible" : "Link unavailable", `<p>${esc(msg)}</p>`));
}

/** GET /key/<token> → button; POST /key/<token> → the key, once. */
export async function handleKeyPage(req: http.IncomingMessage, res: http.ServerResponse, token: string, store: SubscriptionStore, mcpUrl = "https://mcp.xvcache.com/mcp"): Promise<void> {
  if (!TOKEN_RE.test(token)) { gone(res, "unknown", "en"); return; }
  if (req.method === "GET" || req.method === "HEAD") {
    const st = await store.deliveryState(token);
    if (st.state !== "valid") { gone(res, st.state, st.lang); return; }
    const fr = st.lang === "fr";
    const until = parisTime(st.expires_at!, fr ? "fr" : "en");
    send(res, 200, page(st.lang, fr ? "Votre clé d'accès XVcache" : "Your XVcache access key",
      `<p>${esc(fr ? "La clé s'affichera une seule fois. Préparez un endroit sûr pour la sauvegarder (gestionnaire de mots de passe), puis donnez-la à votre assistant IA." : "The key will be shown only once. Have a safe place ready to save it (password manager), then give it to your AI assistant.")}</p>`
      + `<p><small>${esc(fr ? `Lien valable jusqu'au ${until}, une seule fois.` : `Link valid until ${until}, once.`)}</small></p>`
      + `<form method="post" action="${KEY_PAGE_PREFIX}${token}"><button type="submit">${esc(fr ? "Afficher ma clé maintenant" : "Show my key now")}</button></form>`));
    return;
  }
  if (req.method === "POST") {
    for await (const _ of req) { /* drain the (empty) form body */ }
    const r = await store.revealDeliveredKey(token);
    if (!r.ok) { gone(res, r.state, r.lang); return; }
    const fr = r.lang === "fr";
    send(res, 200, page(r.lang, fr ? "Votre clé d'accès XVcache" : "Your XVcache access key",
      `<p><strong>${esc(fr ? "Sauvegardez-la maintenant : elle ne sera plus jamais affichée." : "Save it now: it will never be shown again.")}</strong></p>`
      + `<code>${esc(r.api_key)}</code>`
      + `<p>${esc(fr ? "Donnez-la à votre assistant IA : il l'envoie dans l'en-tête « Authorization: Bearer <clé> » du serveur MCP ${mcpUrl}. Ne la collez pas dans un document ni dans un email." : "Give it to your AI assistant: it sends it in the 'Authorization: Bearer <key>' header to the MCP server ${mcpUrl}. Do not paste it into a document or an email.")}</p>`));
    return;
  }
  res.writeHead(405, { Allow: "GET, POST" }).end();
}
