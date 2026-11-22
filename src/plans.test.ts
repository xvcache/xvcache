import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlansCatalog, recommendPlan, requestUpgrade, getOffer } from "./plans.js";

test("plans catalog marks every price as TBD and payment as not live", () => {
  const catalog = loadPlansCatalog();
  assert.equal(catalog.payment_live, false);
  assert.equal(catalog.prices_status, "TBD");
  assert.ok(catalog.plans.some((p) => p.id === "free" && p.status === "available"));
  assert.ok(catalog.plans.some((p) => p.kind === "usage_based"));
  assert.ok(catalog.plans.filter((p) => p.kind === "bundle").length >= 2);
  for (const plan of catalog.plans) {
    assert.equal(plan.price.amount, null);
    assert.equal(plan.price.status, "TBD");
    assert.equal(plan.price.placeholder, true);
  }
});

test("recommend_plan: free without witness, bundle for moderate volume, reseller terms TBD", () => {
  const free = recommendPlan({ needs_certified_witness: false });
  assert.equal(free.recommended_plan_id, "free");
  assert.equal(free.payment_live, false);

  const starter = recommendPlan({ notes_per_month: 80, certifications_per_month: 15, needs_certified_witness: true });
  assert.equal(starter.recommended_plan_id, "bundle-starter");
  assert.equal(starter.prices_status, "TBD");
  assert.equal(starter.certified_witness_status, "preview");

  const plus = recommendPlan({ notes_per_month: 2000, certifications_per_month: 400, needs_certified_witness: true });
  assert.equal(plus.recommended_plan_id, "bundle-plus");

  const usage = recommendPlan({ certifications_per_month: 10_000, needs_certified_witness: true });
  assert.equal(usage.recommended_plan_id, "usage");

  const resale = recommendPlan({ certifications_per_month: 10, reseller: true });
  assert.ok(resale.reseller);
  assert.equal((resale.reseller as { status: string }).status, "TBD");
});

test("request_upgrade is a human-approval stub with no checkout URL", () => {
  const up = requestUpgrade("bundle-starter");
  assert.equal(up.ok, true);
  assert.equal(up.payment_live, false);
  assert.equal(up.status, "needs_human_approval");
  const approval = up.approval as { checkout_url: unknown; method_now: string; method_later: string };
  assert.equal(approval.checkout_url, null);
  assert.equal(approval.method_now, "stripe_checkout");
  assert.equal(approval.method_later, "x402");
  const bad = requestUpgrade("nope");
  assert.equal(bad.ok, false);
});

test("catalog marks certified proofs as paid (price TBD) and local V/X as free", () => {
  const cat = loadPlansCatalog();
  const free = cat.plans.find((p) => p.id === "free")!;
  assert.equal(free.certified_witness, false);
  const usage = cat.plans.find((p) => p.id === "usage")!;
  assert.equal(usage.price.status, "TBD");
  assert.equal(usage.certified_witness, true);
  assert.match(usage.includes.join(" "), /certify_note/);
  const offer = getOffer();
  assert.equal(offer.payment_live, false);
});
