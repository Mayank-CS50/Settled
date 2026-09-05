// Tier 2 — the LLM, used only on what Tiers 0 and 1 could not explain.
//
// Reconciliation is not an LLM problem. Exact joins and the netting model resolve
// the overwhelming majority at zero marginal cost. What is left is genuinely
// ambiguous: a small gap that could be a rounding artifact, an unbilled charge, or
// real leakage. That judgment is worth a model call. Nothing else here is.
//
// Provider: Google Gemini via AI Studio. The tier is provider-agnostic by design —
// it consumes a Netting and returns a Decision, so swapping the model behind it
// touches only this file.

import { GoogleGenAI, Type } from "@google/genai";
import * as z from "zod";
import type { Netting } from "./match.ts";
import { EXCEPTION_CODES, type Decision } from "./types.ts";

/** Flash models are the free-tier eligible family; override to pin a different one. */
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

/** Constrained decoding — the model cannot return a shape we did not ask for. */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    matched: {
      type: Type.BOOLEAN,
      description: "True only if the gap is fully explained and no money is missing.",
    },
    exception_code: {
      type: Type.STRING,
      enum: [...EXCEPTION_CODES],
      description: "The single code that best characterises this residual.",
    },
    reason: {
      type: Type.STRING,
      description: "One sentence a finance analyst can act on. Cite the amounts.",
    },
    confidence: { type: Type.NUMBER, description: "0 to 1." },
  },
  required: ["matched", "exception_code", "reason", "confidence"],
};

// Validated again on our side. Constrained decoding is a strong guarantee, not a
// total one, and this value decides whether money gets written off.
const Verdict = z.object({
  matched: z.boolean(),
  exception_code: z.enum(EXCEPTION_CODES),
  reason: z.string(),
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isRateLimit = (err: unknown): boolean =>
  /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(
    err instanceof Error ? err.message : String(err),
  );

/**
 * A 429 carries a RetryInfo telling you exactly how long to wait. Honour it rather
 * than guessing: the free tier's window is around a minute, so an invented 2s backoff
 * just burns another request and fails again. Falls back to exponential only when the
 * server declines to say.
 */
function retryAfterMs(err: unknown, attempt: number): number {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(
    err instanceof Error ? err.message : String(err),
  );
  return m ? Math.ceil(Number(m[1]) * 1000) + 1000 : 5000 * 2 ** attempt;
}

/**
 * Retry only on rate limits. A 429 is a "come back shortly", not a verdict — dropping
 * a residual on the review queue because we asked too fast would be a false exception.
 * Every other error fails through immediately: a malformed request will not fix
 * itself, and retrying it just burns quota.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !isRateLimit(err)) throw err;
      await sleep(retryAfterMs(err, i));
    }
  }
}

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

/** Marks a residual for human review without a usable model verdict. */
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
  model: string;
}

export async function adjudicate(
  residuals: Netting[],
  opts: { minConfidence?: number } = {},
): Promise<AdjudicationRun> {
  const minConfidence = opts.minConfidence ?? 0.75;
  const empty = { llm_calls: 0, input_tokens: 0, output_tokens: 0, model: MODEL };

  if (residuals.length === 0) return { decisions: [], ...empty };

  // Degrade gracefully: without credentials the pipeline still completes and every
  // residual lands on the review queue. An unreachable model must never look like a
  // clean reconciliation.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return {
      decisions: residuals.map((n) => unreviewed(n, "no API credentials")),
      ...empty,
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const decisions: Decision[] = [];
  let input_tokens = 0;
  let output_tokens = 0;
  let llm_calls = 0;

  // Sequential on purpose: the free tier allows ~10 requests/minute, and a burst of
  // parallel calls trips it. At single-digit residual counts there is nothing to gain
  // from concurrency.
  for (const n of residuals) {
    try {
      const res = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL,
          contents: prompt(n),
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0, // a reconciliation verdict should not vary run to run
          },
        }),
      );

      llm_calls++;
      input_tokens += res.usageMetadata?.promptTokenCount ?? 0;
      output_tokens += res.usageMetadata?.candidatesTokenCount ?? 0;

      const parsed = Verdict.safeParse(JSON.parse(res.text ?? ""));
      if (!parsed.success) {
        decisions.push(unreviewed(n, "model returned an invalid verdict"));
        continue;
      }
      const v = parsed.data;

      // Gate on confidence: a low-confidence "matched" is not a match, it is a
      // guess about money. Bound it and escalate.
      const trusted = v.matched && v.confidence >= minConfidence;
      decisions.push({
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
      });
    } catch (err) {
      // Carry the real reason into the audit trail. A bare "unexpected error" once
      // hid a client-side type error here for two full runs, which read exactly like
      // a model failure — an opaque reason on a money path is its own bug.
      decisions.push(
        unreviewed(n, err instanceof Error ? err.message.slice(0, 140) : String(err)),
      );
    }
  }

  return { decisions, llm_calls, input_tokens, output_tokens, model: MODEL };
}
