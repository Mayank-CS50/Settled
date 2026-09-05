# Architecture

## The loop being closed

Three systems disagree about the same money, and none of them is wrong:

| Source | Grain | Says |
|---|---|---|
| Internal ledger | one row per payment | what the customer was charged (gross) |
| Settlement report | one row per payment, grouped by UTR | what Razorpay will pay out (net, after fees) |
| Bank statement | one row per UTR | what actually arrived |

These do not share a grain, so they cannot reconcile in one step. Matching payment-to-
credit one-to-one cannot work — a single bank credit covers many payments, and the
netting happens at the payout level. Getting this wrong is the most common structural
mistake in reconciliation code.

The system therefore runs **two passes at two grains**:

| Pass | Sources | Grain | Question |
|---|---|---|---|
| **A** | ledger ↔ settlement | per payment | Did the PG agree to pay for this, at the right amount? |
| **B** | settlement ↔ bank | per UTR | Did the netted payout arrive? |

Each pass carries its own ground truth and its own confusion matrix, so neither can
mask the other. Payment-grain anomalies are injected only into UTRs that are clean at
the payout grain, keeping the two independently measurable.

**Pass A is not decorative.** A capture that never enters a settlement leaves the
settlement and bank sides agreeing perfectly — neither has heard of it — so Pass B
reports a clean payout. Only the ledger knows the money was taken. `test.ts` asserts
exactly this: the UTR reads matched while the payment reads unmatched.

## Flow — Pass B (UTR grain)

Pass A is a single payment-id join: absent from settlements → `UNSETTLED_CAPTURE`
(exposure = full gross); gross disagreement → `GROSS_MISMATCH` (exposure = the
difference); otherwise agreed. Pass B is where the netting model lives:

```
  ledger.csv      settlements.csv      bank.csv
      │                  │                 │
      └──────────┬───────┴─────────────────┘
                 ▼
        group by UTR → computeNetting()
        gross, fee, gst, refund, chargeback,
        expected_net, credit, delta, lag_days
                 │
                 ▼
   ┌─────────────────────────────────────────────┐
   │ STRUCTURAL          settlements missing?    │ → MISSING_IN_LEDGER
   │                     bank line missing?      │ → MISSING_IN_BANK
   │                     >1 bank line per UTR?   │ → DUPLICATE_UTR
   ├─────────────────────────────────────────────┤
   │ FEE INTEGRITY       fee ≠ 2% of gross?      │ → FEE_GST_VARIANCE
   ├─────────────────────────────────────────────┤
   │ delta == 0          lag > T+2               │ → TIMING_T_PLUS_N   ✓matched
   │                     chargeback > 0          │ → CHARGEBACK_DEBIT  ✓matched
   │                     refund > 0              │ → REFUND_NETTED     ✓matched
   │                     otherwise               │ → T0 exact          ✓matched
   ├─────────────────────────────────────────────┤
   │ delta ≠ 0           credit < 90% expected   │ → PARTIAL_SETTLEMENT
   │                     small unexplained gap   │ → escalate to T2
   └─────────────────────────────────────────────┘
                 │
                 ▼
      Gemini Flash — temperature 0, constrained decoding
      structured verdict, confidence-gated at 0.75
                 │
                 ▼
     scorecard.json  ·  audit.jsonl (append-only)
```

## Design decisions

**Integer paise everywhere.** `0.1 + 0.2 !== 0.3`. A float in a reconciliation engine
produces drift that looks exactly like a real exception, and you cannot tell them apart
after the fact. Every amount in the system is an integer number of paise; rupees exist
only in display strings.

**Order of checks is precedence, not style.** Structural failures are evaluated before
arithmetic ones because a missing bank line makes every downstream number meaningless.
Fee integrity is checked before the delta branch because it is the one exception that is
invisible in the delta.

**Fee is recomputed, not trusted.** `expected_fee` is derived from gross at the
contracted rate and compared against what the settlement report claims. Reading the fee
off the report and comparing it to itself would always agree — and would never catch the
overcharge, which is the single most valuable thing this system finds.

**Exposure is decoupled from delta.** Each exception prices its own risk:

| Code | Exposure |
|---|---|
| `FEE_GST_VARIANCE` | `fee − expected_fee` (delta is ₹0) |
| `MISSING_IN_BANK` | full `expected_net` |
| `MISSING_IN_LEDGER` | full `credit` (unattributed money in) |
| `PARTIAL_SETTLEMENT` | `expected_net − credit` (the shortfall) |
| `DUPLICATE_UTR` | `credit − expected_net` (the excess) |
| `UNSETTLED_CAPTURE` | full ledger `gross` (captured, never paid out) |
| `GROSS_MISMATCH` | absolute difference between ledger and settlement gross |
| explained/matched | ₹0 |

**The LLM is last, and it is bounded.** Tier 2 receives pre-computed figures, not raw
CSVs — the arithmetic is already done, so the model is asked for judgment, not
calculation. It returns a typed verdict (`matched`, `exception_code`, `reason`,
`confidence`) via constrained decoding, never free text, and that verdict is validated
against a zod schema on our side as well — schema-constrained decoding is a strong
guarantee, not a total one, and this value decides whether money is written off.

**The provider is swappable.** Tier 2 consumes a `Netting` and returns a `Decision`,
so the model behind it is confined to one file. It moved from Anthropic to Gemini
during the build without touching either pass. A `matched` verdict below 0.75
confidence is downgraded to `needs_human`: a low-confidence match is a guess about
money.

**The system prompt biases toward escalation.** It explicitly instructs the model to
prefer `AMOUNT_MISMATCH_UNEXPLAINED` over inventing a cause, because a false "reconciled"
writes off real money while a false exception costs one analyst minute. The asymmetry is
deliberate and stated in the prompt rather than left to the model's judgment.

**Failure is a first-class path.** No credentials, a rate limit, an API error, or an
unparseable response all resolve the same way: the residual is marked `needs_human` with
the reason recorded. The pipeline always completes. There is no code path where an
unreachable model produces a clean reconciliation.

**Append-only audit trail.** Every decision — including the automatic ones — is written
to `data/audit.jsonl` with its tier, delta, exposure, reason, and confidence. The match
rate is a summary of this file, not a substitute for it. A finance team needs the line
items; the headline number is for the dashboard.

## Measurement

The generator owns ground truth, which is what makes the numbers checkable rather than
asserted. `truth.json` records, per UTR, whether it *should* reconcile and which
exception it carries. `score()` computes a confusion matrix against that, so:

- **precision** — of the UTRs we declared reconciled, how many truly were
- **recall** — of the UTRs that truly reconcile, how many we found
- **code accuracy** — did we assign the *right* exception, not merely flag one
- **false-positive exposure** — the rupee cost of being wrong in the dangerous direction

An engine that matched everything would score 78.6% "match rate" and be catastrophically
wrong. Precision is what catches that, and it is why the match rate is reported next to
it rather than alone.

## What I would build next

1. **Real rate cards.** Per-method, per-tenure fee rates instead of a flat 2% — the fee
   integrity check is only as good as the rate it compares against.
2. **Adversarial testing of Tier 2.** The deterministic tiers are well covered; the LLM
   path sees ~7 UTRs per run and has never run against the live API. It needs a dedicated
   eval set of ambiguous residuals.
3. **Recovery actions.** Detection is closed; the loop is not. `MISSING_IN_BANK` and
   `PARTIAL_SETTLEMENT` should open a support ticket with the evidence attached.
4. **Streaming ingestion.** Currently batch over CSV. Real settlement data arrives daily
   via webhook and the exception queue should be incremental.
