import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocale, resolveLang, fill, type Lang } from "./i18n.js";
import { toolError, type ToolError } from "./errors.js";

/** Default planned paid plan (Essentiel). Sales are not open. */
export const PAID_PLAN_ID = "essentiel";
export const PAID_PLAN_IDS = ["essentiel", "cabinet", "launch"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export function isPaidPlanId(id: string): id is PaidPlanId {
  return (PAID_PLAN_IDS as readonly string[]).includes(id);
}
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
    tax?: string;
    period?: string;
  };
  users?: number;
  price_eur_ht_month?: number;
  planned?: boolean;
  demo_applications_only?: boolean;
  applies_to?: string;
  max_organisations?: number;
  seats_reassignable?: boolean;
  price_locked?: boolean;
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
  reseller?: Record<string, unknown>;
  certified_proofs?: Record<string, unknown>;
  tax?: string;
  default_paid_plan_id?: string;
  price_line?: string;
  price_line_fr?: string;
  price_details?: string;
  price_details_fr?: string;
  planned?: boolean;
  demo_applications_only?: boolean;
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

function paidPlans(catalog: PlansCatalog = loadPlansCatalog()): Plan[] {
  const found = catalog.plans.filter((x) => isPaidPlanId(x.id));
  if (found.length !== PAID_PLAN_IDS.length) throw new Error("plans.json: planned paid plans missing");
  return found;
}

function paidPlan(catalog: PlansCatalog = loadPlansCatalog()): Plan {
  const id = catalog.default_paid_plan_id || PAID_PLAN_ID;
  const p = catalog.plans.find((x) => x.id === id) ?? catalog.plans.find((x) => x.id === PAID_PLAN_ID);
  if (!p) throw new Error("plans.json: essentiel missing");
  return p;
}

function offerStrings(lang?: string | null): { lang: Lang; fallback: boolean; o: Record<string, string | string[]> } {
  const r = resolveLang(lang);
  return { lang: r.lang, fallback: r.fallback, o: loadLocale(r.lang).offer };
}

function priceBlock(lang: Lang, o: Record<string, string | string[]>): Record<string, unknown> {
  const plans = paidPlans();
  return {
    display: o.price_display,
    display_localized: o.price_display,
    details: o.price_details,
    label: o.price_label,
    label_localized: o.price_label,
    status: "announced",
    tax: TAX_NOTE,
    lang,
    plans: plans.map((p) => ({
      plan_id: p.id,
      name: p.name,
      amount: p.price.amount,
      currency: p.price.currency,
      unit: p.price.unit,
      tax_behavior: p.price.tax_behavior,
      tax: p.price.tax,
      period: p.price.period,
      status: p.price.status,
      display: p.price.display,
      users: p.users,
      price_eur_ht_month: p.price_eur_ht_month,
      planned: true,
      demo_applications_only: true,
      applies_to: p.applies_to,
      max_organisations: p.max_organisations,
      seats_reassignable: p.seats_reassignable,
      price_locked: p.price_locked,
    })),
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
    price_details: o.price_details,
    includes: o.includes,
    legal_limits: o.legal_limits,
    eidas_basis: { regulation: "Regulation (EU) No 910/2014 (eIDAS)", article: "Art. 41", url: EIDAS_ART41_URL, trusted_list: EU_TRUST_LIST_URL },
    trial: p.trial ? { days: p.trial.days, card_required: p.trial.card_required, status: p.trial.status, text: o.trial } : null,
    next_tool: "present_to_client",
    tool_order: ["get_offer", "present_to_client", "request_upgrade", "get_subscription", "certify_document", "verify_document"],
    payment_live: catalog.payment_live,
    prices_status: catalog.prices_status,
    notice: catalog.notice,
    free_tier: current,
    current_tier: current,
    certified_proofs: catalog.certified_proofs ?? null,
    upgrade: catalog.upgrade,
    how_to_upgrade:
      "Call present_to_client, show its message, then show its consent_prompt once: the payment 'yes' is the only question of the whole flow. With the human's exact words, call request_upgrade(human_confirmed=true, consent_quote).",
  };
}

/** list_plans: machine-readable catalog plus tax wording; localized price label for the paid plan. */
export function listPlans(input: { lang?: string } = {}): Record<string, unknown> {
  const catalog = loadPlansCatalog();
  const { lang, fallback, o } = offerStrings(input.lang);
  const { reseller: _omitReseller, ...publicCatalog } = catalog;
  const price = priceBlock(lang, o);
  return { ...publicCatalog, lang, lang_fallback: fallback, tax: catalog.tax ?? TAX_NOTE, paid_plan: price, paid_plans: price.plans };
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


/** Official short line without the launch €19 segment. Use only when a summary cannot carry the full condition; never display €19 without it. */
export const LAUNCH_SEGMENT_EN = " · launch price €19 excl. VAT / month for Essentiel, for the first 50 organisations, while the subscription stays active";
export const LAUNCH_SEGMENT_FR = " · prix de lancement 19 € HT / mois pour l'Essentiel, réservé aux 50 premières organisations, tant que l'abonnement reste actif";
export function priceDisplayForMessage(priceDisplay: string): string {
  if (priceDisplay.includes(LAUNCH_SEGMENT_EN)) return priceDisplay.replace(LAUNCH_SEGMENT_EN, "");
  if (priceDisplay.includes(LAUNCH_SEGMENT_FR)) return priceDisplay.replace(LAUNCH_SEGMENT_FR, "");
  return priceDisplay;
}

/** present_to_client: text ready to show to the lawyer (< 180 words) and the exact consent sentence. */
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
    fill(String(o.present_price), { price: priceDisplayForMessage(String(o.price_display)), label: String(o.price_label), trial: String(o.trial ?? "") }),
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
      `Show message_markdown, then show consent_prompt once and wait for the human's yes/no. This consent is the only question of the flow: never ask anything else (language, plan, time zone, labels have defaults). If yes, call request_upgrade(plan_id="essentiel"|"cabinet"|"launch", human_confirmed=true, consent_quote=<the human's exact words>, lang="${lang}"). Sales are not open yet.`,
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
export async function requestUpgradeFlow(input: UpgradeInput, deps: { billing?: Billing; pairingCode?: () => string | Promise<string>; allowTestCheckout?: boolean } = {}): Promise<Record<string, unknown> & { ok: boolean; code?: string }> {
  const catalog = loadPlansCatalog();
  const planId = input.plan_id?.trim() || PAID_PLAN_ID;
  const pres = presentToClient({ lang: input.lang });
  const plan = catalog.plans.find((p) => p.id === planId);
  if (!plan || !isPaidPlanId(plan.id)) {
    return toolError("PLAN_UNKNOWN", `Plan ${planId} cannot be subscribed to. Planned paid plans: ${PAID_PLAN_IDS.join(", ")}.`, false,
      `Call request_upgrade again with plan_id="${PAID_PLAN_ID}" (or cabinet, or launch), or omit plan_id.`, { known_plan_ids: catalog.plans.map((p) => p.id), plan_id: PAID_PLAN_ID, paid_plan_ids: [...PAID_PLAN_IDS] });
  }
  const quote = (input.consent_quote ?? "").trim();
  if (input.human_confirmed !== true || !quote) {
    return toolError("CONSENT_REQUIRED", "The human has not explicitly agreed to pay yet.", true,
      "Show consent_prompt to the human once and wait for yes/no. This is the only question of the flow. If yes, call request_upgrade with human_confirmed=true and consent_quote set to the human's exact words.",
      { consent_prompt: pres.consent_prompt, message_markdown: pres.message_markdown, lang: pres.lang });
  }
  const consent = { quote: quote.slice(0, 500), at: new Date().toISOString(), lang: pres.lang, prompt: pres.consent_prompt };
  const billing = deps.billing ?? DISABLED_BILLING;
  const unavailable = () => toolError("BILLING_UNAVAILABLE", "Subscriptions cannot be paid yet: sales are not open.", false,
      "Tell the human in one sentence that online subscription is not open yet (no payment can be made at this stage) and that nothing was charged. Do not ask anything else. Free tools (verify_document, local journal) remain available.",
      { checkout_url: null, consent, payment_live: false });
  if (!billing.live) {
    return unavailable();
  }
  const pairing_code = deps.pairingCode ? await deps.pairingCode() : undefined;
  try {
    const r = await billing.createCheckout({ plan_id: plan.id, lang: pres.lang, email: input.email, consent_quote: consent.quote, consent_at: consent.at, pairing_code });
    const url = r.checkout_url || "";
    const isTestLink = /^https:\/\/buy\.stripe\.com\/test_/.test(url) || /checkout\.stripe\.com\/.*cs_test_/.test(url);
    if (!url || (isTestLink && deps.allowTestCheckout !== true)) {
      return unavailable();
    }
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
      reason: "A qualified (eIDAS) timestamp or a monthly document volume was given: essentiel is the default planned plan (Cabinet and the launch price on Essentiel are also planned; not on sale yet).",
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
      "No independent timestamp volume was requested. The free local journal (verify_journal, verdicts V and X) is enough for now.";
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
        `An independent timestamp was requested (or a monthly timestamping volume was given). Placeholder bundle ${fitting.id} is the smallest illustrative bundle whose TBD quotas cover the stated volume. Quotas and prices are placeholders, not a real offer. Timestamped proofs run locally via certify_note; billing is not live.`;
    } else {
      plan = catalog.plans.find((p) => p.id === "usage") ?? plan;
      reason =
        "An independent timestamp was requested. No placeholder bundle covers the stated volume, so the usage-based plan (price per timestamp, TBD) is suggested. This is not a real offer. Timestamped proofs run locally via certify_note; billing is not live.";
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
