import { and, eq, gte, inArray, isNull, lt, lte, schema, sql } from "@hullwise/db";
import { SALE_STATUSES, evaluateDataHealth, lastClosedMonth, monthKey, ordersOnDefaultShipping, type DataHealthInput, type DataHealthReport } from "@hullwise/core";
import type { ServiceContext } from "../context";
import type { AnalyticsTenant } from "../analytics";

/** Days of sale orders the order-based checks look at; campaign spend and order states use the shorter window. */
export const DATA_HEALTH_ORDER_DAYS = 90;
export const DATA_HEALTH_RECENT_DAYS = 30;
/** The store connection every other number depends on. */
const COMMERCE_PROVIDERS = ["shopify"];
const CONNECTED = ["connected", "syncing"];

/**
 * Data completeness (issue #99): what is missing for the numbers to be right, per tenant. A dozen
 * aggregate queries, each bounded by a date window or by small configuration tables; core decides
 * what counts as a gap, how serious it is and the fix link. Not filtered by role: callers pass the
 * report through `dataHealthForRole`.
 */
export async function dataHealthReport(ctx: ServiceContext, tenant: AnalyticsTenant, now: Date = ctx.now ?? new Date()): Promise<DataHealthReport> {
  const since = new Date(now.getTime() - DATA_HEALTH_ORDER_DAYS * 864e5);
  const recent = new Date(now.getTime() - DATA_HEALTH_RECENT_DAYS * 864e5);
  const closed = lastClosedMonth(now);
  const saleWindow = [eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, since), lt(schema.orders.placedAt, now), isNull(schema.orders.replacedByOrderId), inArray(schema.orders.status, [...SALE_STATUSES])];

  // sale orders of the window by payment method and destination: fees, taxes and the revenue denominators
  const byMethodCountry = await ctx.tx
    .select({
      method: schema.orders.paymentMethod,
      country: schema.orders.shippingCountry,
      orders: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${schema.orders.totalMinor} - ${schema.orders.refundedMinor}), 0)::bigint`,
      // correlated subqueries name the outer columns in full: drizzle leaves them unqualified in a one-table select
      // same rule as the P/L: the fee is the processor's once a charge of the order was imported from a payout
      estimated: sql<number>`count(*) filter (where not exists (select 1 from balance_transactions b where b.order_id = "orders"."id" and b.tenant_id = ${ctx.tenantId} and b.type = 'charge'))::int`,
    })
    .from(schema.orders)
    .where(and(...saleWindow))
    .groupBy(schema.orders.paymentMethod, schema.orders.shippingCountry);
  const totalOrders = byMethodCountry.reduce((s, r) => s + r.orders, 0);
  const totalRevenue = byMethodCountry.reduce((s, r) => s + Number(r.revenue), 0);

  // product lines of those orders: lines without a cost, variants without a supplier
  const [lines] = await ctx.tx
    .select({
      soldVariants: sql<number>`count(distinct ${schema.orderLines.variantId})::int`,
      lineRevenue: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity} * ${schema.orderLines.unitPriceMinor}), 0)::bigint`,
      noCostItems: sql<number>`count(distinct coalesce(${schema.orderLines.variantId}::text, 'line:' || ${schema.orderLines.title})) filter (where ${schema.orderLines.unitCostMinor} is null)::int`,
      noCostOrders: sql<number>`count(distinct ${schema.orderLines.orderId}) filter (where ${schema.orderLines.unitCostMinor} is null)::int`,
      noCostRevenue: sql<number>`coalesce(sum(${schema.orderLines.currentQuantity} * ${schema.orderLines.unitPriceMinor}) filter (where ${schema.orderLines.unitCostMinor} is null), 0)::bigint`,
      noSupplierVariants: sql<number>`count(distinct ${schema.orderLines.variantId}) filter (where not exists (select 1 from supplier_variants sv where sv.variant_id = "order_lines"."variant_id" and sv.tenant_id = ${ctx.tenantId}))::int`,
    })
    .from(schema.orderLines)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderLines.orderId))
    .where(and(eq(schema.orderLines.tenantId, ctx.tenantId), eq(schema.orderLines.isAncillary, false), sql`${schema.orderLines.currentQuantity} > 0`, ...saleWindow));

  // shipping: orders per UTC day (the P/L's per-order cost is looked up by that day), cost settings, carrier invoices
  const byDay = await ctx.tx
    .select({ day: sql<string>`to_char(${schema.orders.placedAt} at time zone 'UTC', 'YYYY-MM-DD')`, orders: sql<number>`count(*)::int` })
    .from(schema.orders)
    .where(and(...saleWindow))
    .groupBy(sql`1`);
  const costRows = await ctx.tx.select({ kind: schema.costSettings.kind, amountMinor: schema.costSettings.amountMinor, validFrom: schema.costSettings.validFrom, validTo: schema.costSettings.validTo }).from(schema.costSettings).where(eq(schema.costSettings.tenantId, ctx.tenantId));
  const periodRows = await ctx.tx.select({ period: schema.periodCosts.period, kind: schema.periodCosts.kind, actualMinor: schema.periodCosts.actualMinor }).from(schema.periodCosts).where(and(eq(schema.periodCosts.tenantId, ctx.tenantId), gte(schema.periodCosts.period, monthKey(since)), lte(schema.periodCosts.period, monthKey(now))));
  const [raw] = await ctx.tx.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  const rawSettings = (raw?.settings ?? {}) as Record<string, unknown>;

  const taxCountries = new Set((await ctx.tx.select({ country: schema.tenantTaxRates.country }).from(schema.tenantTaxRates).where(eq(schema.tenantTaxRates.tenantId, ctx.tenantId))).map((r) => r.country));

  const spendSince = recent.toISOString().slice(0, 10);
  const campaigns = await ctx.tx
    .select({ id: schema.adMetricsDaily.campaignId, spend: sql<number>`sum(${schema.adMetricsDaily.spendMinor})::bigint`, linked: sql<boolean>`exists (select 1 from campaign_product_links l where l.campaign_id = "ad_metrics_daily"."campaign_id" and l.tenant_id = ${ctx.tenantId})` })
    .from(schema.adMetricsDaily)
    .where(and(eq(schema.adMetricsDaily.tenantId, ctx.tenantId), gte(schema.adMetricsDaily.date, spendSince)))
    .groupBy(schema.adMetricsDaily.campaignId)
    .having(sql`sum(${schema.adMetricsDaily.spendMinor}) > 0`);

  const [states] = await ctx.tx
    .select({ orders: sql<number>`count(*)::int`, fallback: sql<number>`count(*) filter (where ${schema.orders.statusReason} = 'default')::int` })
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, ctx.tenantId), gte(schema.orders.placedAt, recent), lt(schema.orders.placedAt, now), isNull(schema.orders.replacedByOrderId)));

  const integrations = await ctx.tx.select({ provider: schema.integrations.provider, status: schema.integrations.status }).from(schema.integrations).where(eq(schema.integrations.tenantId, ctx.tenantId));
  const failingSources = await ctx.tx.select({ source: schema.integrationHealth.source }).from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenantId), eq(schema.integrationHealth.status, "error")));

  const [suppliers] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenantId));
  const returnCostsUnset = tenant.settings.returnLabelCostMinor === 0 && tenant.settings.returnHandlingCostMinor === 0;
  const [returns] = returnCostsUnset ? await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.returnRequests).where(and(eq(schema.returnRequests.tenantId, ctx.tenantId), gte(schema.returnRequests.receivedAt, since), lt(schema.returnRequests.receivedAt, now))) : [{ n: 0 }];

  /* ---------- measurements ---------- */
  const inputs: DataHealthInput[] = [];

  const commerce = integrations.filter((i) => COMMERCE_PROVIDERS.includes(i.provider));
  inputs.push({ id: "commerce_connection", count: commerce.some((i) => CONNECTED.includes(i.status)) ? 0 : 1, sample: 1, params: { providers: COMMERCE_PROVIDERS } });

  inputs.push({ id: "product_costs", count: lines?.noCostItems ?? 0, sample: lines?.soldVariants ?? 0, affectedOrders: lines?.noCostOrders ?? 0, totalOrders, affectedRevenueMinor: Number(lines?.noCostRevenue ?? 0), totalRevenueMinor: Number(lines?.lineRevenue ?? 0) });

  const byCountry = new Map<string, { orders: number; revenue: number }>();
  for (const r of byMethodCountry) {
    const c = r.country ?? tenant.country;
    const cur = byCountry.get(c) ?? { orders: 0, revenue: 0 };
    byCountry.set(c, { orders: cur.orders + r.orders, revenue: cur.revenue + Number(r.revenue) });
  }
  const missingTax = [...byCountry].filter(([c]) => !taxCountries.has(c)).sort((a, b) => b[1].orders - a[1].orders);
  inputs.push({ id: "tax_rates", count: missingTax.length, sample: byCountry.size, affectedOrders: missingTax.reduce((s, [, v]) => s + v.orders, 0), totalOrders, affectedRevenueMinor: missingTax.reduce((s, [, v]) => s + v.revenue, 0), totalRevenueMinor: totalRevenue, params: { countries: missingTax.map(([c]) => c), homeCountryMissing: missingTax.some(([c]) => c === tenant.country) ? 1 : 0 } });

  const monthsWithShippingActual = new Set(periodRows.filter((r) => r.kind === "shipping" && r.actualMinor !== null).map((r) => r.period));
  const onDefault = ordersOnDefaultShipping(byDay, costRows.filter((r) => r.kind === "shipping_per_order"), monthsWithShippingActual, rawSettings.shippingCostMinor !== undefined);
  inputs.push({ id: "shipping_costs", count: onDefault, sample: totalOrders, affectedOrders: onDefault, totalOrders });

  // the last closed month: no fixed cost at all (neither period lines nor the legacy flat amount), or figures still estimated
  const closedFixed = periodRows.filter((r) => r.period === closed && r.kind !== "shipping");
  const legacyClosed = costRows.filter((r) => r.kind === "fixed_monthly" && r.validFrom <= `${closed}-15` && (!r.validTo || r.validTo >= `${closed}-15`)).reduce((s, r) => s + r.amountMinor, 0);
  inputs.push({ id: "fixed_costs", count: closedFixed.length === 0 && legacyClosed === 0 ? 1 : 0, sample: 1, applicable: totalOrders > 0, params: { month: closed } });
  const estimatedFixed = closedFixed.filter((r) => r.actualMinor === null).length;
  // a shipping line without its invoice; a shop that never enters carrier invoices keeps the per-order estimate and is not flagged
  const estimatedShipping = periodRows.filter((r) => r.period === closed && r.kind === "shipping").length > 0 && !monthsWithShippingActual.has(closed) ? 1 : 0;
  inputs.push({ id: "cost_actuals", count: estimatedFixed + estimatedShipping, sample: closedFixed.length + (periodRows.some((r) => r.period === closed && r.kind === "shipping") ? 1 : 0), params: { month: closed, fixed: estimatedFixed, shipping: estimatedShipping } });

  const unlinked = campaigns.filter((c) => !c.linked);
  inputs.push({ id: "campaign_links", count: unlinked.length, sample: campaigns.length, affectedRevenueMinor: unlinked.reduce((s, c) => s + Number(c.spend), 0), totalRevenueMinor: campaigns.reduce((s, c) => s + Number(c.spend), 0), query: { preset: `${DATA_HEALTH_RECENT_DAYS}d` } });

  const failing = new Set([...integrations.filter((i) => i.status === "error" && !COMMERCE_PROVIDERS.includes(i.provider)).map((i) => i.provider), ...failingSources.map((s) => s.source.split(":")[0]!).filter((p) => !COMMERCE_PROVIDERS.includes(p))]);
  inputs.push({ id: "integration_errors", count: failing.size, sample: integrations.filter((i) => i.status !== "not_connected").length, params: { providers: [...failing].sort() } });

  // methods seen in the window, still on the estimate, with no fee configured: their fees count as zero
  const byMethod = new Map<string, { orders: number; estimated: number }>();
  for (const r of byMethodCountry) {
    const cur = byMethod.get(r.method) ?? { orders: 0, estimated: 0 };
    byMethod.set(r.method, { orders: cur.orders + r.orders, estimated: cur.estimated + r.estimated });
  }
  const feeOf = (m: string) => (tenant.settings.paymentFeeBps[m as keyof typeof tenant.settings.paymentFeeBps] ?? 0) + (tenant.settings.paymentFeeFixedMinor[m as keyof typeof tenant.settings.paymentFeeFixedMinor] ?? 0);
  const zeroFee = [...byMethod].filter(([m, v]) => v.estimated > 0 && feeOf(m) === 0).sort((a, b) => b[1].estimated - a[1].estimated);
  inputs.push({ id: "payment_fees", count: zeroFee.length, sample: byMethod.size, affectedOrders: zeroFee.reduce((s, [, v]) => s + v.estimated, 0), totalOrders, params: { methods: zeroFee.map(([m]) => m) } });

  inputs.push({ id: "state_rules", count: states?.fallback ?? 0, sample: states?.orders ?? 0, affectedOrders: states?.fallback ?? 0, totalOrders: states?.orders ?? 0, query: {} });

  inputs.push({ id: "return_costs", count: returns?.n ?? 0, sample: returns?.n ?? 0 });

  inputs.push({ id: "suppliers", count: lines?.noSupplierVariants ?? 0, sample: lines?.soldVariants ?? 0, applicable: (suppliers?.n ?? 0) > 0 });

  return evaluateDataHealth(inputs);
}
