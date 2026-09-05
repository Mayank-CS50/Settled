// All money is integer paise. Never floats — 0.1 + 0.2 !== 0.3 has no place in a ledger.

export type Paise = number;

/** Merchant's own record of what the customer paid. */
export interface LedgerRow {
  order_id: string;
  payment_id: string;
  gross_paise: Paise;
  captured_at: string; // ISO date
  status: "captured" | "refunded" | "disputed";
  refund_paise: Paise; // 0 when none
}

/** A line from the Razorpay settlement report. Razorpay settles NET, not gross. */
export interface SettlementRow {
  settlement_id: string;
  payment_id: string;
  utr: string; // bank reference the payout lands under
  gross_paise: Paise;
  fee_paise: Paise;
  gst_paise: Paise; // GST charged on the fee
  refund_paise: Paise; // netted off this payout
  chargeback_paise: Paise; // debited from this payout
  net_paise: Paise; // what actually moves to the bank
  settled_at: string;
}

/** A credit line on the merchant's bank statement. One UTR can cover many payments. */
export interface BankRow {
  bank_txn_id: string;
  utr: string;
  credit_paise: Paise;
  value_date: string;
  narration: string;
}

export const EXCEPTION_CODES = [
  // Payment-grain: ledger vs settlement report
  "UNSETTLED_CAPTURE",
  "GROSS_MISMATCH",
  // UTR-grain: settlement report vs bank
  "FEE_GST_VARIANCE",
  "TIMING_T_PLUS_N",
  "PARTIAL_SETTLEMENT",
  "REFUND_NETTED",
  "CHARGEBACK_DEBIT",
  "DUPLICATE_UTR",
  "MISSING_IN_BANK",
  "MISSING_IN_LEDGER",
  "AMOUNT_MISMATCH_UNEXPLAINED",
] as const;

export type ExceptionCode = (typeof EXCEPTION_CODES)[number];

/** How a decision was reached — used to report cost and LLM dependence honestly. */
export type Tier = "T0_EXACT" | "T1_NETTING" | "T2_LLM";

export interface Decision {
  utr: string;
  matched: boolean;
  exception_code: ExceptionCode | null;
  tier: Tier;
  /** Signed difference: bank credit minus expected net. 0 on a clean match. */
  delta_paise: Paise;
  /**
   * Money actually at risk. Deliberately NOT |delta| — an off-contract fee
   * reconciles to the rupee against the bank (delta 0) while still bleeding the
   * overcharge every single settlement. Pricing exposure off delta would report
   * that as costless.
   */
  exposure_paise: Paise;
  reason: string;
  confidence: number; // 1 for deterministic tiers
  needs_human: boolean;
}

/**
 * Pass A decision — payment grain. Asks "did the books and the PG agree about this
 * payment at all", which is a different question from "did the payout arrive".
 */
export interface PaymentDecision {
  payment_id: string;
  matched: boolean;
  exception_code: ExceptionCode | null;
  exposure_paise: Paise;
  reason: string;
}

/** Ground truth emitted by the generator. This is what makes real precision/recall possible. */
export interface TruthRow {
  utr: string;
  should_match: boolean;
  exception_code: ExceptionCode | null;
}

export interface PaymentTruthRow {
  payment_id: string;
  should_match: boolean;
  exception_code: ExceptionCode | null;
}

export interface Dataset {
  ledger: LedgerRow[];
  settlements: SettlementRow[];
  bank: BankRow[];
  truth: TruthRow[];
  payment_truth: PaymentTruthRow[];
}
