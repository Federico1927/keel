import { NextResponse, type NextRequest } from "next/server";
import { PAYMENT_METHODS, UTM_DIMENSIONS, defaultGranularity, isGranularity, isUtmDimension, type UtmDimension } from "@hullwise/core";
import { ORDER_PNL_SORTS, PRODUCT_PROFIT_SORTS, orderPnlTable, paymentMethodReport, pnlBreakdown, productProfitTable, taxReportForPeriod, utmReport, type OrderPnlSort, type ProductProfitSort } from "@hullwise/services";
import { ForbiddenError, requirePage } from "@/server/tenant";
import { resolvePeriod } from "@/server/period";
import { analyticsTenant, csvCell, minorToDecimal as m, runAnalytics } from "@/server/analytics";
import { utmParam } from "@/server/queries/orders";

/** CSV exports of the analytics depth tables (per-order P/L, products, UTM, P/L by period): same guards, period and filters as the page, every row. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenant: string; kind: string }> }) {
  const { tenant, kind } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "analytics");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 404 });
    throw e;
  }
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const period = resolvePeriod(sp, ctx.tenant.timezone);
  const at = analyticsTenant(ctx);
  let header: string[];
  let rows: (string | number | null)[][];
  if (kind === "orders") {
    const sort = (ORDER_PNL_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as OrderPnlSort) : undefined;
    const t = await runAnalytics(ctx, (s) => orderPnlTable(s, at, period, { q: sp.q || undefined, payment: (PAYMENT_METHODS as readonly string[]).includes(sp.payment ?? "") ? sp.payment : undefined, channel: sp.channel || undefined, missingCost: sp.missingCost === "1", loss: sp.loss === "1", sort }, 1, 0));
    header = ["order", "placed_at", "status", "payment_method", "channel", "gross", "refunded", "tax", "net_revenue", "cogs", "cogs_complete", "shipping", "payment_fee_estimated", "margin", "return_costs", "contribution"];
    rows = t.rows.map((o) => [o.name, o.placedAt.toISOString(), o.status, o.paymentMethod, o.channel, m(o.grossRevenueMinor), m(o.refundedMinor), m(o.taxMinor), m(o.netRevenueMinor), m(o.cogsMinor), o.cogsComplete ? "yes" : "no", m(o.shippingCostMinor), m(o.paymentFeeMinor), m(o.marginMinor), m(o.returnCostMinor), m(o.contributionMinor)]);
    rows.push(["TOTAL", null, null, null, null, m(t.totals.grossRevenueMinor), m(t.totals.refundedMinor), m(t.totals.taxMinor), m(t.totals.netRevenueMinor), m(t.totals.cogsMinor), null, m(t.totals.shippingCostMinor), m(t.totals.paymentFeeMinor), null, m(t.totals.returnCostMinor), m(t.totals.contributionMinor)]);
  } else if (kind === "products") {
    const sort = (PRODUCT_PROFIT_SORTS as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as ProductProfitSort) : undefined;
    const t = await runAnalytics(ctx, (s) => productProfitTable(s, at, period, { q: sp.q || undefined, sort, pageSize: 0 }));
    const list = sp.action ? t.rows.filter((r) => r.action === sp.action) : t.rows;
    header = ["product", "units", "orders", "net_revenue", "cogs", "ad_spend", "gross_margin", "profit", "roas", "roi", "light", "available", "incoming", "cover_days", "action", "reorder_units"];
    rows = list.map((r) => [r.title, r.units, r.orders, m(r.netRevenueMinor), m(r.cogsMinor), m(r.adSpendMinor), m(r.grossMarginMinor), m(r.profitMinor), r.roas === null ? null : r.roas.toFixed(4), r.roi === null ? null : r.roi.toFixed(4), r.light, r.available, r.incoming, r.coverDays === null ? null : Math.round(r.coverDays), r.action, r.reorderUnits]);
    rows.push(["UNATTRIBUTED AD SPEND", null, null, null, null, m(t.unattributedMinor), null, m(-t.unattributedMinor), null, null, null, null, null, null, null, null]);
    rows.push(["TOTAL AD SPEND", null, null, null, null, m(t.adSpendMinor), null, null, null, null, null, null, null, null, null, null]);
  } else if (kind === "utm") {
    const dim: UtmDimension = isUtmDimension(sp.dim) ? sp.dim : "source";
    const filter: Partial<Record<UtmDimension, string>> = {};
    for (const d of UTM_DIMENSIONS) if (d !== dim && sp[utmParam(d)]) filter[d] = sp[utmParam(d)];
    const r = await runAnalytics(ctx, (s) => utmReport(s, at, period, dim, filter, "month"));
    header = [...Object.keys(filter).map((d) => `utm_${d}`), `utm_${dim}`, "orders", "gross_revenue", "net_revenue", "aov", "revenue_share"];
    rows = r.groups.map((g) => [...Object.values(filter), g.value, g.orders, m(g.grossRevenueMinor), m(g.netRevenueMinor), g.aovMinor === null ? null : m(g.aovMinor), g.revenueShare === null ? null : g.revenueShare.toFixed(4)]);
  } else if (kind === "pnl") {
    const g = isGranularity(sp.gran) ? sp.gran : defaultGranularity(period);
    const b = await runAnalytics(ctx, (s) => pnlBreakdown(s, at, period, g));
    header = ["bucket", "from", "to", "partial", "orders", "gross", "refunded", "tax", "net_revenue", "cogs", "shipping", "payment_fees", "return_costs", "contribution", "ad_spend", "fixed_costs", "operating_profit"];
    rows = b.buckets.map((x) => [x.bucket.key, x.bucket.from.toISOString(), x.bucket.to.toISOString(), x.bucket.partial ? "yes" : "no", x.orders, m(x.grossRevenueMinor), m(x.refundedMinor), m(x.taxMinor), m(x.netRevenueMinor), m(x.cogsMinor), m(x.shippingCostMinor), m(x.paymentFeeMinor), m(x.returnCostsMinor), m(x.contributionMinor), m(x.adSpendMinor), m(x.fixedCostsMinor), m(x.operatingProfitMinor)]);
    const p = b.pnl;
    rows.push(["TOTAL", period.from.toISOString(), period.to.toISOString(), null, p.orders, m(p.grossRevenueMinor), m(p.refundedMinor), m(p.taxMinor), m(p.netRevenueMinor), m(p.cogsMinor), m(p.shippingCostMinor), m(p.paymentFeeMinor), m(p.returnCostsMinor), m(p.contributionMinor), m(p.adSpendMinor), m(p.fixedCostsMinor), m(p.operatingProfitMinor)]);
  } else if (kind === "tax") {
    const r = await runAnalytics(ctx, (s) => taxReportForPeriod(s, at, period));
    header = ["country", "rate_percent", "orders", "gross", "taxable", "tax", "refunded_tax", "net_tax"];
    rows = r.rows.map((x) => [x.country, (x.rateBps / 100).toFixed(2), x.orders, m(x.grossMinor), m(x.taxableMinor), m(x.taxMinor), m(x.refundedTaxMinor), m(x.netTaxMinor)]);
    rows.push(["TOTAL", null, r.totals.orders, m(r.totals.grossMinor), m(r.totals.taxableMinor), m(r.totals.taxMinor), m(r.totals.refundedTaxMinor), m(r.totals.netTaxMinor)]);
  } else if (kind === "payment_methods") {
    const r = await runAnalytics(ctx, (s) => paymentMethodReport(s, at, period));
    header = ["method", "placed_orders", "orders", "gross", "net_revenue", "aov", "cancelled", "returned", "cancel_rate", "return_rate", "fees", "actual_fees", "estimated_fees", "estimated_fee_orders", "fee_rate"];
    rows = r.rows.map((x) => [x.method, x.placedOrders, x.orders, m(x.grossRevenueMinor), m(x.netRevenueMinor), x.aovMinor === null ? null : m(x.aovMinor), x.cancelledOrders, x.returnedOrders, x.cancelRate?.toFixed(4) ?? null, x.returnRate?.toFixed(4) ?? null, m(x.feesMinor), m(x.actualFeesMinor), m(x.estimatedFeesMinor), x.estimatedFeeOrders, x.feeRate?.toFixed(4) ?? null]);
  } else {
    return new NextResponse("not found", { status: 404 });
  }
  const body = [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
  const name = `${kind === "orders" ? "order-pnl" : kind === "products" ? "product-profit" : kind === "utm" ? "utm" : kind === "tax" ? "tax-report" : kind === "payment_methods" ? "payment-methods" : "pnl-periods"}-${period.from.toISOString().slice(0, 10)}-${new Date(period.to.getTime() - 1).toISOString().slice(0, 10)}.csv`;
  return new NextResponse(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
}
