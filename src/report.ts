// Scoring against ground truth, plus the exception list.
//
// A match rate on its own is unfalsifiable — an engine that matches everything
// scores 100%. Because the generator emits ground truth, we can report precision
// and recall, and price the false positives in rupees.

import type {
  Decision,
  ExceptionCode,
  PaymentDecision,
  PaymentTruthRow,
  TruthRow,
} from "./types.ts";

// Gemini Flash runs on the AI Studio free tier, so marginal cost is zero. Set these
// to your published per-million rates if you move to a paid tier and want a real
// projection; inventing rates we have not verified would make the number a lie.
const USD_PER_MTOK_IN = Number(process.env.LLM_USD_PER_MTOK_IN ?? 0);
const USD_PER_MTOK_OUT = Number(process.env.LLM_USD_PER_MTOK_OUT ?? 0);

export interface Scorecard {
  utrs: number;
  source_rows: number;
  auto_match_rate: number;
  precision: number;
  recall: number;
  f1: number;
  code_accuracy: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** Rupees wrongly declared reconciled — the cost of a false positive. */
  fp_exposure_paise: number;
  tiers: Record<string, number>;
  llm_share: number;
  needs_human: number;
  seconds: number;
  utrs_per_sec: number;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  model: string;
  usd_cost: number;
  usd_per_1k_utrs: number;
}

export function score(
  decisions: Decision[],
  truth: TruthRow[],
  meta: {
    seconds: number;
    sourceRows: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
  },
): Scorecard {
  const truthByUtr = new Map(truth.map((t) => [t.utr, t]));

  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0,
    codeHits = 0,
    codeTotal = 0,
    fpExposure = 0;

  const tiers: Record<string, number> = {};

  for (const d of decisions) {
    const t = truthByUtr.get(d.utr);
    if (!t) continue;
    tiers[d.tier] = (tiers[d.tier] ?? 0) + 1;

    if (d.matched && t.should_match) tp++;
    else if (d.matched && !t.should_match) {
      fp++;
      fpExposure += d.exposure_paise;
    } else if (!d.matched && !t.should_match) tn++;
    else fn++;

    // Only score the code where truth actually asserts one.
    if (t.exception_code !== null) {
      codeTotal++;
      if (d.exception_code === t.exception_code) codeHits++;
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const usd =
    (meta.inputTokens / 1e6) * USD_PER_MTOK_IN +
    (meta.outputTokens / 1e6) * USD_PER_MTOK_OUT;
  const n = decisions.length;

  return {
    utrs: n,
    source_rows: meta.sourceRows,
    auto_match_rate: decisions.filter((d) => d.matched).length / n,
    precision,
    recall,
    f1:
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall),
    code_accuracy: codeTotal === 0 ? 1 : codeHits / codeTotal,
    tp,
    fp,
    tn,
    fn,
    fp_exposure_paise: fpExposure,
    tiers,
    llm_share: (tiers["T2_LLM"] ?? 0) / n,
    needs_human: decisions.filter((d) => d.needs_human).length,
    seconds: meta.seconds,
    utrs_per_sec: n / Math.max(meta.seconds, 0.001),
    llm_calls: meta.llmCalls,
    input_tokens: meta.inputTokens,
    output_tokens: meta.outputTokens,
    model: meta.model,
    usd_cost: usd,
    usd_per_1k_utrs: (usd / n) * 1000,
  };
}

export interface PaymentScorecard {
  payments: number;
  agree_rate: number;
  precision: number;
  recall: number;
  code_accuracy: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  exposure_paise: number;
  by_code: Record<string, { count: number; exposure_paise: number }>;
}

/** Pass A scoring — payment grain, its own confusion matrix. */
export function scorePayments(
  decisions: PaymentDecision[],
  truth: PaymentTruthRow[],
): PaymentScorecard {
  const truthById = new Map(truth.map((t) => [t.payment_id, t]));
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0,
    codeHits = 0,
    codeTotal = 0,
    exposure = 0;
  const by_code: Record<string, { count: number; exposure_paise: number }> = {};

  for (const d of decisions) {
    const t = truthById.get(d.payment_id);
    if (!t) continue;

    if (d.matched && t.should_match) tp++;
    else if (d.matched && !t.should_match) fp++;
    else if (!d.matched && !t.should_match) tn++;
    else fn++;

    if (t.exception_code !== null) {
      codeTotal++;
      if (d.exception_code === t.exception_code) codeHits++;
    }
    if (!d.matched && d.exception_code) {
      const b = (by_code[d.exception_code] ??= { count: 0, exposure_paise: 0 });
      b.count++;
      b.exposure_paise += d.exposure_paise;
      exposure += d.exposure_paise;
    }
  }

  return {
    payments: decisions.length,
    agree_rate: decisions.filter((d) => d.matched).length / decisions.length,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    code_accuracy: codeTotal === 0 ? 1 : codeHits / codeTotal,
    tp,
    fp,
    tn,
    fn,
    exposure_paise: exposure,
    by_code,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const rupees = (p: number): string => `₹${(p / 100).toFixed(2)}`;

export function renderPayments(s: PaymentScorecard): string {
  const L: string[] = [];
  L.push("  PASS A — ledger vs settlement report (payment grain)");
  L.push("  " + "─".repeat(62));
  L.push(`    ${s.payments} payments   agreement ${pct(s.agree_rate)}`);
  L.push(
    `    precision ${pct(s.precision)}  ·  recall ${pct(s.recall)}  ·  code acc. ${pct(s.code_accuracy)}`,
  );
  L.push(`    TP ${s.tp} · FP ${s.fp} · TN ${s.tn} · FN ${s.fn}`);
  for (const [code, b] of Object.entries(s.by_code).sort(
    (a, b) => b[1].count - a[1].count,
  ))
    L.push(`    ${code.padEnd(20)} ×${b.count}   exposure ${rupees(b.exposure_paise)}`);
  L.push(
    `    money captured but never settled or agreed: ${rupees(s.exposure_paise)}`,
  );
  L.push("");
  return L.join("\n");
}

export function render(s: Scorecard, decisions: Decision[]): string {
  const L: string[] = [];
  L.push("");
  L.push("  SETTLED — reconciliation run");
  L.push("  " + "─".repeat(62));
  L.push(
    `  ${s.source_rows} source rows across 3 systems → ${s.utrs} settlement UTRs`,
  );
  L.push(
    `  ${s.seconds.toFixed(2)}s  ·  ${s.utrs_per_sec.toFixed(0)} UTR/s  ·  ${s.llm_calls} LLM calls (${s.model})`,
  );
  L.push("");
  L.push("  ACCURACY (against generator ground truth)");
  L.push(`    auto-match rate     ${pct(s.auto_match_rate)}`);
  L.push(`    precision           ${pct(s.precision)}   (of what we called reconciled)`);
  L.push(`    recall              ${pct(s.recall)}`);
  L.push(`    F1                  ${pct(s.f1)}`);
  L.push(`    exception code acc. ${pct(s.code_accuracy)}`);
  L.push(
    `    TP ${s.tp}  ·  FP ${s.fp}  ·  TN ${s.tn}  ·  FN ${s.fn}`,
  );
  L.push(
    `    false-positive exposure  ${rupees(s.fp_exposure_paise)}  ← money we would have wrongly written off`,
  );
  L.push("");
  L.push("  WORK DISTRIBUTION");
  for (const [tier, n] of Object.entries(s.tiers).sort())
    L.push(`    ${tier.padEnd(12)} ${String(n).padStart(4)}   ${pct(n / s.utrs)}`);
  L.push(
    `    LLM touched ${pct(s.llm_share)} of UTRs — ${s.input_tokens.toLocaleString()} in / ${s.output_tokens.toLocaleString()} out tokens` +
      (s.usd_cost > 0 ? `  ·  ${s.usd_cost.toFixed(4)}` : `  ·  free tier`),
  );
  L.push("");

  // The honest exception list. Everything unresolved, grouped, nothing hidden.
  const open = decisions.filter((d) => d.needs_human);
  const byCode = new Map<ExceptionCode | "UNCODED", Decision[]>();
  for (const d of open) {
    const k = d.exception_code ?? "UNCODED";
    const b = byCode.get(k);
    if (b) b.push(d);
    else byCode.set(k, [d]);
  }

  L.push(`  EXCEPTION QUEUE — ${open.length} items need a human`);
  L.push("  " + "─".repeat(62));
  for (const [code, items] of [...byCode].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const exposure = items.reduce((t, d) => t + d.exposure_paise, 0);
    L.push(`  ${code}  ×${items.length}   exposure ${rupees(exposure)}`);
    for (const d of items.slice(0, 3)) L.push(`      ${d.utr}  ${d.reason}`);
    if (items.length > 3) L.push(`      … ${items.length - 3} more`);
    L.push("");
  }
  return L.join("\n");
}
