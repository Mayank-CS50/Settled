# Settled

**AI Finance Controller — Razorpay AI Buildathon, Track 04**

Closes one finance-ops loop end to end: reconciles a merchant's internal ledger, the
Razorpay settlement report, and the bank statement — then reports a match rate, real
precision/recall, and an honest list of what it could not resolve.

---

## The problem nobody models

A bank credit never equals the sum of the payments behind it. Razorpay settles **net**:

```
net = gross − fee (2%) − GST (18% of fee) − refunds − chargebacks     on a T+2 cycle
```

So a finance team opening a bank statement sees a number that matches nothing in their
order table. Most reconciliation tools respond by fuzzy-matching amounts and dates,
which produces confident wrong answers. Settled models the netting arithmetic instead,
so the "mismatches" mostly stop being mismatches — and what remains is genuinely worth
a human's attention.

## Deterministic core, LLM at the edge

Reconciliation is not an LLM problem. Exact joins and the netting model resolve the
overwhelming majority at zero marginal cost and in microseconds. Only the residual —
a small gap that could be rounding, an unbilled charge, or real leakage — is worth a
model call.

| Tier | Method | Share | Cost |
|---|---|---|---|
| **T0 — exact** | UTR join, credit equals expected net | 54.1% | ₹0 |
| **T1 — netting** | fee/GST/refund/chargeback model, T+N window, structural checks | 43.2% | ₹0 |
| **T2 — LLM** | Claude adjudicates the ambiguous remainder, structured verdict | 2.7% | metered |

That ratio is the design. An architecture that sent all 220 UTRs to a model would cost
~37× more, run ~1000× slower, and reconcile *worse* — because arithmetic that must be
exact should not be delegated to a probabilistic system.

## Results

220 settlement UTRs across 1,090 source rows in three systems, seed 42:

```
  auto-match rate     74.5%
  precision          100.0%     (of what we called reconciled)
  recall             100.0%
  exception code acc.100.0%
  TP 164 · FP 0 · TN 56 · FN 0
  false-positive exposure  ₹0.00

  22,213 UTR/s     2.7% of UTRs touched the LLM
```

**Why precision and recall are meaningful here:** the generator emits ground truth, so
these are measured against known-correct labels, not asserted. `npm test` re-derives
them. Their own bar says *"one cherry-picked match proves nothing"* — so the full
exception queue is printed every run, and the audit trail is written to disk.

**False-positive exposure is the metric that matters.** A wrong "reconciled" silently
writes off real money; an extra review item costs an analyst a minute. The system is
tuned accordingly — low-confidence LLM verdicts are held, never accepted.

## Exception taxonomy

Nine codes, each with a rupee exposure attached:

`FEE_GST_VARIANCE` · `TIMING_T_PLUS_N` · `PARTIAL_SETTLEMENT` · `REFUND_NETTED` ·
`CHARGEBACK_DEBIT` · `DUPLICATE_UTR` · `MISSING_IN_BANK` · `MISSING_IN_LEDGER` ·
`AMOUNT_MISMATCH_UNEXPLAINED`

Three of these (`REFUND_NETTED`, `CHARGEBACK_DEBIT`, `TIMING_T_PLUS_N`) **reconcile
once explained** — they are labels, not failures. Treating them as exceptions is how
naive tools generate queues nobody works through.

`FEE_GST_VARIANCE` is the one to look at: the cash reconciles to the rupee against the
bank, so delta is exactly ₹0, yet the merchant is being overcharged on every
settlement. Pricing exposure off the delta would report that leak as costless. It is
priced off the contracted fee rate instead.

## Run it

```bash
npm install
npm run generate     # writes data/{ledger,settlements,bank}.csv + truth.json
npm start            # reconcile, score, write the audit trail
npm test             # 10 assertions over the netting arithmetic and routing
```

Node ≥ 22.6. No build step — TypeScript runs directly via `--experimental-strip-types`.

Tier 2 needs `ANTHROPIC_API_KEY`. **Without it the pipeline still completes**: every
residual lands on the review queue marked `needs_human`, and nothing is falsely
reconciled. An unreachable model must never look like a clean reconciliation.

Outputs land in `data/audit.jsonl` (one JSON decision per line, append-only) and
`data/scorecard.json`.

## Honest limitations

- **Synthetic data.** The netting model is real, the anomaly mix is my estimate of a
  realistic distribution. Rates are hardcoded at Razorpay's standard 2% + 18% GST;
  a real merchant has a negotiated rate card per payment method.
- **Tier 2 is currently exercised on ~6 UTRs per run.** The deterministic tiers are
  good enough that little reaches it. That is the correct outcome, but it means the
  LLM path has had less adversarial testing than the arithmetic.
- **The CSV reader is a naive split** (`src/match.ts`) — fine for generated files,
  not for a live bank export with quoted fields.
- **One currency, one settlement cycle.** No multi-currency, no international
  settlement, no per-method rate cards.

## Layout

```
src/types.ts        money as integer paise; the decision record
src/generate.ts     three synthetic sources + ground truth (seeded)
src/match.ts        Tier 0 and Tier 1 — the netting model
src/adjudicate.ts   Tier 2 — Claude, structured output, confidence-gated
src/report.ts       scoring against truth + the exception queue
src/run.ts          pipeline entry point
src/test.ts         self-check
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the decision flow and design rationale.

MIT.
