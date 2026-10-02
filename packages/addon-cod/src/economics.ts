/**
 * Money view of a COD order before confirmation (C.14): what the recipient's refusals cost in the
 * past and what this order is worth in expectation, given the delivery score as a probability.
 */
export interface RiskEconomicsInput {
  /** Delivery score 0–100, read as the probability of delivery. */
  score: number | null;
  /** Contribution of the order if delivered (revenue net of tax less product cost); falls back to the total. */
  marginMinor: number | null;
  totalMinor: number;
  /** Cost of one refused parcel (outbound plus return). */
  refusalCostMinor: number;
  ordersTotal: number;
  ordersRefused: number;
  /** Carrier-billed cost of the past refusals when known; otherwise refusals × refusal cost. */
  knownWastedMinor?: number | null;
}

export function riskEconomics(i: RiskEconomicsInput): { refusedPct: number | null; wastedMinor: number; expectedValueMinor: number | null } {
  const refusedPct = i.ordersTotal > 0 ? Math.round((100 * i.ordersRefused) / i.ordersTotal) : null;
  const wastedMinor = i.knownWastedMinor ?? i.ordersRefused * i.refusalCostMinor;
  if (i.score === null) return { refusedPct, wastedMinor, expectedValueMinor: null };
  const p = Math.max(0, Math.min(100, i.score)) / 100;
  const gain = i.marginMinor ?? i.totalMinor;
  return { refusedPct, wastedMinor, expectedValueMinor: Math.round(p * gain - (1 - p) * i.refusalCostMinor) };
}

/** Bottleneck flag of the supervisor view: more open items than `factor` × the team average (and at least 3). */
export function isBottleneck(open: number, teamAverage: number, factor: number): boolean {
  return open >= 3 && open > teamAverage * factor;
}
