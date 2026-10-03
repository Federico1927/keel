import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, lte, recordAudit, schema, sql } from "@hullwise/db";
import type { SubscriptionPaymentError } from "@hullwise/core";
import { MockSubscriptionProvider, type NormalizedOrder } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { importOrder } from "../sync";
import { getSubscriptionProviderFor } from "./provider";
import { importBillingAttempt, importSubscriptionContract, type ContractRow } from "./sync";

/**
 * Mock mode only (addon.subscriptions, #67): the simulated subscription app charges renewals the way
 * the real one does. A paid charge creates the store's renewal order (imported like any Shopify
 * order, so P/L, stock, attribution and the subscriber's history see it); a declined one opens the
 * failed-payment episode with the app's next retry; after the last retry the app ends the contract
 * for non-payment. Used by the "Simulate renewal" buttons and, on the demo, by the add-on's tick
 * so upcoming renewals keep happening without a reseed. Never runs against a live app.
 */

export type SimulatedOutcome = "success" | SubscriptionPaymentError;
export interface SimulatedCharge {
  contractId: string;
  customerName: string | null;
  outcome: SimulatedOutcome | "gave_up";
  amountMinor: number;
  orderId: string | null;
  orderName: string | null;
  nextRetryAt: Date | null;
}

/** Days between the app's retries of a declined renewal, then it gives up (same schedule as the demo history). */
export const SIMULATED_RETRY_DAYS = [3, 4] as const;

export interface SimulationTenant {
  country: string;
  orderNumberPrefix: string;
}

/** The tenant's simulated subscription app, or null when the app is live or not connected. */
export async function simulatedSubscriptionApp(ctx: ServiceContext): Promise<MockSubscriptionProvider | null> {
  const provider = await getSubscriptionProviderFor(ctx);
  return provider instanceof MockSubscriptionProvider ? provider : null;
}

/** A stable 0–99 roll per contract and cycle: the same renewal always has the same simulated outcome. */
export function simulationRoll(contractId: string, cycle: string): number {
  return parseInt(createHash("sha256").update(`${contractId}:${cycle}`).digest("hex").slice(0, 8), 16) % 100;
}

async function nextOrderNumber(ctx: ServiceContext): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number | null>`max(${schema.orders.orderNumber})::int` }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenantId));
  return (r?.n ?? 1000) + 1;
}

/** The renewal order the store creates for a paid charge, built from the contract's lines and customer. */
async function renewalOrder(ctx: ServiceContext, c: ContractRow, tenant: SimulationTenant, at: Date): Promise<NormalizedOrder> {
  const lines = await ctx.tx.select({ l: schema.subscriptionContractLines, productExt: schema.products.externalId }).from(schema.subscriptionContractLines).leftJoin(schema.products, eq(schema.products.id, schema.subscriptionContractLines.productId)).where(eq(schema.subscriptionContractLines.contractId, c.id)).orderBy(asc(schema.subscriptionContractLines.externalId));
  const [cust] = c.customerId ? await ctx.tx.select().from(schema.customers).where(eq(schema.customers.id, c.customerId)).limit(1) : [];
  const [last] = c.customerId ? await ctx.tx.select({ address: schema.orders.shippingAddress }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.customerId, c.customerId))).orderBy(desc(schema.orders.placedAt)).limit(1) : [];
  const n = await nextOrderNumber(ctx);
  const name = cust ? [cust.firstName, cust.lastName].filter(Boolean).join(" ") || null : null;
  const orderLines = lines.map(({ l, productExt }, i) => ({ externalId: `${7_900_000_000 + n}-${i + 1}`, variantExternalId: l.variantExternalId, productExternalId: productExt, sku: l.sku, title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, currentQuantity: l.quantity, unitPriceMinor: l.unitPriceMinor, discountMinor: 0, totalMinor: l.unitPriceMinor * l.quantity }));
  const subtotal = orderLines.reduce((s, l) => s + l.totalMinor, 0);
  const address = (last?.address as NormalizedOrder["shippingAddress"]) ?? (cust ? { name, city: cust.city, zip: cust.zip, country: cust.country ?? tenant.country, phone: cust.phone } : null);
  return {
    externalId: String(7_900_000_000 + n), orderNumber: n, name: `#${tenant.orderNumberPrefix}${n}`,
    customer: cust?.externalId ? { externalId: cust.externalId, email: cust.email, phone: cust.phone, firstName: cust.firstName, lastName: cust.lastName, country: cust.country, city: cust.city, zip: cust.zip, acceptsMarketing: cust.acceptsMarketing, tags: cust.tags, platformCreatedAt: cust.platformCreatedAt } : null,
    email: cust?.email ?? null, phone: cust?.phone ?? null, customerName: name, currency: c.currency,
    subtotalMinor: subtotal, discountMinor: Math.max(0, subtotal - c.priceMinor), shippingMinor: 0, taxMinor: 0, totalMinor: c.priceMinor, refundedMinor: 0,
    paymentGateways: ["shopify_payments"], paymentMethod: "card", paymentStatus: "paid", financialStatusRaw: "paid", fulfillmentStatusRaw: null, tags: [],
    shippingAddress: address, billingAddress: address, note: null, noteAttributes: [], landingSite: null, referringSite: null, sourceChannel: "subscription_contract",
    placedAt: at, cancelledAt: null, cancelReason: null, closedAt: null, platformUpdatedAt: at, lines: orderLines, discounts: [], fulfillments: [],
  };
}

/**
 * One charge of the simulated app for one contract: `success` creates and imports the renewal order;
 * a decline schedules the app's next retry, or ends the contract for non-payment after the last one.
 */
export async function simulateContractCharge(ctx: ServiceContext, tenant: SimulationTenant, contractId: string, outcome: SimulatedOutcome, opts: { source?: "button" | "tick" } = {}): Promise<SimulatedCharge | null> {
  const mock = await simulatedSubscriptionApp(ctx);
  if (!mock) return null;
  const [c] = await ctx.tx.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.id, contractId))).limit(1);
  if (!c || c.status !== "active") return null;
  const now = ctx.now ?? new Date();
  const [cust] = c.customerId ? await ctx.tx.select({ first: schema.customers.firstName, last: schema.customers.lastName, email: schema.customers.email }).from(schema.customers).where(eq(schema.customers.id, c.customerId)).limit(1) : [];
  const customerName = cust ? [cust.first, cust.last].filter(Boolean).join(" ") || cust.email : null;
  // failures already in this episode decide the retry schedule
  const failures = c.paymentFailingSince ? ((await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.subscriptionBillingAttempts).where(and(eq(schema.subscriptionBillingAttempts.contractId, c.id), eq(schema.subscriptionBillingAttempts.status, "failed"), sql`${schema.subscriptionBillingAttempts.attemptedAt} >= ${c.paymentFailingSince}`)))[0]?.n ?? 0) : 0;
  let order: NormalizedOrder | null = null;
  if (outcome === "success") order = await renewalOrder(ctx, c, tenant, now);
  const retryDays = outcome === "success" ? null : (SIMULATED_RETRY_DAYS[failures] ?? null);
  const attempt = mock.simulateRenewal(c.externalId, outcome, { orderExternalId: order?.externalId, at: now, retryInDays: retryDays });
  let orderId: string | null = null;
  if (order) orderId = (await importOrder(ctx, order, { country: tenant.country, source: "webhook" })).id;
  let gaveUp = false;
  if (outcome !== "success" && retryDays === null) {
    mock.simulateDunningExhausted(c.externalId);
    gaveUp = true;
  }
  const contract = await mock.fetchContract(c.externalId);
  if (contract) await importSubscriptionContract(ctx, contract, { provider: c.provider, source: "sync" });
  await importBillingAttempt(ctx, attempt, { provider: c.provider, source: "sync" });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? "user" : "system", action: "subscriptions.renewal_simulated", entityType: "subscription_contract", entityId: c.id, diff: { outcome: { from: null, to: gaveUp ? "gave_up" : outcome } }, metadata: { source: opts.source ?? "button", orderExternalId: order?.externalId ?? null, amountMinor: c.priceMinor, cycle: attempt.cycleKey } });
  return { contractId: c.id, customerName, outcome: gaveUp ? "gave_up" : outcome, amountMinor: c.priceMinor, orderId, orderName: order?.name ?? null, nextRetryAt: attempt.nextRetryAt };
}

/** The next healthy renewal (earliest next billing among active contracts without a failing payment). */
export async function nextSimulatedRenewal(ctx: ServiceContext): Promise<string | null> {
  const [c] = await ctx.tx.select({ id: schema.subscriptionContracts.id }).from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.status, "active"), isNull(schema.subscriptionContracts.paymentFailingSince), isNotNull(schema.subscriptionContracts.nextBillingAt))).orderBy(asc(schema.subscriptionContracts.nextBillingAt)).limit(1);
  return c?.id ?? null;
}

/**
 * What the real app does between two syncs, on the simulator: every renewal that came due is charged
 * (about 1 in 12 declined, deterministic per contract and cycle) and every failed payment whose retry
 * came due is retried (about 45% recovered). At most `limit` charges per run.
 */
export async function chargeDueSimulatedRenewals(ctx: ServiceContext, tenant: SimulationTenant, opts: { limit?: number } = {}): Promise<{ charged: number; declined: number; recovered: number; gaveUp: number }> {
  const out = { charged: 0, declined: 0, recovered: 0, gaveUp: 0 };
  if (!(await simulatedSubscriptionApp(ctx))) return out;
  const now = ctx.now ?? new Date();
  const limit = opts.limit ?? 25;
  const due = await ctx.tx.select({ id: schema.subscriptionContracts.id, next: schema.subscriptionContracts.nextBillingAt }).from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.status, "active"), isNull(schema.subscriptionContracts.paymentFailingSince), lte(schema.subscriptionContracts.nextBillingAt, now))).orderBy(asc(schema.subscriptionContracts.nextBillingAt)).limit(limit);
  for (const d of due) {
    const cycle = d.next!.toISOString().slice(0, 10);
    const roll = simulationRoll(d.id, cycle);
    const outcome: SimulatedOutcome = roll < 8 ? (roll < 4 ? "card_expired" : "insufficient_funds") : "success";
    const r = await simulateContractCharge(ctx, tenant, d.id, outcome, { source: "tick" });
    if (!r) continue;
    if (r.outcome === "success") out.charged++;
    else out.declined++;
  }
  const retries = await ctx.tx.execute<{ id: string; cycle: string; failures: number }>(sql`
    select c.id, a.cycle_key as cycle, (select count(*) from subscription_billing_attempts f where f.contract_id = c.id and f.status = 'failed' and f.attempted_at >= c.payment_failing_since)::int as failures
    from subscription_contracts c
    join lateral (select cycle_key, next_retry_at from subscription_billing_attempts where contract_id = c.id order by attempted_at desc limit 1) a on true
    where c.tenant_id = ${ctx.tenantId} and c.status = 'active' and c.payment_failing_since is not null and a.next_retry_at is not null and a.next_retry_at <= ${now}
    order by a.next_retry_at limit ${Math.max(0, limit - due.length)}`);
  for (const r of retries.rows) {
    const recovered = simulationRoll(r.id, `${r.cycle}:retry${r.failures}`) < 45;
    const res = await simulateContractCharge(ctx, tenant, r.id, recovered ? "success" : "card_declined", { source: "tick" });
    if (!res) continue;
    if (res.outcome === "success") out.recovered++;
    else if (res.outcome === "gave_up") out.gaveUp++;
    else out.declined++;
  }
  return out;
}
