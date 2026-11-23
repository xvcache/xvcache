import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EU_LANGS } from "./i18n.js";
import { getOffer, listPlans, presentToClient, requestUpgradeFlow, recommendPlan, loadPlansCatalog, PAID_PLAN_ID } from "./plans.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plans.json: XVcache Coffre horodaté is 19 EUR excl. VAT / month / organisation, professionals only, sold by RENO'LINE SARL, unlimited; no other amount is invented", () => {
  const cat = loadPlansCatalog();
  const p = cat.plans.find((x) => x.id === PAID_PLAN_ID)!;
  assert.ok(p, "coffre-horodate plan missing");
  assert.equal(p.price.amount, 19);
  assert.equal(p.price.currency, "EUR");
  assert.equal(p.price.status, "announced");
  assert.equal(p.price.tax_behavior, "exclusive");
  assert.equal(p.price.display, "19 EUR excl. VAT / month / organisation");
  assert.equal(p.name, "XVcache Coffre horodaté");
  assert.match(String((p as any).audience), /professionals only/);
  assert.equal((p as any).seller.name, "RENO'LINE SARL");
  assert.equal(p.limits.certifications_per_month.status, "unlimited");
  assert.equal((p as any).trial, undefined, "no trial announced");
  for (const other of cat.plans.filter((x) => x.id !== PAID_PLAN_ID)) {
    assert.equal(other.price.amount, null, `${other.id} must stay TBD`);
    assert.equal(other.price.status, "TBD");
  }
});

test("get_offer(lang=de): contested claims fall back to the validated English text (pending native retranslation); German limits kept; next tool present_to_client", () => {
  const o = getOffer({ lang: "de" }) as Record<string, any>;
  assert.equal(o.lang, "de");
  assert.match(o.pitch, /eIDAS/);
  assert.match(o.pitch, /Art\. 41/);
  assert.match(o.pitch, /issued by Certigna/);
  assert.match(o.pitch, /not a qualified trust service provider/);
  assert.doesNotMatch(o.pitch, /\bprove/i);
  assert.ok(Array.isArray(o.legal_limits) && o.legal_limits.length >= 3);
  assert.equal(o.price.display, "19 EUR excl. VAT / month / organisation");
  assert.equal(o.price.status, "announced");
  assert.match(o.price.label_localized, /professional price/);
  assert.match(o.eidas_basis.url, /eur-lex\.europa\.eu/);
  assert.equal(o.next_tool, "present_to_client");
  assert.equal(o.trial, null, "no trial announced");
  assert.equal(o.payment_live, false);
});

test("get_offer / list_plans / present_to_client in all 24 languages; unsupported lang falls back to en without failing", () => {
  for (const lang of EU_LANGS) {
    const o = getOffer({ lang }) as Record<string, any>;
    assert.equal(o.lang, lang);
    assert.match(o.pitch, /41/, `${lang}: art. 41 missing in pitch`);
    const pr = presentToClient({ lang, context: "litige" });
    // Count words, not punctuation tokens (French typography puts spaces around ":" and ";").
    const words = pr.message_markdown.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
    assert.ok(words < 180, `${lang}: ${words} words`);
    assert.match(pr.message_markdown, /19 EUR/);
    assert.match(pr.consent_prompt, /19 EUR/);
    assert.ok(pr.consent_prompt.trim().endsWith("?") || /\?\s*\(/.test(pr.consent_prompt) || /\)$/.test(pr.consent_prompt.trim()), `${lang}: consent prompt must be a yes/no question`);
    assert.ok(pr.disclaimers.length >= 3);
    const lp = listPlans({ lang }) as Record<string, any>;
    assert.match(lp.tax, /reverse charge/);
  }
  const ja = getOffer({ lang: "ja" }) as Record<string, any>;
  assert.equal(ja.lang, "en");
  assert.equal(ja.lang_fallback, true);
});

test("consent_prompt states price excl. VAT, monthly period, professionals only, seller, cancellation and VAT, no trial (en, fr)", () => {
  const pr = presentToClient({ lang: "en" });
  assert.match(pr.consent_prompt, /19 EUR excl\. VAT/);
  assert.match(pr.consent_prompt, /month/);
  assert.doesNotMatch(pr.consent_prompt, /14|trial/i);
  assert.match(pr.consent_prompt, /reserved for professionals/);
  assert.match(pr.consent_prompt, /RENO'LINE SARL/);
  assert.match(pr.consent_prompt, /end of the paid month/);
  const fr = presentToClient({ lang: "fr" });
  assert.match(fr.consent_prompt, /réservé aux professionnels/);
  assert.match(fr.consent_prompt, /19 EUR HT par mois et par organisation/);
  assert.doesNotMatch(fr.consent_prompt + fr.message_markdown, /essai|bientôt|prouve/i);
  assert.match(pr.consent_prompt, /cancel/i);
  assert.match(pr.consent_prompt, /VAT/);
  assert.equal(pr.next_tool, "request_upgrade");
});

test("request_upgrade: CONSENT_REQUIRED without human_confirmed AND consent_quote; PLAN_UNKNOWN; BILLING_UNAVAILABLE while Stripe is not connected (L4)", async () => {
  const noConsent = await requestUpgradeFlow({ lang: "fr" });
  assert.equal(noConsent.ok, false);
  assert.equal(noConsent.code, "CONSENT_REQUIRED");
  assert.match(String(noConsent.consent_prompt), /19 EUR/);
  const emptyQuote = await requestUpgradeFlow({ human_confirmed: true, consent_quote: "  " });
  assert.equal(emptyQuote.code, "CONSENT_REQUIRED");
  const unconfirmed = await requestUpgradeFlow({ human_confirmed: false, consent_quote: "oui" });
  assert.equal(unconfirmed.code, "CONSENT_REQUIRED");
  const unknown = await requestUpgradeFlow({ plan_id: "gold", human_confirmed: true, consent_quote: "yes" });
  assert.equal(unknown.code, "PLAN_UNKNOWN");
  const tbd = await requestUpgradeFlow({ plan_id: "bundle-starter", human_confirmed: true, consent_quote: "yes" });
  assert.equal(tbd.code, "PLAN_UNKNOWN", "TBD plans are not purchasable");
  const ok = await requestUpgradeFlow({ human_confirmed: true, consent_quote: "Oui" });
  assert.equal(ok.code, "BILLING_UNAVAILABLE");
  assert.equal(ok.retryable, false);
  assert.equal(ok.checkout_url, null);
  for (const r of [noConsent, unknown, ok]) {
    for (const k of ["code", "message_localized", "retryable", "next_action"]) assert.ok(k in r, `${r.code}: ${k} missing`);
  }
});

test("request_upgrade with a billing provider returns its checkout URL and records the consent quote with a timestamp", async () => {
  const seen: Record<string, unknown>[] = [];
  const r = await requestUpgradeFlow(
    { human_confirmed: true, consent_quote: "Ja, bitte", lang: "de" },
    { billing: { live: true, async createCheckout(req) { seen.push(req); return { checkout_url: "https://checkout.stripe.com/c/pay/cs_test_x", expires_at: "2026-11-23T20:00:00.000Z" }; } } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_x");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].plan_id, PAID_PLAN_ID);
  const consent = r.consent as { quote: string; at: string };
  assert.equal(consent.quote, "Ja, bitte");
  assert.ok(Date.parse(consent.at) > 0);
});

test("recommend_plan: needs_qualified_timestamp or docs_per_month → coffre-horodate with a localized reason", () => {
  const r = recommendPlan({ needs_qualified_timestamp: true, docs_per_month: 20, lang: "it" }) as Record<string, any>;
  assert.equal(r.plan_id, PAID_PLAN_ID);
  assert.equal(r.recommended_plan_id, PAID_PLAN_ID);
  assert.ok(typeof r.reason_localized === "string" && r.reason_localized.length > 10);
});

test("audit: no next_step / next_action / description asks the human anything except the payment consent", () => {
  const files = [
    ...readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "test-client.ts" && f !== "test-tsa.ts").map((f) => path.join(ROOT, "src", f)),
    path.join(ROOT, "plans.json"),
    ...readdirSync(path.join(ROOT, "locales")).map((f) => path.join(ROOT, "locales", f)),
  ];
  const offenders: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const asks = /Ask the human/i.test(line) || /\bask(s|ing)?\b[^.]*\b(human|user|lawyer)\b/i.test(line);
      const allowed = /consent|approv|yes\/no|never ask|do not ask|don't ask|without asking|no question/i.test(line);
      if (asks && !allowed) offenders.push(`${path.basename(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("llms.txt: eIDAS, qualified timestamp, lawyer and EU within the first 30 lines", () => {
  const head = readFileSync(path.join(ROOT, "llms.txt"), "utf8").split("\n").slice(0, 30).join("\n");
  for (const w of ["eIDAS", "qualified timestamp", "lawyer", "EU"]) assert.ok(head.includes(w), `llms.txt head lacks ${w}`);
});
