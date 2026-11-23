import { existsSync, readFileSync } from "node:fs";
import type { SubscriptionStore } from "./subscriptions.js";

/**
 * A2 — correspondence table used by the Stripe webhook to check that a paid
 * checkout matches the expected plan *before* any API key is minted.
 *
 * Configure with:
 * - `XVCACHE_STRIPE_PRICE_TABLE` = path to a JSON file, or
 * - `XVCACHE_STRIPE_PRICE_TABLE_JSON` = the JSON itself, or
 * - the `stripePriceTable` option of the hosted server (tests).
 *
 * Copy `stripe-price-table.example.json` and replace the identifiers with the
 * operator's own Stripe values. The example file uses fake `price_EXAMPLE_*`
 * ids only — never invent or commit live Stripe price ids.
 *
 * If the table is missing, empty or invalid, paid checkouts are refused
 * (no key, no subscription). The webhook never calls the Stripe API: when
 * `line_items` is absent from the event, only `metadata`, `amount_total`,
 * `currency` and `livemode` are used (see `checkPaidCheckout`).
 */

export const STRIPE_PRICE_TABLE_PATH_ENV = "XVCACHE_STRIPE_PRICE_TABLE";
export const STRIPE_PRICE_TABLE_JSON_ENV = "XVCACHE_STRIPE_PRICE_TABLE_JSON";

export type PriceTableEntry = {
  plan_id: string;
  price_id?: string;
  lookup_key?: string;
  /** Smallest currency unit (e.g. 2900 = 29.00 EUR). */
  amount: number;
  currency: string;
};

export type PriceTable = {
  /** Expected `event.livemode` (false = Stripe test, true = live). */
  livemode: boolean;
  entries: PriceTableEntry[];
};

export type PriceCheckReason =
  | "price_table_missing"
  | "price_table_empty"
  | "price_table_invalid"
  | "unknown_price"
  | "amount_mismatch"
  | "currency_mismatch"
  | "livemode_mismatch"
  | "plan_mismatch"
  | "ambiguous_line_items"
  | "ambiguous_amount";

export type PriceTableLoad =
  | { ok: true; table: PriceTable; source: string }
  | { ok: false; reason: "price_table_missing" | "price_table_empty" | "price_table_invalid"; message: string; source?: string };

export type PriceCheckOk = { ok: true; plan_id: string; price_id?: string; lookup_key?: string; amount: number; currency: string };
export type PriceCheckFail = { ok: false; reason: PriceCheckReason; price_id?: string; lookup_key?: string; amount?: number; currency?: string; expected_plan?: string; pairing_plan?: string; metadata_plan?: string };
export type PriceCheck = PriceCheckOk | PriceCheckFail;

/** Fake identifiers for tests and the example file — not real Stripe prices. */
export const EXAMPLE_PRICE_ESSENTIEL = "price_EXAMPLE_essentiel_monthly";
export const EXAMPLE_PRICE_CABINET = "price_EXAMPLE_cabinet_monthly";
export const EXAMPLE_PRICE_LAUNCH = "price_EXAMPLE_launch_monthly";
export const EXAMPLE_LOOKUP_ESSENTIEL = "exemple_essentiel_mensuel";
export const EXAMPLE_LOOKUP_CABINET = "exemple_cabinet_mensuel";
export const EXAMPLE_LOOKUP_LAUNCH = "exemple_lancement_mensuel";

export const EXAMPLE_PRICE_TABLE: PriceTable = {
  livemode: false,
  entries: [
    { plan_id: "essentiel", price_id: EXAMPLE_PRICE_ESSENTIEL, lookup_key: EXAMPLE_LOOKUP_ESSENTIEL, amount: 2900, currency: "eur" },
    { plan_id: "cabinet", price_id: EXAMPLE_PRICE_CABINET, lookup_key: EXAMPLE_LOOKUP_CABINET, amount: 5900, currency: "eur" },
    { plan_id: "launch", price_id: EXAMPLE_PRICE_LAUNCH, lookup_key: EXAMPLE_LOOKUP_LAUNCH, amount: 1900, currency: "eur" },
  ],
};

/** Fields to spread into a local `checkout.session.completed` object in tests. */
export function exampleCheckoutPayment(plan_id: "essentiel" | "cabinet" | "launch" = "essentiel"): Record<string, unknown> {
  const e = EXAMPLE_PRICE_TABLE.entries.find((x) => x.plan_id === plan_id)!;
  return {
    amount_total: e.amount,
    currency: e.currency,
    metadata: { plan_id: e.plan_id, price_id: e.price_id, lookup_key: e.lookup_key },
    line_items: {
      object: "list",
      data: [{
        amount_subtotal: e.amount,
        amount_total: e.amount,
        currency: e.currency,
        quantity: 1,
        price: { id: e.price_id, lookup_key: e.lookup_key, unit_amount: e.amount, currency: e.currency },
      }],
    },
  };
}

export function priceTableStartupMessage(load: PriceTableLoad): string {
  if (load.ok) {
    return `xvcache-billing: Stripe price table loaded (${load.table.entries.length} plan entries, livemode=${load.table.livemode}, source=${load.source}).`;
  }
  const impact = "Paid checkouts will be refused: no API key will be issued and no subscription will be created or activated until a valid table is configured. See stripe-price-table.example.json.";
  if (load.reason === "price_table_missing") {
    return `xvcache-billing: Stripe price table is missing (set ${STRIPE_PRICE_TABLE_PATH_ENV} to a JSON file, or ${STRIPE_PRICE_TABLE_JSON_ENV}). ${impact}`;
  }
  if (load.reason === "price_table_empty") {
    return `xvcache-billing: Stripe price table is empty (no entries${load.source ? `, source=${load.source}` : ""}). ${impact}`;
  }
  return `xvcache-billing: Stripe price table is invalid${load.source ? ` (${load.source})` : ""}: ${load.message}. ${impact}`;
}

export function loadStripePriceTableFromEnv(explicitPath?: string): PriceTableLoad {
  const path = explicitPath?.trim() || process.env[STRIPE_PRICE_TABLE_PATH_ENV]?.trim();
  if (path) return loadStripePriceTableFile(path);
  const raw = process.env[STRIPE_PRICE_TABLE_JSON_ENV]?.trim();
  if (raw) return parseStripePriceTable(raw, "env:JSON");
  return { ok: false, reason: "price_table_missing", message: "no price table configured" };
}

export function loadStripePriceTableFile(filePath: string): PriceTableLoad {
  if (!existsSync(filePath)) {
    return { ok: false, reason: "price_table_missing", message: "price table file not found", source: filePath };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, reason: "price_table_invalid", message: e instanceof Error ? e.message : String(e), source: filePath };
  }
  return parseStripePriceTable(raw, filePath);
}

export function parseStripePriceTable(raw: string, source: string): PriceTableLoad {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "price_table_invalid", message: e instanceof Error ? e.message : "invalid JSON", source };
  }
  return validateStripePriceTable(v, source);
}

export function validateStripePriceTable(v: unknown, source = "option"): PriceTableLoad {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, reason: "price_table_invalid", message: "table must be a JSON object", source };
  }
  const o = v as Record<string, unknown>;
  if (typeof o.livemode !== "boolean") {
    return { ok: false, reason: "price_table_invalid", message: "livemode must be a boolean", source };
  }
  if (!Array.isArray(o.entries)) {
    return { ok: false, reason: "price_table_invalid", message: "entries must be an array", source };
  }
  if (o.entries.length === 0) {
    return { ok: false, reason: "price_table_empty", message: "entries is empty", source };
  }
  const entries: PriceTableEntry[] = [];
  const priceIds = new Set<string>();
  const lookups = new Set<string>();
  for (let i = 0; i < o.entries.length; i++) {
    const e = o.entries[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return { ok: false, reason: "price_table_invalid", message: `entries[${i}] must be an object`, source };
    }
    const row = e as Record<string, unknown>;
    const plan_id = typeof row.plan_id === "string" ? row.plan_id.trim() : "";
    const price_id = typeof row.price_id === "string" && row.price_id.trim() ? row.price_id.trim() : undefined;
    const lookup_key = typeof row.lookup_key === "string" && row.lookup_key.trim() ? row.lookup_key.trim() : undefined;
    const amount = row.amount;
    const currency = typeof row.currency === "string" ? row.currency.trim().toLowerCase() : "";
    if (!plan_id) return { ok: false, reason: "price_table_invalid", message: `entries[${i}].plan_id is required`, source };
    if (!price_id && !lookup_key) return { ok: false, reason: "price_table_invalid", message: `entries[${i}] needs price_id or lookup_key`, source };
    if (!Number.isInteger(amount) || (amount as number) < 0) return { ok: false, reason: "price_table_invalid", message: `entries[${i}].amount must be a non-negative integer (minor units)`, source };
    if (!/^[a-z]{3}$/.test(currency)) return { ok: false, reason: "price_table_invalid", message: `entries[${i}].currency must be a 3-letter code`, source };
    if (price_id) {
      if (priceIds.has(price_id)) return { ok: false, reason: "price_table_invalid", message: `duplicate price_id ${price_id}`, source };
      priceIds.add(price_id);
    }
    if (lookup_key) {
      if (lookups.has(lookup_key)) return { ok: false, reason: "price_table_invalid", message: `duplicate lookup_key ${lookup_key}`, source };
      lookups.add(lookup_key);
    }
    entries.push({ plan_id, price_id, lookup_key, amount: amount as number, currency });
  }
  return { ok: true, table: { livemode: o.livemode, entries }, source };
}

type Obj = Record<string, any>;

function asLines(session: Obj): Obj[] | undefined {
  const li = session.line_items;
  if (li == null) return undefined;
  if (Array.isArray(li)) return li;
  if (li && typeof li === "object" && Array.isArray(li.data)) return li.data;
  return undefined;
}

function lineAmount(line: Obj): number | undefined {
  const unit = line.price && typeof line.price === "object" ? line.price.unit_amount : undefined;
  const qty = Number.isInteger(line.quantity) ? line.quantity : 1;
  if (Number.isInteger(unit)) return unit * qty;
  if (Number.isInteger(line.amount_subtotal)) return line.amount_subtotal;
  if (Number.isInteger(line.amount_total)) return line.amount_total;
  return undefined;
}

function lineCurrency(line: Obj): string | undefined {
  const c = (line.price && typeof line.price === "object" ? line.price.currency : undefined) ?? line.currency;
  return typeof c === "string" ? c.trim().toLowerCase() : undefined;
}

function linePriceId(line: Obj): string | undefined {
  if (typeof line.price === "string") return line.price;
  if (line.price && typeof line.price === "object" && typeof line.price.id === "string") return line.price.id;
  return undefined;
}

function lineLookup(line: Obj): string | undefined {
  if (line.price && typeof line.price === "object" && typeof line.price.lookup_key === "string" && line.price.lookup_key) return line.price.lookup_key;
  return undefined;
}

function findEntry(table: PriceTable, price_id?: string, lookup_key?: string): PriceTableEntry | undefined {
  if (price_id) {
    const byId = table.entries.find((e) => e.price_id === price_id);
    if (byId) return byId;
  }
  if (lookup_key) {
    const byKey = table.entries.find((e) => e.lookup_key === lookup_key);
    if (byKey) return byKey;
  }
  return undefined;
}

function compareMoney(entry: PriceTableEntry, amount: number | undefined, currency: string | undefined): PriceCheckFail | undefined {
  if (currency && currency !== entry.currency) {
    return { ok: false, reason: "currency_mismatch", price_id: entry.price_id, lookup_key: entry.lookup_key, amount, currency, expected_plan: entry.plan_id };
  }
  if (amount !== undefined && amount !== entry.amount) {
    return { ok: false, reason: "amount_mismatch", price_id: entry.price_id, lookup_key: entry.lookup_key, amount, currency, expected_plan: entry.plan_id };
  }
  if (!currency) return { ok: false, reason: "currency_mismatch", price_id: entry.price_id, lookup_key: entry.lookup_key, amount, expected_plan: entry.plan_id };
  if (amount === undefined) return { ok: false, reason: "amount_mismatch", price_id: entry.price_id, lookup_key: entry.lookup_key, currency, expected_plan: entry.plan_id };
  return undefined;
}

/**
 * Check a verified `checkout.session.completed` event against the price table.
 * Never calls the Stripe API. When `line_items` is missing, matching uses
 * `metadata.price_id` / `metadata.lookup_key` if present, otherwise
 * `amount_total` + `currency` (limitation: `amount_total` may include tax,
 * so the table must list the charged total in that case; two plans with the
 * same amount and currency cannot be distinguished without a price id).
 */
export function checkPaidCheckout(evt: Obj, load: PriceTableLoad, o: { pairingPlan?: string } = {}): PriceCheck {
  if (!load.ok) return { ok: false, reason: load.reason };
  const table = load.table;
  const livemode = evt.livemode === true;
  if (livemode !== table.livemode) {
    return { ok: false, reason: "livemode_mismatch", currency: typeof evt.data?.object?.currency === "string" ? evt.data.object.currency : undefined, amount: evt.data?.object?.amount_total };
  }
  const session: Obj = evt.data?.object ?? {};
  const meta: Obj = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const metadataPlan = typeof meta.plan_id === "string" && meta.plan_id.trim() ? meta.plan_id.trim() : undefined;
  const metaPrice = typeof meta.price_id === "string" && meta.price_id.trim() ? meta.price_id.trim() : undefined;
  const metaLookup = typeof meta.lookup_key === "string" && meta.lookup_key.trim() ? meta.lookup_key.trim() : undefined;
  const amountTotal = Number.isInteger(session.amount_total) ? session.amount_total as number : undefined;
  const currency = typeof session.currency === "string" ? session.currency.trim().toLowerCase() : undefined;

  const lines = asLines(session);
  let entry: PriceTableEntry | undefined;
  let amount: number | undefined;
  let curr: string | undefined;
  let price_id: string | undefined;
  let lookup_key: string | undefined;

  if (lines && lines.length > 1) {
    return { ok: false, reason: "ambiguous_line_items", amount: amountTotal, currency };
  }

  if (lines && lines.length === 1) {
    const line = lines[0];
    price_id = linePriceId(line) ?? metaPrice;
    lookup_key = lineLookup(line) ?? metaLookup;
    amount = lineAmount(line) ?? amountTotal;
    curr = lineCurrency(line) ?? currency;
    entry = findEntry(table, price_id, lookup_key);
    if (!entry) return { ok: false, reason: "unknown_price", price_id, lookup_key, amount, currency: curr };
    const money = compareMoney(entry, amount, curr);
    if (money) return money;
  } else {
    // No line_items in the event — do not call the Stripe API.
    price_id = metaPrice;
    lookup_key = metaLookup;
    amount = amountTotal;
    curr = currency;
    if (price_id || lookup_key) {
      entry = findEntry(table, price_id, lookup_key);
      if (!entry) return { ok: false, reason: "unknown_price", price_id, lookup_key, amount, currency: curr };
      const money = compareMoney(entry, amount, curr);
      if (money) return money;
    } else {
      const byMoney = table.entries.filter((e) => (amount === undefined || e.amount === amount) && (curr === undefined || e.currency === curr));
      const sameCurrency = curr ? table.entries.filter((e) => e.currency === curr) : [];
      const sameAmount = amount !== undefined ? table.entries.filter((e) => e.amount === amount) : [];
      if (byMoney.length > 1) return { ok: false, reason: "ambiguous_amount", amount, currency: curr };
      if (byMoney.length === 1) {
        entry = byMoney[0];
      } else if (sameCurrency.length && amount !== undefined) {
        return { ok: false, reason: "amount_mismatch", amount, currency: curr };
      } else if (sameAmount.length && curr) {
        return { ok: false, reason: "currency_mismatch", amount, currency: curr };
      } else {
        return { ok: false, reason: "unknown_price", amount, currency: curr };
      }
    }
  }

  if (!entry) return { ok: false, reason: "unknown_price", price_id, lookup_key, amount, currency: curr };
  if (o.pairingPlan && o.pairingPlan !== entry.plan_id) {
    return { ok: false, reason: "plan_mismatch", price_id: entry.price_id, lookup_key: entry.lookup_key, amount, currency: curr, expected_plan: entry.plan_id, pairing_plan: o.pairingPlan, metadata_plan: metadataPlan };
  }
  if (metadataPlan && metadataPlan !== entry.plan_id) {
    return { ok: false, reason: "plan_mismatch", price_id: entry.price_id, lookup_key: entry.lookup_key, amount, currency: curr, expected_plan: entry.plan_id, pairing_plan: o.pairingPlan, metadata_plan: metadataPlan };
  }
  return { ok: true, plan_id: entry.plan_id, price_id: entry.price_id, lookup_key: entry.lookup_key, amount: amount ?? entry.amount, currency: curr ?? entry.currency };
}

/** Safe log fields (ids, amounts, reasons — no email, name, or secret). */
export function priceCheckLogFields(check: PriceCheck): Record<string, unknown> {
  if (check.ok) {
    return { price_check: "accepted", plan_id: check.plan_id, price_id: check.price_id, lookup_key: check.lookup_key, amount: check.amount, currency: check.currency };
  }
  const out: Record<string, unknown> = { price_check: "rejected", reason: check.reason };
  for (const k of ["price_id", "lookup_key", "amount", "currency", "expected_plan", "pairing_plan", "metadata_plan"] as const) {
    if (check[k] !== undefined) out[k] = check[k];
  }
  return out;
}

export async function pairingPlanForEvent(store: SubscriptionStore, ref: string | null | undefined): Promise<string | undefined> {
  if (!ref || typeof store.pairingPlanForCheckoutRef !== "function") return undefined;
  return store.pairingPlanForCheckoutRef(ref);
}
