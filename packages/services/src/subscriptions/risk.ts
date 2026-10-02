import { and, eq, gte, inArray, schema, sql } from "@hullwise/db";
import { churnThresholdsFromPct, parseTenantSettings, renewalHazards, subscriberChurnRisk, type SubscriberRisk } from "@hullwise/core";
import type { ServiceContext } from "../context";

const LIVE = ["active", "paused"];

/**
 * Churn risk of every live subscriber: the customer's P(active) from the CRM prediction model
 * (`customer_predictions`, same thresholds as the CRM) adjusted by the subscription signals (an
 * open failed payment, recent skips, a long pause, the drop-off after their next renewal number,
 * a frequency lengthened). Stored on the contract so lists, segments and widgets read one value.
 */
export async function refreshSubscriberRisk(ctx: ServiceContext, opts: { contractIds?: string[] } = {}): Promise<Map<string, SubscriberRisk>> {
  const now = ctx.now ?? new Date();
  const all = await ctx.tx.select({ id: schema.subscriptionContracts.id, customerId: schema.subscriptionContracts.customerId, status: schema.subscriptionContracts.status, renewals: schema.subscriptionContracts.renewalsCount, endedAt: schema.subscriptionContracts.endedAt, pausedAt: schema.subscriptionContracts.pausedAt, failing: schema.subscriptionContracts.paymentFailingSince }).from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.tenantId, ctx.tenantId));
  const hazards = renewalHazards(all.map((c) => ({ renewals: c.renewals, ended: c.endedAt !== null })));
  const live = all.filter((c) => LIVE.includes(c.status) && (!opts.contractIds || opts.contractIds.includes(c.id)));
  const out = new Map<string, SubscriberRisk>();
  if (!live.length) return out;
  const customerIds = [...new Set(live.map((c) => c.customerId).filter((x): x is string => Boolean(x)))];
  const preds = customerIds.length ? await ctx.tx.select({ customerId: schema.customerPredictions.customerId, pAlive: schema.customerPredictions.pAlive }).from(schema.customerPredictions).where(and(eq(schema.customerPredictions.tenantId, ctx.tenantId), inArray(schema.customerPredictions.customerId, customerIds))) : [];
  const pAlive = new Map(preds.map((p) => [p.customerId, Number(p.pAlive)]));
  const since = new Date(now.getTime() - 90 * 864e5);
  const recent = await ctx.tx.select({ contractId: schema.subscriptionEvents.contractId, type: schema.subscriptionEvents.type, diff: schema.subscriptionEvents.diff }).from(schema.subscriptionEvents).where(and(eq(schema.subscriptionEvents.tenantId, ctx.tenantId), inArray(schema.subscriptionEvents.type, ["skipped", "frequency_changed"]), gte(schema.subscriptionEvents.occurredAt, since)));
  const skips = new Map<string, number>();
  const lengthened = new Set<string>();
  for (const e of recent) {
    if (e.type === "skipped") skips.set(e.contractId, (skips.get(e.contractId) ?? 0) + 1);
    const m = (e.diff as { mrrMinor?: { from: number; to: number } }).mrrMinor;
    if (e.type === "frequency_changed" && m && Number(m.to) < Number(m.from)) lengthened.add(e.contractId);
  }
  const [settings] = await ctx.tx.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  const ts = parseTenantSettings(settings?.settings);
  const th = churnThresholdsFromPct(ts.churnLowPct, ts.churnMediumPct);
  for (const c of live) {
    const risk = subscriberChurnRisk({ status: c.status, pAlive: c.customerId ? (pAlive.get(c.customerId) ?? null) : null, paymentFailing: c.failing !== null, skipsLast90: skips.get(c.id) ?? 0, pausedDays: c.pausedAt ? Math.floor((now.getTime() - c.pausedAt.getTime()) / 864e5) : null, renewals: c.renewals, hazardNext: hazards[Math.min(hazards.length - 1, c.renewals)] ?? null, frequencyLengthened: lengthened.has(c.id) }, th);
    out.set(c.id, risk);
    await ctx.tx.update(schema.subscriptionContracts).set({ churnRisk: risk.risk, churnRetentionBps: Math.round(risk.retention * 10_000), churnFactors: risk.factors, churnComputedAt: now }).where(eq(schema.subscriptionContracts.id, c.id));
  }
  // ended contracts carry no risk
  await ctx.tx.update(schema.subscriptionContracts).set({ churnRisk: null, churnRetentionBps: null }).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), sql`${schema.subscriptionContracts.status} not in ('active', 'paused')`, sql`${schema.subscriptionContracts.churnRisk} is not null`));
  return out;
}
