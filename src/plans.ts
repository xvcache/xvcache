import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  };
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

export function getOffer(): Record<string, unknown> {
  const catalog = loadPlansCatalog();
  const current = catalog.plans.find((p) => p.id === catalog.current_tier_id) ?? catalog.plans[0];
  return {
    payment_live: catalog.payment_live,
    prices_status: catalog.prices_status,
    notice: catalog.notice,
    current_tier: current,
    upgrade: catalog.upgrade,
    reseller: catalog.reseller,
    how_to_upgrade:
      "Show the plan to your human and ask for explicit approval. Intended path today: a Stripe checkout link (not live). Later: x402 for agent-to-agent payment (à venir). Call request_upgrade with a plan id to get the approval step.",
  };
}

export type RecommendInput = {
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
};

function placeholderLimit(plan: Plan, key: "notes_per_month" | "certifications_per_month"): number | null {
  const v = plan.limits[key]?.value;
  return typeof v === "number" ? v : null;
}

export function recommendPlan(input: RecommendInput): Recommendation {
  const catalog = loadPlansCatalog();
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
        `Certified witness was requested (or a monthly certification volume was given). Placeholder bundle ${fitting.id} is the smallest illustrative bundle whose TBD quotas cover the stated volume. Quotas and prices are placeholders, not a real offer. The witness itself is à venir.`;
    } else {
      plan = catalog.plans.find((p) => p.id === "usage") ?? plan;
      reason =
        "Certified witness was requested. No placeholder bundle covers the stated volume, so the usage-based plan (price per certification, TBD) is suggested. This is not a real offer. The witness itself is à venir.";
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
    certified_witness_status: plan.certified_witness ? "à venir" : "not_included",
  };
  if (input.reseller) {
    result.reseller = catalog.reseller;
    result.reason +=
      " Reseller or partner bundling was requested: terms are TBD; see the reseller field and AGENTS.md. Do not sign or collect money on XVcache's behalf.";
  }
  return result;
}

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
      "Present the plan name, that prices are TBD, and that payment is not live. Ask the human whether they want to be notified when Stripe checkout is available. Do not invent a price or a payment link.",
  };
}

export function certifyNoteStub(rel?: string): Record<string, unknown> {
  return {
    ok: false,
    certified: false,
    status: "unavailable",
    payment_live: false,
    message:
      "Witness certification à venir. The independent certifying witness (Ed25519 / qualified timestamp) is not available yet. Use verify_journal for a local V (intacte) or X (MODIFIÉE hors XVcache) verdict. That local verdict is not a qualified timestamp.",
    path: rel ?? null,
  };
}
