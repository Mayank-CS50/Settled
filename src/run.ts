// Pipeline entry point: load → deterministic tiers → LLM residual → score → audit.

import { existsSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { adjudicate } from "./adjudicate.ts";
import {
  loadSources,
  matchDeterministic,
  matchLedgerToSettlement,
} from "./match.ts";
import { render, renderPayments, score, scorePayments } from "./report.ts";
import type { Decision, PaymentTruthRow, TruthRow } from "./types.ts";

if (!existsSync("data/bank.csv")) {
  console.error("No data found. Run:  npm run generate");
  process.exit(1);
}

const started = performance.now();

const { ledger, settlements, bank } = loadSources();
const paymentDecisions = matchLedgerToSettlement(ledger, settlements);
const { decisions: deterministic, residuals } = matchDeterministic(
  settlements,
  bank,
);

const deterministicSeconds = (performance.now() - started) / 1000;

console.log(
  `  Tier 0/1 resolved ${deterministic.length} UTRs · ${residuals.length} residuals escalated to Tier 2`,
);

const run = await adjudicate(residuals);
const decisions: Decision[] = [...deterministic, ...run.decisions];
const seconds = (performance.now() - started) / 1000;

const truth: TruthRow[] = JSON.parse(readFileSync("data/truth.json", "utf8"));
const card = score(decisions, truth, {
  seconds,
  deterministicSeconds,
  sourceRows: ledger.length + settlements.length + bank.length,
  llmCalls: run.llm_calls,
  inputTokens: run.input_tokens,
  outputTokens: run.output_tokens,
  model: run.model,
});

const payTruth: PaymentTruthRow[] = JSON.parse(
  readFileSync("data/payment-truth.json", "utf8"),
);
const payCard = scorePayments(paymentDecisions, payTruth);

console.log(render(card, decisions));
console.log(renderPayments(payCard));

// Append-only audit trail: every decision, its tier, and why. This is the artefact
// a finance team actually needs — the match rate is just its summary.
writeFileSync(
  "data/audit.jsonl",
  decisions
    .sort((a, b) => a.utr.localeCompare(b.utr))
    .map((d) => JSON.stringify(d))
    .join("\n"),
);
writeFileSync(
  "data/scorecard.json",
  JSON.stringify({ pass_b_utr: card, pass_a_payment: payCard }, null, 2),
);
console.log("  audit trail → data/audit.jsonl · scorecard → data/scorecard.json\n");
