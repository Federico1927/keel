import { paymentMethodBreakdown, taxReport, type MethodBreakdownRow, type Period, type TaxReportRow } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { orderEconomicsForPeriod, type AnalyticsTenant } from "../analytics";

export interface TaxReport {
  period: Period;
  rows: TaxReportRow[];
  totals: Omit<TaxReportRow, "country" | "rateBps">;
}

/**
 * Tax by country and rate for a period. Same economics rows as the P/L (sale scope, replaced orders
 * out, tax computed from the tenant rate when the platform reported none), so the tax column adds
 * up to the P/L tax line.
 */
export async function taxReportForPeriod(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<TaxReport> {
  const rows = await orderEconomicsForPeriod(ctx, tenant, period);
  const r = taxReport(rows.map((e) => ({ inScope: e.inScope, country: e.taxCountry, rateBps: e.taxRateBps, grossRevenueMinor: e.grossRevenueMinor, taxMinor: e.taxMinor, refundedMinor: e.refundedMinor })));
  return { period, ...r };
}

export interface PaymentMethodReport {
  period: Period;
  rows: MethodBreakdownRow[];
  /** Fees from payouts vs estimates over the whole period. */
  fees: { actualMinor: number; estimatedMinor: number; estimatedOrders: number };
}

/** Orders, revenue, cancel and return rates and fees per payment method: every method gets a row. */
export async function paymentMethodReport(ctx: ServiceContext, tenant: AnalyticsTenant, period: Period): Promise<PaymentMethodReport> {
  const rows = paymentMethodBreakdown(await orderEconomicsForPeriod(ctx, tenant, period));
  return { period, rows, fees: { actualMinor: rows.reduce((s, r) => s + r.actualFeesMinor, 0), estimatedMinor: rows.reduce((s, r) => s + r.estimatedFeesMinor, 0), estimatedOrders: rows.reduce((s, r) => s + r.estimatedFeeOrders, 0) } };
}
