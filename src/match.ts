// Tier 0 (exact) and Tier 1 (netting model) — deterministic, zero marginal cost.
//
// The core idea: a bank credit never equals the sum of payments. Razorpay settles
//   net = gross − fee − GST(fee) − refunds − chargebacks,  on a T+2 cycle.
// Model that arithmetic and most "mismatches" stop being mismatches. Only what
// survives this stage is worth spending an LLM call on.

import { readFileSync } from "node:fs";
import type {
  BankRow,
  Decision,
  PaymentDecision,
  LedgerRow,
  Paise,
  SettlementRow,
} from "./types.ts";

const FEE_BPS = 200;
const GST_BPS = 1800;
const SETTLEMENT_CYCLE_DAYS = 2; // T+2
const PARTIAL_THRESHOLD = 0.9; // credit below 90% of expected reads as a part-payment

const bps = (amount: Paise, rate: number): Paise =>
  Math.round((amount * rate) / 10000);

// ponytail: naive split parser; the generated CSVs contain no quoted commas.
// Swap for a real CSV reader if this ever ingests a live bank export.
function readCsv<T>(path: string): T[] {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = header!.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    const row: Record<string, string | number> = {};
    cols.forEach((c, i) => {
      const v = cells[i]!;
      row[c] = /_paise$/.test(c) ? Number(v) : v;
    });
    return row as T;
  });
}

export function loadSources(dir = "data") {
  return {
    ledger: readCsv<LedgerRow>(`${dir}/ledger.csv`),
    settlements: readCsv<SettlementRow>(`${dir}/settlements.csv`),
    bank: readCsv<BankRow>(`${dir}/bank.csv`),
  };
}

const groupBy = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = m.get(k);
    if (bucket) bucket.push(r);
    else m.set(k, [r]);
  }
  return m;
};

const dayDiff = (a: string, b: string): number =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

/**
 * PASS A — ledger vs settlement report, at PAYMENT grain.
 *
 * A different question from Pass B, and a different grain. Pass B asks "did the
 * payout arrive"; Pass A asks "did the PG ever agree to pay for this at all, and for
 * the right amount". A payment captured in the books that never enters a settlement
 * is invisible to Pass B — the settlement and bank sides agree perfectly with each
 * other, because neither has ever heard of it.
 */
export function matchLedgerToSettlement(
  ledger: LedgerRow[],
  settlements: SettlementRow[],
): PaymentDecision[] {
  const byPaymentId = new Map(settlements.map((s) => [s.payment_id, s]));

  return ledger.map((l): PaymentDecision => {
    const s = byPaymentId.get(l.payment_id);

    if (!s) {
      return {
        payment_id: l.payment_id,
        matched: false,
        exception_code: "UNSETTLED_CAPTURE",
        exposure_paise: l.gross_paise,
        reason: `Captured ${rupees(l.gross_paise)} on ${l.captured_at}, never appeared in any settlement.`,
      };
    }

    if (l.gross_paise !== s.gross_paise) {
      return {
        payment_id: l.payment_id,
        matched: false,
        exception_code: "GROSS_MISMATCH",
        exposure_paise: Math.abs(l.gross_paise - s.gross_paise),
        reason: `Books say ${rupees(l.gross_paise)}, settlement says ${rupees(s.gross_paise)} — differ by ${rupees(Math.abs(l.gross_paise - s.gross_paise))}.`,
      };
    }

    return {
      payment_id: l.payment_id,
      matched: true,
      exception_code: null,
      exposure_paise: 0,
      reason: `Agreed at ${rupees(l.gross_paise)}.`,
    };
  });
}

/** What the settlement report says should land in the bank, and why. */
export interface Netting {
  utr: string;
  gross: Paise;
  fee: Paise;
  gst: Paise;
  refund: Paise;
  chargeback: Paise;
  expected_net: Paise;
  credit: Paise;
  delta: Paise;
  expected_fee: Paise;
  lag_days: number;
  bank_lines: number;
}

export function computeNetting(
  utr: string,
  settle: SettlementRow[],
  bankRows: BankRow[],
): Netting {
  const sum = (f: (s: SettlementRow) => Paise) =>
    settle.reduce((t, s) => t + f(s), 0);

  const gross = sum((s) => s.gross_paise);
  const expected_net = sum((s) => s.net_paise);
  const credit = bankRows.reduce((t, b) => t + b.credit_paise, 0);
  // Recompute the fee from the contracted rate rather than trusting the report —
  // this is what catches silent overcharging.
  const expected_fee = settle.reduce(
    (t, s) => t + bps(s.gross_paise, FEE_BPS),
    0,
  );

  return {
    utr,
    gross,
    fee: sum((s) => s.fee_paise),
    gst: sum((s) => s.gst_paise),
    refund: sum((s) => s.refund_paise),
    chargeback: sum((s) => s.chargeback_paise),
    expected_net,
    credit,
    delta: credit - expected_net,
    expected_fee,
    lag_days:
      bankRows.length && settle.length
        ? dayDiff(bankRows[0]!.value_date, settle[0]!.settled_at)
        : 0,
    bank_lines: bankRows.length,
  };
}

const rupees = (p: Paise): string => `₹${(p / 100).toFixed(2)}`;

export interface MatchResult {
  decisions: Decision[];
  /** UTRs the deterministic tiers could not explain — these go to the LLM. */
  residuals: Netting[];
}

export function matchDeterministic(
  settlements: SettlementRow[],
  bank: BankRow[],
): MatchResult {
  const byUtrSettle = groupBy(settlements, (s) => s.utr);
  const byUtrBank = groupBy(bank, (b) => b.utr);
  const allUtrs = new Set([...byUtrSettle.keys(), ...byUtrBank.keys()]);

  const decisions: Decision[] = [];
  const residuals: Netting[] = [];

  for (const utr of [...allUtrs].sort()) {
    const settle = byUtrSettle.get(utr) ?? [];
    const bankRows = byUtrBank.get(utr) ?? [];
    const n = computeNetting(utr, settle, bankRows);

    const emit = (
      d: Omit<Decision, "utr" | "delta_paise" | "confidence" | "exposure_paise"> & {
        exposure_paise?: Paise;
      },
    ) =>
      decisions.push({
        ...d,
        utr,
        delta_paise: n.delta,
        confidence: 1,
        exposure_paise: d.exposure_paise ?? 0,
      });

    // --- structural failures: one side of the loop is simply absent ---
    if (settle.length === 0) {
      emit({
        matched: false,
        exception_code: "MISSING_IN_LEDGER",
        tier: "T1_NETTING",
        exposure_paise: n.credit,
        reason: `Bank credit ${rupees(n.credit)} with no settlement rows. Unattributed money in.`,
        needs_human: true,
      });
      continue;
    }
    if (bankRows.length === 0) {
      emit({
        matched: false,
        exception_code: "MISSING_IN_BANK",
        tier: "T1_NETTING",
        exposure_paise: n.expected_net,
        reason: `Settlement of ${rupees(n.expected_net)} never credited. Payout not received.`,
        needs_human: true,
      });
      continue;
    }
    if (bankRows.length > 1) {
      emit({
        matched: false,
        exception_code: "DUPLICATE_UTR",
        tier: "T1_NETTING",
        exposure_paise: n.credit - n.expected_net,
        reason: `${bankRows.length} bank lines share UTR ${utr}. Double-posting; only one is real.`,
        needs_human: true,
      });
      continue;
    }

    // --- fee integrity: independent of whether the cash reconciles ---
    if (n.fee !== n.expected_fee) {
      emit({
        matched: false,
        exception_code: "FEE_GST_VARIANCE",
        tier: "T1_NETTING",
        exposure_paise: n.fee - n.expected_fee,
        reason: `Fee ${rupees(n.fee)} vs contracted ${rupees(n.expected_fee)} at ${FEE_BPS / 100}% — overcharged ${rupees(n.fee - n.expected_fee)}.`,
        needs_human: true,
      });
      continue;
    }

    // --- the cash agrees; classify why it took the shape it did ---
    if (n.delta === 0) {
      if (n.lag_days > SETTLEMENT_CYCLE_DAYS) {
        emit({
          matched: true,
          exception_code: "TIMING_T_PLUS_N",
          tier: "T1_NETTING",
          reason: `Reconciles, but landed T+${n.lag_days} against a T+${SETTLEMENT_CYCLE_DAYS} cycle.`,
          needs_human: false,
        });
      } else if (n.chargeback > 0) {
        emit({
          matched: true,
          exception_code: "CHARGEBACK_DEBIT",
          tier: "T1_NETTING",
          reason: `Reconciles once ${rupees(n.chargeback)} of chargeback debit is netted off.`,
          needs_human: false,
        });
      } else if (n.refund > 0) {
        emit({
          matched: true,
          exception_code: "REFUND_NETTED",
          tier: "T1_NETTING",
          reason: `Reconciles once ${rupees(n.refund)} of refunds is netted off.`,
          needs_human: false,
        });
      } else {
        emit({
          matched: true,
          exception_code: null,
          tier: "T0_EXACT",
          reason: `Exact: ${rupees(n.gross)} gross − ${rupees(n.fee + n.gst)} fee+GST = ${rupees(n.credit)}.`,
          needs_human: false,
        });
      }
      continue;
    }

    // --- cash disagrees by a lot: a part-payment, not a rounding artifact ---
    if (n.credit < n.expected_net * PARTIAL_THRESHOLD) {
      emit({
        matched: false,
        exception_code: "PARTIAL_SETTLEMENT",
        tier: "T1_NETTING",
        exposure_paise: n.expected_net - n.credit,
        reason: `Received ${rupees(n.credit)} of ${rupees(n.expected_net)} (${((n.credit / n.expected_net) * 100).toFixed(1)}%). Balance outstanding.`,
        needs_human: true,
      });
      continue;
    }

    // --- small unexplained gap: genuinely ambiguous, escalate to Tier 2 ---
    residuals.push(n);
  }

  return { decisions, residuals };
}
