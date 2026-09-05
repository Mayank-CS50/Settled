// Tier 2 — the LLM, used only on what Tiers 0 and 1 could not explain.
//
// Reconciliation is not an LLM problem. Exact joins and the netting model resolve
// the overwhelming majority at zero marginal cost. What is left is genuinely
// ambiguous: a small gap that could be a rounding artifact, an unbilled charge, or
// real leakage. That judgment is worth a model call. Nothing else here is.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import type { Netting } from "./match.ts";
import { EXCEPTION_CODES, type Decision } from "./types.ts";

const MODEL = "claude-opus-5";

const Verdict = z.object({
  matched: z
    .boolean()
    .describe("True only if the gap is fully explained and no money is missing."),
  exception_code: z
    .enum(EXCEPTION_CODES)
    .describe("The single code that best characterises this residual."),
  reason: z
    .string()
    .describe("One sentence a finance analyst can act on. Cite the amounts."),
  confidence: z.number().min(0).max(1),
});

const SYSTEM = `You adjudicate residual payment-reconciliation exceptions for an Indian PA/PG merchant.

Razorpay settles NET, on a T+2 cycle:
  net = gross − fee(2%) − GST(18% of fee) − refunds − chargebacks

A deterministic engine has already resolved every case it could: missing sides,
duplicate UTRs, fee-rate variance, part-payments, timing lag, refund and chargeback
netting. What reaches you is a small unexplained gap between the bank credit and the
expected net.

Judge only whether the residual gap represents real missing money.
Be conservative: if you cannot explain the gap from the figures given, do NOT mark it
matched. Prefer AMOUNT_MISMATCH_UNEXPLAINED over inventing a cause. A wrong "matched"
silently writes off real money, which is far worse than an extra item on a review queue.`;

const rupees = (p: number): string => `₹${(p / 100).toFixed(2)}`;

function prompt(n: Netting): string {
  return `UTR ${n.utr}

Gross across payments : ${rupees(n.gross)}
Fee charged           : ${rupees(n.fee)}  (contracted: ${rupees(n.expected_fee)})
GST on fee            : ${rupees(n.gst)}
Refunds netted        : ${rupees(n.refund)}
Chargebacks netted    : ${rupees(n.chargeback)}
Expected net to bank  : ${rupees(n.expected_net)}
Actual bank credit    : ${rupees(n.credit)}
Unexplained gap       : ${rupees(n.delta)}
Settlement lag        : T+${n.lag_days}

Classify this residual.`;
}

/** Marks a residual for human review without calling the API. */
const unreviewed = (n: Netting, why: string): Decision => ({
  utr: n.utr,
  matched: false,
  exception_code: "AMOUNT_MISMATCH_UNEXPLAINED",
  tier: "T2_LLM",
  delta_paise: n.delta,
  exposure_paise: Math.abs(n.delta),
  reason: `Not adjudicated (${why}). Gap of ${rupees(n.delta)} held for review.`,
  confidence: 0,
  needs_human: true,
});

export interface AdjudicationRun {
  decisions: Decision[];
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
}

export async function adjudicate(
  residuals: Netting[],
  opts: { minConfidence?: number } = {},
): Promise<AdjudicationRun> {
  const minConfidence = opts.minConfidence ?? 0.75;

  if (residuals.length === 0)
    return { decisions: [], llm_calls: 0, input_tokens: 0, output_tokens: 0 };

  // Degrade gracefully: without credentials the pipeline still completes and every
  // residual lands on the review queue. An unreachable model must never look like a
  // clean reconciliation.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      decisions: residuals.map((n) => unreviewed(n, "no API credentials")),
      llm_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
    };
  }

  const client = new Anthropic();
  let input_tokens = 0;
  let output_tokens = 0;
  let llm_calls = 0;

  const settled = await Promise.all(
    residuals.map(async (n): Promise<Decision> => {
      try {
        const res = await client.messages.parse({
          model: MODEL,
          max_tokens: 4000,
          system: SYSTEM,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "medium", // narrow classification over pre-computed figures
            format: zodOutputFormat(Verdict),
          },
          messages: [{ role: "user", content: prompt(n) }],
        });

        llm_calls++;
        input_tokens += res.usage.input_tokens;
        output_tokens += res.usage.output_tokens;

        const v = res.parsed_output;
        if (!v) return unreviewed(n, "model returned unparseable output");

        // Gate on confidence: a low-confidence "matched" is not a match, it is a
        // guess about money. Bound it and escalate.
        const trusted = v.matched && v.confidence >= minConfidence;
        return {
          utr: n.utr,
          matched: trusted,
          exception_code: v.exception_code,
          tier: "T2_LLM",
          delta_paise: n.delta,
          // A residual we accept is written off; one we hold is still at risk.
          exposure_paise: trusted ? 0 : Math.abs(n.delta),
          reason:
            v.matched && !trusted
              ? `${v.reason} [held: confidence ${v.confidence.toFixed(2)} < ${minConfidence}]`
              : v.reason,
          confidence: v.confidence,
          needs_human: !trusted,
        };
      } catch (err) {
        // Carry the real reason into the audit trail. A bare "unexpected error" once
        // hid a client-side TypeError here for two full runs, which read exactly like
        // a model failure — an opaque reason on a money path is its own bug.
        const why =
          err instanceof Anthropic.RateLimitError
            ? "rate limited"
            : err instanceof Anthropic.APIError
              ? `API ${err.status}: ${String(err.message).slice(0, 120)}`
              : `client error: ${err instanceof Error ? err.message : String(err)}`;
        return unreviewed(n, why);
      }
    }),
  );

  return { decisions: settled, llm_calls, input_tokens, output_tokens };
}
