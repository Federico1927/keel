/**
 * Multi-touch attribution. A touchpoint is a visit with a known source (UTM, click id, referrer)
 * before the purchase; today they come from the order's landing data plus the customer's earlier
 * visits recorded by the pixel (see `touchpoints`). Every model splits one unit of credit across
 * the touchpoints of one order; revenue and orders are then credited with those weights.
 */
export const ATTRIBUTION_MODELS = ["last_click", "first_click", "linear", "time_decay", "position_based", "last_platform_click"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export interface Touchpoint {
  at: Date;
  channel: string;
  campaignId: string | null;
  /** True when the touch is a paid ad click a platform would claim (Meta, Google). */
  paid: boolean;
}

export interface ModelOptions {
  /** Half-life in days for time decay (default 7). */
  halfLifeDays?: number;
  /** Share of credit to first and last touch in position-based (default 0.4 each). */
  positionEnds?: number;
  /** Touches older than this before the order are ignored (default 30 days). */
  lookbackDays?: number;
}

const DAY = 864e5;

/** Credit per touchpoint (same order as the sorted input), summing to 1; empty when no eligible touch. */
export function attributionWeights(model: AttributionModel, touches: readonly Touchpoint[], orderAt: Date, opts: ModelOptions = {}): { touch: Touchpoint; weight: number }[] {
  const lookback = (opts.lookbackDays ?? 30) * DAY;
  const eligible = [...touches].filter((t) => t.at.getTime() <= orderAt.getTime() && orderAt.getTime() - t.at.getTime() <= lookback).sort((a, b) => a.at.getTime() - b.at.getTime());
  const n = eligible.length;
  if (!n) return [];
  const only = (i: number) => eligible.map((touch, j) => ({ touch, weight: j === i ? 1 : 0 }));
  switch (model) {
    case "last_click":
      return only(n - 1);
    case "first_click":
      return only(0);
    case "linear":
      return eligible.map((touch) => ({ touch, weight: 1 / n }));
    case "time_decay": {
      const half = (opts.halfLifeDays ?? 7) * DAY;
      const raw = eligible.map((t) => Math.pow(0.5, (orderAt.getTime() - t.at.getTime()) / half));
      const sum = raw.reduce((s, v) => s + v, 0);
      return eligible.map((touch, i) => ({ touch, weight: raw[i]! / sum }));
    }
    case "position_based": {
      if (n === 1) return only(0);
      const ends = opts.positionEnds ?? 0.4;
      if (n === 2) return eligible.map((touch) => ({ touch, weight: 0.5 }));
      const middle = (1 - 2 * ends) / (n - 2);
      return eligible.map((touch, i) => ({ touch, weight: i === 0 || i === n - 1 ? ends : middle }));
    }
    case "last_platform_click": {
      // what an ad platform claims: the last paid click wins the whole order, even if a later organic visit closed it
      for (let i = n - 1; i >= 0; i--) if (eligible[i]!.paid) return only(i);
      return [];
    }
  }
}

export interface AttributedOrder {
  orderId: string;
  at: Date;
  netMinor: number;
  marginMinor: number;
  touches: Touchpoint[];
}

export interface CreditRow {
  key: string;
  orders: number;
  netMinor: number;
  marginMinor: number;
}

/** Credited orders, revenue and margin per channel or campaign under a model. Fractional orders are kept to 2 decimals. */
export function creditBy(model: AttributionModel, orders: readonly AttributedOrder[], keyOf: (t: Touchpoint) => string | null, opts: ModelOptions = {}): CreditRow[] {
  const acc = new Map<string, CreditRow>();
  for (const o of orders) {
    for (const { touch, weight } of attributionWeights(model, o.touches, o.at, opts)) {
      if (!weight) continue;
      const key = keyOf(touch);
      if (key === null) continue;
      const row = acc.get(key) ?? { key, orders: 0, netMinor: 0, marginMinor: 0 };
      row.orders += weight;
      row.netMinor += weight * o.netMinor;
      row.marginMinor += weight * o.marginMinor;
      acc.set(key, row);
    }
  }
  return [...acc.values()].map((r) => ({ key: r.key, orders: Math.round(r.orders * 100) / 100, netMinor: Math.round(r.netMinor), marginMinor: Math.round(r.marginMinor) })).sort((a, b) => b.netMinor - a.netMinor);
}
