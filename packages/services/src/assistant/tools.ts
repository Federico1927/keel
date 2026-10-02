import { z } from "zod";
import type { TenantRole } from "@keel/config";
import { assistantPeriod, type CitationFigure, type CitationRow } from "@keel/core";
import { kpisForPeriod, pnlForPeriod, productPerformance } from "../analytics";
import { campaignsWithEconomics } from "../campaigns";
import { returnsAnalytics } from "../returns";
import { predictionOverview } from "../crm/predictions";
import { replenishmentPlan } from "../planning";
import { majorUnits, queryString, roundTo, toolAllowed, toolInputSchema, type KeelTool, type ToolResult, type ToolRuntime } from "../tools";

/**
 * Read-only analytics tools of the AI assistant, on the shared tool layer (`../tools`): the remote
 * MCP server offers the same tools. Each one wraps an existing analytics service, is reachable only
 * when the user's role can see the page it reads and the page's module is on, and returns two
 * things: compact data for the model (amounts in major units of the store currency) and a citation
 * for the user (figures, period, filters and the page they come from).
 */

export type AssistantToolRuntime = ToolRuntime;
export type AssistantToolResult = ToolResult;
export type AssistantTool<S extends z.ZodType = z.ZodType> = KeelTool<S>;

const major = majorUnits;
const round = roundTo;
const qs = queryString;
const readTool = { scope: "read", effect: "read" } as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD, inclusive");
const periodInput = { from: day.optional().describe("First day, inclusive (YYYY-MM-DD). Defaults to 29 days before `to`."), to: day.optional().describe("Last day, inclusive (YYYY-MM-DD). Defaults to today.") };
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback).describe(`How many rows, 1 to ${max}`);

function periodOf(rt: AssistantToolRuntime, input: { from?: string; to?: string }) {
  const p = assistantPeriod(input, rt.today);
  return { period: { from: p.from, to: p.to }, cite: { from: p.fromDay, to: p.toDay } };
}

const getKpis: AssistantTool<z.ZodObject<typeof periodInput>> = {
  name: "get_kpis",
  ...readTool,
  page: "analytics",
  description: "Sales KPIs for a period, each with its change against the previous period of the same length: net revenue (after tax and refunds), orders, average order value, contribution margin, cancellation rate, return rate, new and returning customers. Use it for questions on how sales or the business went.",
  input: z.object(periodInput),
  async run(rt, input) {
    const { period, cite } = periodOf(rt, input);
    const k = await kpisForPeriod(rt.ctx, rt.tenant, period);
    const c = k.current;
    const cur = rt.tenant.currency;
    const figures: CitationFigure[] = [
      { key: "net_revenue", value: c.netRevenueMinor, format: "money", change: k.changes.netRevenue },
      { key: "orders", value: c.orders, format: "number", change: k.changes.orders },
      { key: "aov", value: c.aovMinor, format: "money", change: k.changes.aov },
      { key: "contribution", value: c.contributionMinor, format: "money", change: k.changes.contribution },
      { key: "cancel_rate", value: k.cancelRate, format: "percent" },
      { key: "return_rate", value: k.returnRate, format: "percent" },
      { key: "new_customers", value: k.newCustomers, format: "number" },
      { key: "returning_customers", value: k.returningCustomers, format: "number" },
    ];
    return {
      data: {
        period: cite,
        previousPeriod: { from: k.previous.from.toISOString().slice(0, 10), to: new Date(k.previous.to.getTime() - 1).toISOString().slice(0, 10) },
        currency: cur,
        netRevenue: major(c.netRevenueMinor, cur),
        orders: c.orders,
        averageOrderValue: major(c.aovMinor, cur),
        contributionMargin: major(c.contributionMinor, cur),
        cancelRate: round(k.cancelRate),
        returnRate: round(k.returnRate),
        newCustomers: k.newCustomers,
        returningCustomers: k.returningCustomers,
        changeVsPrevious: Object.fromEntries(Object.entries(k.changes).map(([key, v]) => [key, round(v)])),
        previous: { netRevenue: major(k.before.netRevenueMinor, cur), orders: k.before.orders },
      },
      citation: { tool: "get_kpis", period: cite, filters: {}, figures, rows: [], href: `/t/${rt.slug}/analytics?${qs({ tab: "overview", from: cite.from, to: cite.to })}` },
    };
  },
};

const getPnl: AssistantTool<z.ZodObject<typeof periodInput>> = {
  name: "get_profit_and_loss",
  ...readTool,
  page: "analytics",
  description: "Profit and loss for a period, counting only orders that were not cancelled or returned: gross revenue, tax, net revenue, cost of goods, gross margin, shipping, payment fees, return costs, contribution margin, ad spend, fixed costs and operating profit. Use it for questions on profit, margin or costs.",
  input: z.object(periodInput),
  async run(rt, input) {
    const { period, cite } = periodOf(rt, input);
    const p = await pnlForPeriod(rt.ctx, rt.tenant, period);
    const cur = rt.tenant.currency;
    const lines: [string, number][] = [
      ["gross_revenue", p.grossRevenueMinor],
      ["tax", p.taxMinor],
      ["net_revenue", p.netRevenueMinor],
      ["cogs", p.cogsMinor],
      ["gross_margin", p.grossMarginMinor],
      ["shipping", p.shippingCostMinor],
      ["payment_fees", p.paymentFeeMinor],
      ["return_costs", p.returnCostsMinor],
      ["contribution", p.contributionMinor],
      ["ad_spend", p.adSpendMinor],
      ["fixed_costs", p.fixedCostsMinor],
      ["operating_profit", p.operatingProfitMinor],
    ];
    return {
      data: {
        period: cite,
        currency: cur,
        ordersCounted: p.orders,
        ordersPlaced: p.placedOrders,
        cancelledOrders: p.cancelledOrders,
        returnedOrders: p.returnedOrders,
        ordersWithoutProductCost: p.cogsIncompleteOrders,
        revenueShareWithKnownProductCost: round(p.costCoverage.coveredShare),
        ...Object.fromEntries(lines.map(([k, v]) => [k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()), major(v, cur)])),
        grossMarginRate: round(p.grossMarginRate),
        contributionRate: round(p.contributionRate),
        costSources: p.costSources,
      },
      citation: { tool: "get_profit_and_loss", period: cite, filters: {}, figures: [...lines.map(([key, v]): CitationFigure => ({ key, value: v, format: "money" })), { key: "contribution_rate", value: p.contributionRate, format: "percent" }], rows: [], href: `/t/${rt.slug}/analytics?${qs({ tab: "pnl", from: cite.from, to: cite.to })}` },
    };
  },
};

const productsInput = z.object({ ...periodInput, sort: z.enum(["revenue", "units", "margin", "return_rate"]).default("revenue").describe("Ranking"), limit: limit(20, 10) });
const getTopProducts: AssistantTool<typeof productsInput> = {
  name: "get_top_products",
  ...readTool,
  page: "analytics",
  description: "Products ranked over a period by revenue, units sold, gross margin or return rate, with units, orders, revenue, margin and returned units each. Use it for best or worst sellers, or which products earn or lose the most.",
  input: productsInput,
  async run(rt, input) {
    const { period, cite } = periodOf(rt, input);
    const all = await productPerformance(rt.ctx, period, 500);
    const rate = (r: (typeof all)[number]) => (r.units ? r.returnedUnits / r.units : 0);
    const key = { revenue: (r: (typeof all)[number]) => r.grossRevenueMinor, units: (r: (typeof all)[number]) => r.units, margin: (r: (typeof all)[number]) => r.marginMinor, return_rate: rate }[input.sort];
    const rows = [...all].filter((r) => input.sort !== "return_rate" || r.units >= 5).sort((a, b) => key(b) - key(a)).slice(0, input.limit);
    const cur = rt.tenant.currency;
    return {
      data: { period: cite, currency: cur, sort: input.sort, productsWithSales: all.length, products: rows.map((r) => ({ title: r.title, units: r.units, orders: r.orders, revenue: major(r.grossRevenueMinor, cur), grossMargin: major(r.marginMinor, cur), returnedUnits: r.returnedUnits, returnRate: round(rate(r)) })) },
      citation: {
        tool: "get_top_products",
        period: cite,
        filters: { sort: input.sort },
        figures: [{ key: "products_with_sales", value: all.length, format: "number" }],
        rows: rows.map((r): CitationRow => ({ label: r.title, href: `/t/${rt.slug}/products/${r.productId}`, figures: [{ key: "units", value: r.units, format: "number" }, { key: "revenue", value: r.grossRevenueMinor, format: "money" }, { key: "gross_margin", value: r.marginMinor, format: "money" }, { key: "return_rate", value: rate(r), format: "percent" }] })),
        href: `/t/${rt.slug}/analytics?${qs({ tab: "products", from: cite.from, to: cite.to })}`,
      },
    };
  },
};

const campaignsInput = z.object({ ...periodInput, platform: z.enum(["meta", "google"]).optional().describe("Only one ad platform"), sort: z.enum(["profit", "loss", "spend", "roas"]).default("spend").describe("Ranking: profit = most profitable first, loss = least profitable first"), limit: limit(25, 10) });
const getCampaigns: AssistantTool<typeof campaignsInput> = {
  name: "get_campaigns",
  ...readTool,
  page: "campaigns",
  description: "Ad campaigns (Meta, Google) over a period with spend, attributed orders and revenue, profit after product costs (only orders not cancelled or returned), ROAS, the suggested action (ok, pause, resume, consider_pause, consider_resume, pause_stock = pause because the products are running out, consider_stock) with its reason, and the stock of the linked products. Use it for questions on ads, ROAS, which campaigns lose money or what to pause.",
  input: campaignsInput,
  async run(rt, input) {
    const { period, cite } = periodOf(rt, input);
    const all = await campaignsWithEconomics(rt.ctx, rt.tenant, period, { platform: input.platform });
    const withSpend = all.filter((c) => c.metrics.spendMinor > 0 || c.metrics.attributedOrders > 0);
    const key = { profit: (c: (typeof all)[number]) => c.metrics.profitMinor, loss: (c: (typeof all)[number]) => -c.metrics.profitMinor, spend: (c: (typeof all)[number]) => c.metrics.spendMinor, roas: (c: (typeof all)[number]) => c.metrics.roas ?? -1 }[input.sort];
    const rows = [...withSpend].sort((a, b) => key(b) - key(a)).slice(0, input.limit);
    const cur = rt.tenant.currency;
    const spend = withSpend.reduce((s, c) => s + c.metrics.spendMinor, 0);
    const profit = withSpend.reduce((s, c) => s + c.metrics.profitMinor, 0);
    const losing = withSpend.filter((c) => c.metrics.profitMinor < 0).length;
    return {
      data: {
        period: cite,
        currency: cur,
        platform: input.platform ?? "all",
        campaignsWithActivity: withSpend.length,
        totalSpend: major(spend, cur),
        totalProfit: major(profit, cur),
        losingCampaigns: losing,
        campaigns: rows.map((c) => ({ name: c.name, platform: c.platform, status: c.status, spend: major(c.metrics.spendMinor, cur), attributedOrders: c.metrics.attributedOrders, revenue: major(c.metrics.netRevenueMinor, cur), profit: major(c.metrics.profitMinor, cur), roas: round(c.metrics.roas, 2), suggestedAction: c.action, reason: c.reason, linkedProductsStock: c.stock, stockRisk: c.stockRisk })),
      },
      citation: {
        tool: "get_campaigns",
        period: cite,
        filters: { ...(input.platform ? { platform: input.platform } : {}), sort: input.sort },
        figures: [{ key: "ad_spend", value: spend, format: "money" }, { key: "campaign_profit", value: profit, format: "money" }, { key: "losing_campaigns", value: losing, format: "number" }],
        rows: rows.map((c): CitationRow => ({ label: c.name, href: `/t/${rt.slug}/campaigns/${c.id}?${qs({ from: cite.from, to: cite.to })}`, figures: [{ key: "ad_spend", value: c.metrics.spendMinor, format: "money" }, { key: "campaign_profit", value: c.metrics.profitMinor, format: "money" }, { key: "roas", value: c.metrics.roas, format: "ratio" }, { key: "action", value: c.action, format: "text" }] })),
        href: `/t/${rt.slug}/campaigns?${qs({ from: cite.from, to: cite.to, platform: input.platform })}`,
      },
    };
  },
};

const getReturns: AssistantTool<z.ZodObject<typeof periodInput>> = {
  name: "get_returns_summary",
  ...readTool,
  page: "returns",
  description: "Returns requested in a period: count, return rate on orders, amount refunded, value kept through exchanges and store credit, the reasons and the products with the highest return rate. Use it for questions on returns, refunds or why customers send items back.",
  input: z.object(periodInput),
  async run(rt, input) {
    const { period, cite } = periodOf(rt, input);
    const r = await returnsAnalytics(rt.ctx, period, { labelMinor: rt.tenant.settings.returnLabelCostMinor, handlingMinor: rt.tenant.settings.returnHandlingCostMinor });
    const cur = rt.tenant.currency;
    const products = r.byProduct.filter((p) => p.soldQty >= 5).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)).slice(0, 5);
    return {
      data: { period: cite, currency: cur, returns: r.total, returnRate: round(r.returnRate), refunded: major(r.refundedMinor, cur), keptThroughExchangeOrCredit: major(r.keptMinor, cur), reasons: r.byReason.slice(0, 6).map((x) => ({ reason: x.label, count: x.count, share: round(x.share) })), byFault: r.byFault.map((x) => ({ fault: x.fault, count: x.count })), productsWithHighestReturnRate: products.map((p) => ({ title: p.title, returned: p.returnedQty, sold: p.soldQty, rate: round(p.rate) })) },
      citation: {
        tool: "get_returns_summary",
        period: cite,
        filters: {},
        figures: [{ key: "returns", value: r.total, format: "number" }, { key: "return_rate", value: r.returnRate, format: "percent" }, { key: "refunded", value: r.refundedMinor, format: "money" }, { key: "kept", value: r.keptMinor, format: "money" }],
        rows: r.byReason.slice(0, 5).map((x): CitationRow => ({ label: x.label, figures: [{ key: "returns", value: x.count, format: "number" }, { key: "share", value: x.share, format: "percent" }] })),
        href: `/t/${rt.slug}/returns/analytics?${qs({ from: cite.from, to: cite.to })}`,
      },
    };
  },
};

const predictionsInput = z.object({ list: z.enum(["slipping", "due_soon", "top"]).default("slipping").describe("slipping = valuable customers at risk of churning; due_soon = expected to order within 14 days; top = highest predicted value next year"), limit: limit(15, 5) });
const getPredictions: AssistantTool<typeof predictionsInput> = {
  name: "get_customer_predictions",
  ...readTool,
  piiNameKeys: ["name"],
  page: "customers",
  description: "Customer predictions from the purchase model (refreshed nightly): customers by churn risk, orders and value expected over the next year, and a list of customers — valuable ones at risk, those due to order soon, or those with the highest predicted value. Use it for churn, retention or who to contact.",
  input: predictionsInput,
  async run(rt, input) {
    const o = await predictionOverview(rt.ctx, input.limit);
    const cur = rt.tenant.currency;
    const list = { slipping: o.slipping, due_soon: o.dueSoon, top: o.top }[input.list].slice(0, input.limit);
    const risk = (k: string) => o.byRisk.find((b) => b.risk === k)?.customers ?? 0;
    return {
      data: {
        modelAvailable: !!o.model,
        modelFittedAt: o.model?.fittedAt ?? null,
        currency: cur,
        customersByChurnRisk: Object.fromEntries(o.byRisk.map((b) => [b.risk, b.customers])),
        expectedOrdersNext90Days: Math.round(o.expectedOrders90),
        predictedValueNext365Days: major(o.predictedValue365Minor, cur),
        list: input.list,
        customers: list.map((c) => ({ name: c.name, orders: c.ordersCount, totalSpent: major(c.totalSpentMinor, cur), lastOrderAt: c.lastOrderAt?.toISOString().slice(0, 10) ?? null, probabilityActive: round(c.pAlive, 3), churnRisk: c.churnRisk, predictedValue365: major(c.predictedValue365Minor, cur) })),
      },
      citation: {
        tool: "get_customer_predictions",
        period: null,
        filters: { list: input.list },
        figures: [{ key: "churn_high", value: risk("high"), format: "number" }, { key: "churn_medium", value: risk("medium"), format: "number" }, { key: "churn_low", value: risk("low"), format: "number" }, { key: "predicted_value_365", value: o.predictedValue365Minor, format: "money" }],
        rows: list.map((c): CitationRow => ({ label: c.name, href: `/t/${rt.slug}/customers/${c.customerId}`, figures: [{ key: "total_spent", value: c.totalSpentMinor, format: "money" }, { key: "p_alive", value: c.pAlive, format: "percent" }, { key: "predicted_value_365", value: c.predictedValue365Minor, format: "money" }] })),
        href: `/t/${rt.slug}/customers/predictions`,
      },
    };
  },
};

const stockInput = z.object({ limit: limit(25, 10) });
const getStockRisk: AssistantTool<typeof stockInput> = {
  name: "get_stock_risk",
  ...readTool,
  page: "inventory",
  description: "Variants that should be reordered now, soonest stock-out first: units available and incoming, days of cover at the current sales pace, expected stock-out date, suggested reorder quantity and supplier. Use it for stock, stock-outs or what to reorder.",
  input: stockInput,
  async run(rt, input) {
    const plan = await replenishmentPlan(rt.ctx, rt.tenant, { onlyToOrder: true });
    const rows = [...plan].sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity)).slice(0, input.limit);
    const cost = plan.reduce((s, r) => s + (r.costMinor ?? 0), 0);
    const cur = rt.tenant.currency;
    return {
      data: { currency: cur, variantsToReorder: plan.length, reorderCost: major(cost, cur), variants: rows.map((r) => ({ variant: r.label, sku: r.sku, available: r.available, incoming: r.incoming, backordered: r.backordered, daysOfCover: r.daysOfCover === null ? null : Math.round(r.daysOfCover), stockoutDate: r.stockoutDate, suggestedQuantity: r.quantity, supplier: r.supplierName, leadTimeDays: r.leadTimeDays })) },
      citation: {
        tool: "get_stock_risk",
        period: null,
        filters: {},
        figures: [{ key: "variants_to_reorder", value: plan.length, format: "number" }, { key: "reorder_cost", value: cost, format: "money" }],
        rows: rows.map((r): CitationRow => ({ label: r.label, href: `/t/${rt.slug}/products/${r.productId}`, figures: [{ key: "available", value: r.available, format: "number" }, { key: "days_of_cover", value: r.daysOfCover, format: "days" }, { key: "reorder_quantity", value: r.quantity, format: "number" }] })),
        href: `/t/${rt.slug}/inventory/planning`,
      },
    };
  },
};

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [getKpis, getPnl, getTopProducts, getCampaigns, getReturns, getPredictions, getStockRisk] as unknown as AssistantTool[];

/** The tools a user may call: their role must see the page the tool reads, and the page's module must be on. */
export function assistantToolsFor(role: TenantRole, activeAddons: readonly string[]): AssistantTool[] {
  return ASSISTANT_TOOLS.filter((t) => toolAllowed(t, { role, activeAddons }));
}

export function toolDefinition(t: AssistantTool): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return { name: t.name, description: t.description, inputSchema: toolInputSchema(t) };
}
