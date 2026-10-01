import { normCdf, twoProportionTest, type TwoProportionResult } from "./segments";

/**
 * Customer campaigns measured against a control group. Every exposed customer is either
 * treated (messaged) or held out (never messaged), assigned before sending. Results are
 * intention-to-treat: a treated customer whose message failed still counts as treated, so the
 * comparison stays randomised. Outcomes are sale-scope orders placed within the attribution
 * window after the customer's exposure.
 */
export const RETENTION_CHANNELS = ["email", "sms", "whatsapp", "manual"] as const;
export type RetentionChannel = (typeof RETENTION_CHANNELS)[number];

export interface CustomerOutcome {
  orders: number;
  revenueMinor: number;
  marginMinor: number;
}

export interface GroupStats {
  customers: number;
  converters: number;
  conversionRate: number | null;
  orders: number;
  revenueMinor: number;
  marginMinor: number;
  revenuePerCustomerMinor: number | null;
  marginPerCustomerMinor: number | null;
}

export interface UpliftReport {
  treated: GroupStats;
  holdout: GroupStats;
  /** False when there is no control group: uplift cannot be measured. */
  measurable: boolean;
  conversion: TwoProportionResult | null;
  /** Difference in margin per customer (treated − control), with a 95% interval (Welch, normal approximation). */
  marginPerCustomerDiff: { diffMinor: number; ci95: [number, number] | null; pValue: number | null } | null;
  /** Scaled to the treated group: what the campaign added over doing nothing. */
  incrementalOrders: number | null;
  incrementalRevenueMinor: number | null;
  incrementalMarginMinor: number | null;
  incrementalMarginCi95: [number, number] | null;
  costMinor: number;
  /** Incremental margin minus the cost of sending. */
  netIncrementalMarginMinor: number | null;
  /** Net incremental margin per unit of cost; null without cost. */
  roi: number | null;
  /** Conversion difference significant at the 5% level. */
  significant: boolean;
}

function stats(group: readonly CustomerOutcome[]): GroupStats {
  const customers = group.length;
  let converters = 0;
  let orders = 0;
  let revenue = 0;
  let margin = 0;
  for (const g of group) {
    if (g.orders > 0) converters++;
    orders += g.orders;
    revenue += g.revenueMinor;
    margin += g.marginMinor;
  }
  return {
    customers,
    converters,
    conversionRate: customers ? converters / customers : null,
    orders,
    revenueMinor: revenue,
    marginMinor: margin,
    revenuePerCustomerMinor: customers ? revenue / customers : null,
    marginPerCustomerMinor: customers ? margin / customers : null,
  };
}

function meanVar(values: readonly number[]): { mean: number; variance: number } {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, variance };
}

export function campaignUplift(treated: readonly CustomerOutcome[], holdout: readonly CustomerOutcome[], costMinor = 0): UpliftReport {
  const t = stats(treated);
  const h = stats(holdout);
  const measurable = t.customers > 0 && h.customers > 0;
  if (!measurable) {
    return { treated: t, holdout: h, measurable, conversion: null, marginPerCustomerDiff: null, incrementalOrders: null, incrementalRevenueMinor: null, incrementalMarginMinor: null, incrementalMarginCi95: null, costMinor, netIncrementalMarginMinor: null, roi: null, significant: false };
  }
  const conversion = twoProportionTest(t.converters, t.customers, h.converters, h.customers);
  const mt = meanVar(treated.map((x) => x.marginMinor));
  const mh = meanVar(holdout.map((x) => x.marginMinor));
  const diff = mt.mean - mh.mean;
  const se = Math.sqrt(mt.variance / t.customers + mh.variance / h.customers);
  const ci: [number, number] | null = se > 0 ? [diff - 1.96 * se, diff + 1.96 * se] : null;
  const pValue = se > 0 ? 2 * (1 - normCdf(Math.abs(diff / se))) : null;
  const n = t.customers;
  const incrementalOrders = (t.orders / t.customers - h.orders / h.customers) * n;
  const incrementalRevenue = (t.revenuePerCustomerMinor! - h.revenuePerCustomerMinor!) * n;
  const incrementalMargin = diff * n;
  const net = incrementalMargin - costMinor;
  return {
    treated: t,
    holdout: h,
    measurable,
    conversion,
    marginPerCustomerDiff: { diffMinor: diff, ci95: ci, pValue },
    incrementalOrders,
    incrementalRevenueMinor: Math.round(incrementalRevenue),
    incrementalMarginMinor: Math.round(incrementalMargin),
    incrementalMarginCi95: ci ? [Math.round(ci[0] * n), Math.round(ci[1] * n)] : null,
    costMinor,
    netIncrementalMarginMinor: Math.round(net),
    roi: costMinor > 0 ? net / costMinor : null,
    significant: conversion.pValue !== null && conversion.pValue < 0.05,
  };
}

/**
 * Smallest absolute difference in conversion rate the test can detect with 80% power at the 5%
 * level, given the expected baseline rate and the two group sizes. Shown before sending so a
 * control group too small to tell anything is visible up front.
 */
export function minimumDetectableUplift(baselineRate: number, treated: number, holdout: number): number | null {
  if (treated <= 0 || holdout <= 0 || baselineRate <= 0 || baselineRate >= 1) return null;
  return (1.959964 + 0.841621) * Math.sqrt(baselineRate * (1 - baselineRate) * (1 / treated + 1 / holdout));
}

/** Message variables: `{first_name}` and `{code}` are replaced; unknown placeholders stay as typed. */
export function renderMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}
