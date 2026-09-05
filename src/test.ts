// Self-check. No framework — assert plus a seeded dataset is enough to catch the
// things that actually break: the netting arithmetic and the exception routing.
//
//   npm test

import assert from "node:assert/strict";
import { generate } from "./generate.ts";
import { matchDeterministic, matchLedgerToSettlement } from "./match.ts";
import { score, scorePayments } from "./report.ts";

const d = generate(220, 42);
const { decisions, residuals } = matchDeterministic(d.settlements, d.bank);
const byUtr = new Map(decisions.map((x) => [x.utr, x]));
const truthByUtr = new Map(d.truth.map((t) => [t.utr, t]));
const payDecisions = matchLedgerToSettlement(d.ledger, d.settlements);
const payByend = new Map(payDecisions.map((x) => [x.payment_id, x]));

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

check("settlement rows are internally consistent (net = gross − fee − gst − refund − cb)", () => {
  for (const s of d.settlements) {
    assert.equal(
      s.net_paise,
      s.gross_paise - s.fee_paise - s.gst_paise - s.refund_paise - s.chargeback_paise,
      `net mismatch on ${s.settlement_id}`,
    );
  }
});

check("all money is integer paise — no floats leak into the ledger", () => {
  for (const s of d.settlements) {
    assert.ok(Number.isInteger(s.net_paise), `${s.settlement_id} net is not an integer`);
    assert.ok(Number.isInteger(s.fee_paise), `${s.settlement_id} fee is not an integer`);
  }
});

check("every UTR gets exactly one decision", () => {
  assert.equal(decisions.length + residuals.length, d.truth.length);
  assert.equal(new Set(decisions.map((x) => x.utr)).size, decisions.length);
});

check("clean settlements resolve at Tier 0, not by escalation", () => {
  const clean = d.truth.filter((t) => t.exception_code === null);
  assert.ok(clean.length > 50, "expected a meaningful number of clean UTRs");
  for (const t of clean) {
    const dec = byUtr.get(t.utr);
    assert.ok(dec, `no decision for ${t.utr}`);
    assert.equal(dec.tier, "T0_EXACT", `${t.utr} should be exact`);
    assert.equal(dec.matched, true);
  }
});

check("an off-contract fee is caught even though the cash reconciles", () => {
  const fees = d.truth.filter((t) => t.exception_code === "FEE_GST_VARIANCE");
  assert.ok(fees.length > 0);
  for (const t of fees) {
    const dec = byUtr.get(t.utr)!;
    assert.equal(dec.exception_code, "FEE_GST_VARIANCE", `${t.utr} missed fee variance`);
    assert.equal(dec.delta_paise, 0, "bank agrees — this is why delta cannot price it");
    assert.ok(dec.exposure_paise > 0, "the overcharge must still be priced");
  }
});

check("structural breaks route to the right code", () => {
  for (const code of ["MISSING_IN_BANK", "MISSING_IN_LEDGER", "DUPLICATE_UTR", "PARTIAL_SETTLEMENT"] as const) {
    const rows = d.truth.filter((t) => t.exception_code === code);
    assert.ok(rows.length > 0, `generator produced no ${code}`);
    for (const t of rows) {
      const dec = byUtr.get(t.utr)!;
      assert.equal(dec.exception_code, code, `${t.utr} misrouted`);
      assert.equal(dec.matched, false);
      assert.equal(dec.needs_human, true);
    }
  }
});

check("explainable nettings reconcile instead of escalating", () => {
  for (const code of ["REFUND_NETTED", "CHARGEBACK_DEBIT", "TIMING_T_PLUS_N"] as const) {
    for (const t of d.truth.filter((x) => x.exception_code === code)) {
      const dec = byUtr.get(t.utr)!;
      assert.equal(dec.matched, true, `${t.utr} (${code}) should reconcile once explained`);
      assert.equal(dec.needs_human, false, `${t.utr} should not need a human`);
    }
  }
});

check("only genuinely ambiguous gaps reach the LLM", () => {
  assert.ok(residuals.length > 0, "Tier 2 should receive something");
  assert.ok(
    residuals.length / d.truth.length < 0.1,
    `LLM share ${residuals.length}/${d.truth.length} is too high — Tier 1 is underperforming`,
  );
  for (const r of residuals) {
    assert.equal(truthByUtr.get(r.utr)!.exception_code, "AMOUNT_MISMATCH_UNEXPLAINED");
  }
});

check("the deterministic tiers produce zero false positives", () => {
  const s = score(decisions, d.truth, {
    seconds: 1,
    sourceRows: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.equal(s.fp, 0, "a false positive silently writes off real money");
  assert.equal(s.fp_exposure_paise, 0);
});

check("Pass A: every ledger payment gets a decision", () => {
  assert.equal(payDecisions.length, d.ledger.length);
  assert.equal(
    new Set(payDecisions.map((x) => x.payment_id)).size,
    payDecisions.length,
  );
});

check("Pass A: a capture that never reaches a settlement is caught", () => {
  const orphans = d.payment_truth.filter(
    (t) => t.exception_code === "UNSETTLED_CAPTURE",
  );
  assert.ok(orphans.length > 0, "generator produced no unsettled captures");
  for (const t of orphans) {
    const dec = payByend.get(t.payment_id)!;
    assert.equal(dec.exception_code, "UNSETTLED_CAPTURE", `${t.payment_id} missed`);
    assert.equal(dec.matched, false);
    assert.ok(dec.exposure_paise > 0, "unsettled money must carry exposure");
  }
});

check("Pass A finds what Pass B structurally cannot", () => {
  // An unsettled capture touches neither the settlement report nor the bank, so the
  // UTR-grain pass sees a perfectly clean payout. This is the whole reason the third
  // source has to be reconciled rather than merely loaded.
  const orphan = d.payment_truth.find(
    (t) => t.exception_code === "UNSETTLED_CAPTURE",
  )!;
  const u = orphan.payment_id.split("_")[1];
  const utrDecision = byUtr.get(`UTR${700000 + Number(u)}`)!;
  assert.equal(utrDecision.matched, true, "Pass B should see nothing wrong");
  assert.equal(payByend.get(orphan.payment_id)!.matched, false, "Pass A must catch it");
});

check("Pass A produces zero false positives", () => {
  const s = scorePayments(payDecisions, d.payment_truth);
  assert.equal(s.fp, 0, "a false agreement hides captured money that was never paid");
  assert.equal(s.recall, 1);
});

check("results are reproducible across runs", () => {
  const again = generate(220, 42);
  assert.deepEqual(again.truth, d.truth, "same seed must produce the same dataset");
});

console.log(`\n  ${passed} checks passed\n`);
