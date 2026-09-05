// Synthetic three-source dataset with ground truth.
//
// Owning the generator is the whole point: because we know which UTRs are
// genuinely broken, we can report real precision/recall instead of a match
// rate that nobody can check.

import { writeFileSync } from "node:fs";
import type {
  BankRow,
  PaymentTruthRow,
  Dataset,
  ExceptionCode,
  LedgerRow,
  Paise,
  SettlementRow,
  TruthRow,
} from "./types.ts";

const FEE_BPS = 200; // 2.00% Razorpay standard flat rate
const GST_BPS = 1800; // 18% GST charged on the fee

/** mulberry32 — seeded so every run of the benchmark is byte-identical. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bps = (amount: Paise, rate: number): Paise =>
  Math.round((amount * rate) / 10000);

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

/** Anomaly mix. Weights are deliberate: most real reconciliation is clean. */
const MIX: Array<[ExceptionCode | null, number]> = [
  [null, 0.55],
  ["REFUND_NETTED", 0.09],
  ["TIMING_T_PLUS_N", 0.07],
  ["CHARGEBACK_DEBIT", 0.05],
  ["FEE_GST_VARIANCE", 0.06],
  ["PARTIAL_SETTLEMENT", 0.05],
  ["MISSING_IN_BANK", 0.04],
  ["MISSING_IN_LEDGER", 0.04],
  ["DUPLICATE_UTR", 0.02],
  ["AMOUNT_MISMATCH_UNEXPLAINED", 0.03],
];

/** Codes that still reconcile once explained — the engine must match, not escalate. */
const EXPLAINABLE = new Set<ExceptionCode>([
  "REFUND_NETTED",
  "TIMING_T_PLUS_N",
  "CHARGEBACK_DEBIT",
]);

function pick(r: number): ExceptionCode | null {
  let acc = 0;
  for (const [code, w] of MIX) {
    acc += w;
    if (r < acc) return code;
  }
  return null;
}

export function generate(utrCount = 220, seed = 42): Dataset {
  const rand = rng(seed);
  const ledger: LedgerRow[] = [];
  const settlements: SettlementRow[] = [];
  const bank: BankRow[] = [];
  const truth: TruthRow[] = [];
  const payment_truth: PaymentTruthRow[] = [];

  for (let u = 0; u < utrCount; u++) {
    const utr = `UTR${String(700000 + u)}`;
    const code = pick(rand());
    const settledAt = addDays("2026-08-01", Math.floor(rand() * 28));
    const nPayments = 1 + Math.floor(rand() * 3);

    // Payment-grain anomalies are injected only into UTRs that are clean at the
    // payout grain. Keeping the two passes disjoint means each is measured on its
    // own, rather than one pass's noise masking the other's failures.
    const r = rand();
    const payCode: ExceptionCode | null =
      code !== null
        ? null
        : r < 0.1
          ? "GROSS_MISMATCH"
          : r < 0.2
            ? "UNSETTLED_CAPTURE"
            : null;

    let expectedNet: Paise = 0;

    for (let p = 0; p < nPayments; p++) {
      const gross: Paise = (50000 + Math.floor(rand() * 900000)) * 1; // ₹500–₹9,500
      const payment_id = `pay_${u}_${p}`;

      let fee = bps(gross, FEE_BPS);
      if (code === "FEE_GST_VARIANCE" && p === 0) {
        fee += 700 + Math.floor(rand() * 2500); // off-contract fee, silently overcharged
      }
      const gst = bps(fee, GST_BPS);

      const refund: Paise =
        code === "REFUND_NETTED" && p === 0 ? Math.floor(gross / 2) : 0;
      const chargeback: Paise =
        code === "CHARGEBACK_DEBIT" && p === 0 ? Math.floor(gross / 3) : 0;

      const net = gross - fee - gst - refund - chargeback;
      expectedNet += net;

      // The books disagree with the PG about what was charged. The settlement report
      // keeps the true figure, so the payout still reconciles — only Pass A sees this.
      const ledgerGross =
        payCode === "GROSS_MISMATCH" && p === 0
          ? gross + 1100 + Math.floor(rand() * 4000)
          : gross;

      ledger.push({
        order_id: `order_${u}_${p}`,
        payment_id,
        gross_paise: ledgerGross,
        captured_at: addDays(settledAt, -2),
        status: chargeback > 0 ? "disputed" : refund > 0 ? "refunded" : "captured",
        refund_paise: refund,
      });
      payment_truth.push({
        payment_id,
        should_match: ledgerGross === gross,
        exception_code: ledgerGross === gross ? null : "GROSS_MISMATCH",
      });

      settlements.push({
        settlement_id: `setl_${u}`,
        payment_id,
        utr,
        gross_paise: gross,
        fee_paise: fee,
        gst_paise: gst,
        refund_paise: refund,
        chargeback_paise: chargeback,
        net_paise: net,
        settled_at: settledAt,
      });
    }

    // Money captured in the merchant's books that never reached any settlement.
    // Nothing on the settlement or bank side changes, so this is invisible to Pass B —
    // which is exactly why a two-source reconciliation would never surface it.
    if (payCode === "UNSETTLED_CAPTURE") {
      const orphan = `pay_${u}_orphan`;
      ledger.push({
        order_id: `order_${u}_orphan`,
        payment_id: orphan,
        gross_paise: 50000 + Math.floor(rand() * 400000),
        captured_at: addDays(settledAt, -2),
        status: "captured",
        refund_paise: 0,
      });
      payment_truth.push({
        payment_id: orphan,
        should_match: false,
        exception_code: "UNSETTLED_CAPTURE",
      });
    }

    // MISSING_IN_LEDGER: a bank credit backed by nothing on either book — money in
    // that the merchant cannot attribute. Drop both the ledger and settlement rows;
    // keep the bank credit.
    if (code === "MISSING_IN_LEDGER") {
      for (let i = settlements.length - 1; i >= 0; i--) {
        if (settlements[i]!.utr === utr) settlements.splice(i, 1);
      }
      for (let i = ledger.length - 1; i >= 0; i--) {
        if (ledger[i]!.payment_id.startsWith(`pay_${u}_`)) ledger.splice(i, 1);
      }
      for (let i = payment_truth.length - 1; i >= 0; i--) {
        if (payment_truth[i]!.payment_id.startsWith(`pay_${u}_`))
          payment_truth.splice(i, 1);
      }
    }

    let credit: Paise = expectedNet;
    let valueDate = addDays(settledAt, 2); // T+2 is the normal cycle

    if (code === "PARTIAL_SETTLEMENT") credit = Math.floor(expectedNet * 0.6);
    if (code === "TIMING_T_PLUS_N") valueDate = addDays(settledAt, 9);
    if (code === "AMOUNT_MISMATCH_UNEXPLAINED")
      credit = expectedNet - (1500 + Math.floor(rand() * 9000));

    if (code !== "MISSING_IN_BANK") {
      bank.push({
        bank_txn_id: `btx_${u}`,
        utr,
        credit_paise: credit,
        value_date: valueDate,
        narration: `RAZORPAY SETTLEMENT ${utr}`,
      });
      // A duplicate credit line — the classic double-posting the bank never fixes.
      if (code === "DUPLICATE_UTR") {
        bank.push({
          bank_txn_id: `btx_${u}_dup`,
          utr,
          credit_paise: credit,
          value_date: valueDate,
          narration: `RAZORPAY SETTLEMENT ${utr}`,
        });
      }
    }

    truth.push({
      utr,
      should_match: code === null || EXPLAINABLE.has(code),
      exception_code: code,
    });
  }

  return { ledger, settlements, bank, truth, payment_truth };
}

const toCsv = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => String(r[c])).join(",")),
  ].join("\n");
};

if (import.meta.filename === process.argv[1]) {
  const d = generate();
  writeFileSync("data/ledger.csv", toCsv(d.ledger as never));
  writeFileSync("data/settlements.csv", toCsv(d.settlements as never));
  writeFileSync("data/bank.csv", toCsv(d.bank as never));
  writeFileSync("data/truth.json", JSON.stringify(d.truth, null, 2));
  writeFileSync("data/payment-truth.json", JSON.stringify(d.payment_truth, null, 2));
  console.log(
    `generated: ${d.ledger.length} ledger · ${d.settlements.length} settlement · ${d.bank.length} bank · ${d.truth.length} UTRs`,
  );
}
