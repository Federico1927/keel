import { z } from "zod";
import { MCP_LIMITS } from "@hullwise/config";
import { hullwiseLink, localDate, majorUnits, roundTo, type HullwiseTool } from "../tools";
import { subscriptionsOverview } from "./analytics";
import { recoveryQueue, renewalStock } from "./operations";

/**
 * MCP tools of `addon.subscriptions` (#67), read-only. They carry `module: "addon.subscriptions"`:
 * the MCP server neither lists nor runs them for a tenant without the add-on.
 */
const common = { page: "subscriptions" as const, module: "addon.subscriptions" as const, scope: "read" as const, effect: "read" as const };

const overviewInput = z.object({ days: z.number().int().min(7).max(365).default(30).describe("Length of the period ending today, in days") });
const getOverview: HullwiseTool<typeof overviewInput> = {
  ...common,
  name: "get_subscriptions_overview",
  title: "Subscriptions: MRR, subscribers, churn, forecast",
  description: "The store's subscription business from its subscription app (Shopify Subscriptions, Recharge or Loop): MRR now and at the start of the period, active/paused/new/cancelled subscribers, churn split voluntary vs involuntary, renewal success rate, revenue forecast for 30/60/90 days and the failed-payment recovery state. Example: { \"days\": 30 }.",
  input: overviewInput,
  async run(rt, input) {
    const to = new Date(rt.today.getTime() + 864e5);
    const from = new Date(to.getTime() - input.days * 864e5);
    const o = await subscriptionsOverview(rt.ctx, rt.tenant, { period: { from, to }, months: 6, asOf: rt.today });
    const cur = rt.tenant.currency;
    return {
      data: {
        currency: cur,
        period: { from: localDate(from, rt.tenant.timezone), to: localDate(new Date(to.getTime() - 1), rt.tenant.timezone) },
        mrr: majorUnits(o.mrrMinor, cur),
        mrrAtStart: majorUnits(o.mrrPreviousMinor, cur),
        subscribers: { active: o.counts.active, paused: o.counts.paused, new: o.counts.new, cancelled: o.counts.cancelled, voluntaryChurn: o.counts.voluntary, involuntaryChurn: o.counts.involuntary, churnRate: roundTo(o.counts.churnRate) },
        renewalSuccessRate: roundTo(o.successRate),
        forecast: o.forecast.map((f) => ({ days: f.days, renewals: f.renewals, scheduled: majorUnits(f.scheduledMinor, cur), expected: majorUnits(f.expectedMinor, cur) })),
        recovery: { open: o.recovery.open, recoveryRate: roundTo(o.recovery.rate), valueAtRisk: majorUnits(o.recovery.valueAtRiskMinor, cur) },
        mrrMovementByMonth: o.movement.map((m) => ({ month: m.from.toISOString().slice(0, 7), new: majorUnits(m.newMinor, cur), expansion: majorUnits(m.expansionMinor, cur), contraction: majorUnits(m.contractionMinor, cur), churned: majorUnits(m.churnedMinor, cur), reactivated: majorUnits(m.reactivatedMinor, cur), end: majorUnits(m.endMrrMinor, cur) })),
        link: hullwiseLink(rt, "/subscriptions"),
      },
    };
  },
};

const recoveryInput = z.object({ limit: z.number().int().min(1).max(MCP_LIMITS.maxPageSize).default(20) });
const listRecovery: HullwiseTool<typeof recoveryInput> = {
  ...common,
  name: "list_subscription_recovery",
  title: "Subscriptions with a failing payment",
  piiNameKeys: ["customerName"],
  description: "Subscribers whose latest renewal charge failed, largest value at risk first: decline reason (card expired, insufficient funds…), failures so far, the provider's next retry, last contact and assignee, plus the recovery rate over 90 days. Example: { \"limit\": 10 }.",
  input: recoveryInput,
  async run(rt, input) {
    const q = await recoveryQueue(rt.ctx, { asOf: rt.today });
    const cur = rt.tenant.currency;
    const tz = rt.tenant.timezone;
    return { data: { currency: cur, valueAtRisk: majorUnits(q.valueAtRiskMinor, cur), recoveryRate90d: roundTo(q.recoveryRate), open: q.rows.length, items: q.rows.slice(0, input.limit).map((r) => ({ customerName: r.customerName, valueAtRisk: majorUnits(r.valueAtRiskMinor, cur), failingSince: localDate(r.failingSince, tz), failures: r.failures, reason: r.lastErrorCode, nextRetry: localDate(r.nextRetryAt, tz), lastContact: localDate(r.lastContactAt, tz), assigned: Boolean(r.assignedTo), link: hullwiseLink(rt, `/subscriptions/subscribers/${r.contractId}`) })), link: hullwiseLink(rt, "/subscriptions/recovery") } };
  },
};

const stockInput = z.object({ weeks: z.number().int().min(1).max(12).default(2) });
const getRenewalStock: HullwiseTool<typeof stockInput> = {
  ...common,
  name: "get_renewal_stock",
  title: "Stock needed by upcoming renewals",
  description: "Units each variant needs for the scheduled subscription renewals of the next weeks against available stock and incoming purchase orders, the first renewal the stock cannot serve, and the suggested purchase quantity. Example: { \"weeks\": 2 }.",
  input: stockInput,
  async run(rt, input) {
    const rows = await renewalStock(rt.ctx, { weeks: input.weeks, asOf: rt.today });
    return { data: { weeks: input.weeks, variants: rows.slice(0, 50).map((r) => ({ variant: r.label, sku: r.sku, renewals: r.renewals, units: r.units, available: r.available, incoming: r.incoming, runsOutOn: localDate(r.runOutAt, rt.tenant.timezone), shortfall: r.shortfall, suggestedQuantity: r.suggestedQuantity, link: hullwiseLink(rt, `/products/${r.productId}`) })), link: hullwiseLink(rt, `/subscriptions/stock?weeks=${input.weeks}`) } };
  },
};

export const SUBSCRIPTION_MCP_TOOLS: readonly HullwiseTool[] = [getOverview, listRecovery, getRenewalStock] as unknown as HullwiseTool[];
