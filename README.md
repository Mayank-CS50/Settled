# Settled

**AI Finance Controller — Razorpay AI Buildathon, Track 04**

Closes one finance-ops loop end to end across three systems — the merchant ledger, the
Razorpay settlement report, and the bank statement — then reports match rates, real
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

## Two passes, two grains

The three sources do not reconcile in one step, because they do not share a grain:

| Pass | Sources | Grain | Question |
|---|---|---|---|
| **A** | ledger ↔ settlement report | per payment | Did the PG agree to pay for this at all, at the right amount? |
| **B** | settlement report ↔ bank | per UTR | Did the netted payout actually arrive? |

One bank credit covers many payments, so payment-to-credit matching cannot work — the
cardinalities never line up. Splitting the passes is what makes the third source real
rather than decorative.

Pass A catches what Pass B is structurally blind to. A payment captured in the books
that never enters a settlement leaves the settlement and bank sides agreeing perfectly
with each other — because neither has ever heard of it. Only the ledger knows. In the
current run that is **₹23,794 of captured money that was never settled**, invisible to
any two-source reconciliation.

## Deterministic core, LLM at the edge

Reconciliation is not an LLM problem. Exact joins and the netting model resolve the
overwhelming majority at zero marginal cost and in microseconds. Only the residual —
a small gap that could be rounding, an unbilled charge, or real leakage — is worth a
model call.

| Tier | Method | Share | Cost |
|---|---|---|---|
| **T0 — exact** | UTR join, credit equals expected net | 58.6% | ₹0 |
| **T1 — netting** | fee/GST/refund/chargeback model, T+N window, structural checks | 38.2% | ₹0 |
| **T2 — LLM** | Gemini adjudicates the ambiguous remainder, structured verdict | 3.2% | free tier |

That ratio is the design. An architecture that sent all 220 UTRs to a model would run
orders of magnitude slower, cost ~31× more per token, and reconcile *worse* — because
arithmetic that must be exact should not be delegated to a probabilistic system.

## Results

1,111 source rows across three systems, seed 42:

```
PASS B — settlement vs bank (220 UTRs)
  auto-match rate     78.6%
  precision          100.0%     (of what we called reconciled)
  recall             100.0%
  exception code acc.100.0%
  TP 173 · FP 0 · TN 47 · FN 0
  false-positive exposure  ₹0.00

PASS A — ledger vs settlement (453 payments)
  agreement           96.9%
  precision          100.0%  ·  recall 100.0%  ·  code acc. 100.0%
  TP 439 · FP 0 · TN 14 · FN 0
  UNSETTLED_CAPTURE  ×8   ₹23,794.58
  GROSS_MISMATCH     ×6   ₹179.71

  19,035 UTR/s     3.2% of UTRs touched the LLM     14/14 self-checks
```

**Why precision and recall are meaningful here:** the generator emits ground truth, so
these are measured against known-correct labels, not asserted. `npm test` re-derives
them. Their own bar says *"one cherry-picked match proves nothing"* — so the full
exception queue is printed every run, and the audit trail is written to disk.

**False-positive exposure is the metric that matters.** A wrong "reconciled" silently
writes off real money; an extra review item costs an analyst a minute. The system is
tuned accordingly — low-confidence LLM verdicts are held, never accepted.

## Exception taxonomy

Eleven codes, each with a rupee exposure attached.

**Payment grain (Pass A):** `UNSETTLED_CAPTURE` · `GROSS_MISMATCH`

**UTR grain (Pass B):**

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
npm run generate     # writes data/*.csv + truth.json + payment-truth.json
npm start            # reconcile, score, write the audit trail
npm test             # 14 assertions across both passes
```

Node ≥ 22.6. No build step — TypeScript runs directly via `--experimental-strip-types`.

Tier 2 needs `GEMINI_API_KEY` (free from [AI Studio](https://aistudio.google.com/apikey);
pin a different model with `GEMINI_MODEL`). **Without it the pipeline still completes**: every
residual lands on the review queue marked `needs_human`, and nothing is falsely
reconciled. An unreachable model must never look like a clean reconciliation.

Outputs land in `data/audit.jsonl` (one JSON decision per line, append-only) and
`data/scorecard.json`.

## Honest limitations

- **Synthetic data.** The netting model is real, the anomaly mix is my estimate of a
  realistic distribution. Rates are hardcoded at Razorpay's standard 2% + 18% GST;
  a real merchant has a negotiated rate card per payment method.
- **Tier 2 is exercised on only ~7 UTRs per run.** It has been verified live against
  the API — all 7 residuals adjudicated correctly at 0.95-0.98 confidence, matching
  ground truth — but the deterministic tiers are good enough that little reaches it.
  That is the correct outcome, and it also means the LLM path has had far less
  adversarial testing than the arithmetic.
- **The CSV reader is a naive split** (`src/match.ts`) — fine for generated files,
  not for a live bank export with quoted fields.
- **One currency, one settlement cycle.** No multi-currency, no international
  settlement, no per-method rate cards.
- **The free tier allows only 20 requests per window.** Once exhausted, a circuit
  breaker and a 60s total wait budget (`LLM_WAIT_BUDGET_MS`) stop the pipeline from
  waiting out retry windows item by item — unadjudicated residuals are already safely
  queued, so the exception list is worth more than the remaining verdicts.
- **Tier 2 runs on the Gemini free tier, where Google may use prompts and outputs to
  improve their models.** Acceptable here because every record is synthetic — there is
  no merchant data to leak. A real deployment needs a paid tier or a self-hosted model.

## Layout

```
src/types.ts        money as integer paise; the decision record
src/generate.ts     three synthetic sources + ground truth (seeded)
src/match.ts        Pass A (payment grain) + Pass B Tiers 0/1 — the netting model
src/adjudicate.ts   Tier 2 — Gemini, constrained decoding, confidence-gated
src/report.ts       scoring against truth + the exception queue
src/run.ts          pipeline entry point
src/test.ts         self-check, 14 assertions
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the decision flow and design rationale.

MIT.
