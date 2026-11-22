import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocale, resolveLang, fill, type Lang } from "./i18n.js";
import { toolError, type ToolError } from "./errors.js";

/** The only paid plan shown to lawyers. */
export const PAID_PLAN_ID = "coffre-horodate";
export const EIDAS_ART41_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02014R0910-20241018";
export const EU_TRUST_LIST_URL = "https://eidas.ec.europa.eu/efda/trust-services/browse/eidas/tls";
export const TAX_NOTE = "excl. VAT; reverse charge for EU B2B with valid VAT number";

export type PlaceholderNumber = {
  value: number | null;
  status: string;
  placeholder: boolean;
  note?: string;
};

export type Plan = {
  id: string;
  name: string;
  kind: string;
  status: string;
  price: {
    amount: number | null;
    currency: string | null;
    unit?: string;
    status: string;
    placeholder: boolean;
    note?: string;
    tax_behavior?: "exclusive" | "inclusive";
    display?: string;
    label?: string;
  };
  trial?: { days: number; card_required: boolean; status: string };
  includes: string[];
  limits: {
    notes_per_month: PlaceholderNumber;
    certifications_per_month: PlaceholderNumber;
  };
  certified_witness: boolean;
  certified_witness_status?: string;
};

export type PlansCatalog = {
  schema_version: string;
  prices_status: string;
  payment_live: boolean;
  currency: string | null;
  notice: string;
  updated: string;
  current_tier_id: string;
  plans: Plan[];
  upgrade: Record<string, unknown>;
  reseller: Record<string, unknown>;
  certified_proofs?: Record<string, unknown>;
  tax?: string;
  default_paid_plan_id?: string;
};

let cached: PlansCatalog | undefined;

export function catalogPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plans.json");
}

export function loadPlansCatalog(): PlansCatalog {
  if (!cached) {
    cached = JSON.parse(readFileSync(catalogPath(), "utf8")) as PlansCatalog;
  }
  return cached;
}

function paidPlan(catalog: PlansCatalog = loadPlansCatalog()): Plan {
  const p = catalog.plans.find((x) => x.id === PAID_PLAN_ID);
  if (!p) throw new Error("plans.json: coffre-horodate missing");
  return p;
}

function offerStrings(lang?: string | null): { lang: Lang; fallback: boolean; o: Record<string, string | string[]> } {
  const r = resolveLang(lang);
  return { lang: r.lang, fallback: r.fallback, o: loadLocale(r.lang).offer };
}

function priceBlock(lang: Lang, o: Record<string, string | string[]>): Record<string, unknown> {
  const p = paidPlan();
  return {
    plan_id: p.id,
    amount: p.price.amount,
    currency: p.price.currency,
    unit: p.price.unit,
    tax_behavior: p.price.tax_behavior,
    status: p.price.status,
    display: p.price.display,
    display_localized: o.price_display,
    label: p.price.label,
    label_localized: o.price_label,
    tax: TAX_NOTE,
    lang,
  };
}

/**
 * get_offer: short pitch centred on EU law (eIDAS art. 41), price, limits, next step.
 * Unsupported lang → English, never an error.
 */
export function getOffer(input: { lang?: string } = {}): Record<string, unknown> {
  const catalog = loadPlansCatalog();
  const current = catalog.plans.find((p) => p.id === catalog.current_tier_id) ?? catalog.plans[0];
  const { lang, fallback, o } = offerStrings(input.lang);
  const p = paidPlan(catalog);
  return {
    lang,
    lang_fallback: fallback,
    pitch: o.pitch,
    price: priceBlock(lang, o),
    includes: o.includes,
    legal_limits: o.legal_limits,
    eidas_basis: { regulation: "Regulation (EU) No 910/2014 (eIDAS)", article: "Art. 41", url: EIDAS_ART41_URL, trusted_list: EU_TRUST_LIST_URL },
    trial: { days: p.trial?.days ?? 14, card_required: p.trial?.card_required ?? true, status: p.trial?.status ?? "to_test", text: o.trial },
    next_tool: "present_to_client",
    tool_order: ["get_offer", "present_to_client", "request_upgrade", "get_subscription", "certify_document", "verify_document"],
    payment_live: catalog.payment_live,
    prices_status: catalog.prices_status,
    notice: catalog.notice,
    free_tier: current,
    current_tier: current,
    certified_proofs: catalog.certified_proofs ?? null,
    upgrade: catalog.upgrade,
    reseller: catalog.reseller,
    how_to_upgrade:
      "Call present_to_client, show its message, then show its consent_prompt once: the payment 'yes' is the only question of the whole flow. With the human's exact words, call request_upgrade(human_confirmed=true, consent_quote).",
  };
}

/** list_plans: machine-readable catalog plus tax wording; localized price label for the paid plan. */
export function listPlans(input: { lang?: string } = {}): Record<string, unknown> {
  const catalog = loadPlansCatalog();
  const { lang, fallback, o } = offerStrings(input.lang);
  return { ...catalog, lang, lang_fallback: fallback, tax: catalog.tax ?? TAX_NOTE, paid_plan: priceBlock(lang, o) };
}

export type PresentInput = { lang?: string; country?: string; context?: string };
export type Presentation = {
  lang: Lang;
  lang_fallback: boolean;
  message_markdown: string;
  consent_prompt: string;
  disclaimers: string[];
  price: Record<string, unknown>;
  next_tool: "request_upgrade";
  instructions_for_ai: string;
};

function contextLine(o: Record<string, string | string[]>, context?: string): string | null {
  if (!context) return null;
  const c = context.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/litig|disput|streit|conten|proce|court/.test(c)) return String(o.context_litige);
  if (/anteri|prior|preuve d.ant|copyright|design|brevet|patent/.test(c)) return String(o.context_anteriorite);
  if (/dossier|client|file|mandant|akte/.test(c)) return String(o.context_dossier);
  return null;
}

/** present_to_client: text ready to show to the lawyer (< 150 words) and the exact consent sentence. */
export function presentToClient(input: PresentInput = {}): Presentation {
  const { lang, fallback, o } = offerStrings(input.lang);
  const p = paidPlan();
  const ctx = contextLine(o, input.context);
  const country = input.country?.trim().slice(0, 40);
  const lines = [
    `**${o.present_title}**`,
    "",
    String(o.present_body),
    ...(ctx ? ["", String(ctx)] : []),
    "",
    `${o.present_does_not}${country ? " " + fill(String(o.country_note), { country }) : ""}`,
    "",
    fill(String(o.present_price), { price: String(o.price_display), label: String(o.price_label), trial: String(o.trial) }),
  ];
  return {
    lang,
    lang_fallback: fallback,
    message_markdown: lines.join("\n"),
    consent_prompt: String(o.consent_prompt),
    disclaimers: o.legal_limits as string[],
    price: priceBlock(lang, o),
    next_tool: "request_upgrade",
    instructions_for_ai:
      `Show message_markdown, then show consent_prompt once and wait for the human's yes/no. This consent is the only question of the flow: never ask anything else (language, plan, time zone, labels have defaults). If yes, call request_upgrade(plan_id="${p.id}", human_confirmed=true, consent_quote=<the human's exact words>, lang="${lang}").`,
  };
}

export type CheckoutRequest = { plan_id: string; lang: Lang; email?: string; consent_quote: string; consent_at: string; pairing_code?: string };
export type CheckoutResult = { checkout_url: string; expires_at: string; pairing_code?: string };
/** Billing provider: Stripe Checkout lives in L4. Until then the default provider is disabled. */
export interface Billing {
  readonly live: boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
}
export const DISABLED_BILLING: Billing = {
  live: false,
  async createCheckout() { throw new Error("billing disabled"); },
};

export type UpgradeInput = { plan_id?: string; lang?: string; human_confirmed?: boolean; consent_quote?: string; email?: string };

/** request_upgrade: refuses without explicit consent; never charges; returns a Checkout URL from the billing provider. */
export async function requestUpgradeFlow(input: UpgradeInput, deps: { billing?: Billing; pairingCode?: () => string | Promise<string> } = {}): Promise<Record<string, unknown> & { ok: boolean; code?: string }> {
  const catalog = loadPlansCatalog();
  const planId = input.plan_id?.trim() || PAID_PLAN_ID;
  const pres = presentToClient({ lang: input.lang });
  const plan = catalog.plans.find((p) => p.id === planId);
  if (!plan || plan.id !== PAID_PLAN_ID) {
    return toolError("PLAN_UNKNOWN", `Plan ${planId} cannot be subscribed to. The only paid plan is ${PAID_PLAN_ID}.`, false,
      `Call request_upgrade again with plan_id="${PAID_PLAN_ID}" (or omit plan_id).`, { known_plan_ids: catalog.plans.map((p) => p.id), plan_id: PAID_PLAN_ID });
  }
  const quote = (input.consent_quote ?? "").trim();
  if (input.human_confirmed !== true || !quote) {
    return toolError("CONSENT_REQUIRED", "The human has not explicitly agreed to pay yet.", true,
      "Show consent_prompt to the human once and wait for yes/no. This is the only question of the flow. If yes, call request_upgrade with human_confirmed=true and consent_quote set to the human's exact words.",
      { consent_prompt: pres.consent_prompt, message_markdown: pres.message_markdown, lang: pres.lang });
  }
  const consent = { quote: quote.slice(0, 500), at: new Date().toISOString(), lang: pres.lang, prompt: pres.consent_prompt };
  const billing = deps.billing ?? DISABLED_BILLING;
  if (!billing.live) {
    return toolError("BILLING_UNAVAILABLE", "Subscriptions cannot be paid yet: the XVcache Stripe account is not connected.", false,
      "Tell the human in one sentence that online subscription opens soon and that nothing was charged. Do not ask anything else. Free tools (verify_document, local journal) remain available.",
      { checkout_url: null, consent, payment_live: false });
  }
  const pairing_code = deps.pairingCode ? await deps.pairingCode() : undefined;
  try {
    const r = await billing.createCheckout({ plan_id: plan.id, lang: pres.lang, email: input.email, consent_quote: consent.quote, consent_at: consent.at, pairing_code });
    return {
      ok: true,
      plan_id: plan.id,
      checkout_url: r.checkout_url,
      expires_at: r.expires_at,
      pairing_code: r.pairing_code ?? pairing_code ?? null,
      consent,
      what_happens_next_localized: null,
      next_tool: "get_subscription",
      next_action: "Give checkout_url to the human. After payment, call get_subscription(pairing_code) until status is active or trialing; keep the api_key it returns once. Do not ask the human for anything.",
    };
  } catch (e) {
    return toolError("BILLING_UNAVAILABLE", `Checkout could not be created: ${e instanceof Error ? e.message : String(e)}`, true,
      "Retry request_upgrade once in a minute with the same consent_quote. Do not ask the human again.", { checkout_url: null, consent });
  }
}

export type { ToolError };

export type RecommendInput = {
  needs_qualified_timestamp?: boolean;
  docs_per_month?: number;
  lang?: string;
  notes_per_month?: number;
  certifications_per_month?: number;
  needs_certified_witness?: boolean;
  reseller?: boolean;
};

export type Recommendation = {
  payment_live: boolean;
  prices_status: "TBD";
  notice: string;
  recommended_plan_id: string;
  recommended_plan: Plan;
  reason: string;
  alternatives: string[];
  certified_witness_status: string;
  reseller?: Record<string, unknown>;
  plan_id?: string;
  reason_localized?: string;
};

function placeholderLimit(plan: Plan, key: "notes_per_month" | "certifications_per_month"): number | null {
  const v = plan.limits[key]?.value;
  return typeof v === "number" ? v : null;
}

export function recommendPlan(input: RecommendInput): Recommendation {
  const catalog = loadPlansCatalog();
  if (input.needs_qualified_timestamp === true || (typeof input.docs_per_month === "number" && input.docs_per_month > 0)) {
    const plan = paidPlan(catalog);
    const { o } = offerStrings(input.lang);
    return {
      payment_live: catalog.payment_live,
      prices_status: "TBD",
      notice: catalog.notice,
      recommended_plan_id: plan.id,
      plan_id: plan.id,
      recommended_plan: plan,
      reason: "A qualified (eIDAS) timestamp or a monthly document volume was given: coffre-horodate is the only paid plan.",
      reason_localized: String(o.recommend_reason),
      alternatives: ["free"],
      certified_witness_status: plan.certified_witness_status ?? "preview",
    };
  }
  const certs = input.certifications_per_month ?? 0;
  const notes = input.notes_per_month ?? 0;
  const wantsWitness = input.needs_certified_witness === true || certs > 0;

  let plan = catalog.plans.find((p) => p.id === "free") ?? catalog.plans[0];
  let reason: string;

  if (!wantsWitness) {
    reason =
      "No certified-witness volume was requested. The free local journal (verify_journal, verdicts V and X) is enough for now.";
  } else {
    const bundles = catalog.plans
      .filter((p) => p.kind === "bundle")
      .slice()
      .sort((a, b) => (placeholderLimit(a, "certifications_per_month") ?? 0) - (placeholderLimit(b, "certifications_per_month") ?? 0));

    const fitting = bundles.find((p) => {
      const c = placeholderLimit(p, "certifications_per_month");
      const n = placeholderLimit(p, "notes_per_month");
      const certOk = c == null || certs <= c;
      const noteOk = n == null || notes <= n;
      return certOk && noteOk;
    });

    if (fitting) {
      plan = fitting;
      reason =
        `Certified witness was requested (or a monthly certification volume was given). Placeholder bundle ${fitting.id} is the smallest illustrative bundle whose TBD quotas cover the stated volume. Quotas and prices are placeholders, not a real offer. Certified proofs run locally via certify_note; billing is not live.`;
    } else {
      plan = catalog.plans.find((p) => p.id === "usage") ?? plan;
      reason =
        "Certified witness was requested. No placeholder bundle covers the stated volume, so the usage-based plan (price per certification, TBD) is suggested. This is not a real offer. Certified proofs run locally via certify_note; billing is not live.";
    }
  }

  const alternatives = catalog.plans.filter((p) => p.id !== plan.id).map((p) => p.id);
  const result: Recommendation = {
    payment_live: false,
    prices_status: "TBD",
    notice: catalog.notice,
    recommended_plan_id: plan.id,
    recommended_plan: plan,
    reason,
    alternatives,
    certified_witness_status: plan.certified_witness ? (plan.certified_witness_status ?? "preview") : "not_included",
  };
  if (input.reseller) {
    result.reseller = catalog.reseller;
    result.reason +=
      " Reseller or partner bundling was requested: terms are TBD; see the reseller field and AGENTS.md. Do not sign or collect money on XVcache's behalf.";
  }
  return result;
}

/** @deprecated Legacy human-approval stub (pre-0.3). The MCP tool uses requestUpgradeFlow. */
export function requestUpgrade(planId: string): Record<string, unknown> {
  const catalog = loadPlansCatalog();
  const plan = catalog.plans.find((p) => p.id === planId);
  if (!plan) {
    return {
      ok: false,
      payment_live: false,
      error: `Unknown plan id: ${planId}`,
      known_plan_ids: catalog.plans.map((p) => p.id),
    };
  }
  return {
    ok: true,
    status: "needs_human_approval",
    payment_live: false,
    prices_status: "TBD",
    notice: catalog.notice,
    plan_id: plan.id,
    plan,
    approval: {
      who: "human",
      required: true,
      method_now: "stripe_checkout",
      checkout_url: null,
      method_later: "x402",
      x402_status: "à venir",
      instructions:
        "Do not pay or charge anyone. Show this plan to your human and ask for explicit approval. When billing is enabled, a Stripe checkout URL will be returned here. Agent-to-agent payment via x402 is planned later and is not available today.",
    },
    next_step_for_agent:
      "Deprecated stub kept for backward compatibility: use requestUpgradeFlow (request_upgrade tool). Do not invent a price or a payment link.",
  };
}
