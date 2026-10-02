import { and, eq, recordAudit, schema, sql, type DbExecutor } from "@hullwise/db";
import { PLATFORM_CURRENCY } from "@hullwise/config";
import { catalogItemFor, mergeInvoiceStatus } from "@hullwise/core";
import { parseMockPriceId, type InvoiceSnapshot, type SubscriptionSnapshot } from "@hullwise/integrations";

/**
 * The Hullwise side of Stripe billing (#53): the subscription and invoice rows mirror what Stripe
 * reports. Writers here run on the admin connection (platform billing is not tenant data).
 */
export class BillingError extends Error {
  constructor(readonly code: "catalog_not_synced" | "no_subscription" | "already_subscribed" | "not_managed" | "provider_failed" | "invalid_input" | "tenant_not_found" | "no_checkout" | "not_mock" | "no_customer") {
    super(code);
    this.name = "BillingError";
  }
}

export type MirroredItem = (typeof schema.subscriptions.$inferSelect)["items"][number];

/** Serialises billing writes of one tenant (webhook events, console actions) inside a transaction. */
export async function lockTenantBilling(tx: DbExecutor, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${tenantId}`}))`);
}

/** Current price id of a catalog entry, from the last catalog sync. */
export async function priceIdFor(db: DbExecutor, provider: string, lookupKey: string): Promise<string> {
  const [row] = await db.select({ priceId: schema.billingPrices.priceId }).from(schema.billingPrices).where(and(eq(schema.billingPrices.provider, provider), eq(schema.billingPrices.lookupKey, lookupKey))).limit(1);
  if (!row) throw new BillingError("catalog_not_synced");
  return row.priceId;
}

/** Lookup key behind a price id (basil invoice lines carry the price id only). */
export async function lookupKeyForPrice(db: DbExecutor, priceId: string | null): Promise<string | null> {
  if (!priceId) return null;
  const mock = parseMockPriceId(priceId);
  if (mock) return mock.lookupKey;
  const [row] = await db.select({ lookupKey: schema.billingPrices.lookupKey }).from(schema.billingPrices).where(eq(schema.billingPrices.priceId, priceId)).limit(1);
  return row?.lookupKey ?? null;
}

const planKeyOf = (items: readonly MirroredItem[]) => {
  const plan = items.map((i) => catalogItemFor(i.lookupKey)).find((c) => c?.kind === "plan");
  return plan?.key ?? null;
};

/** Writes a Stripe subscription onto the tenant's subscription row (creates it when missing). Audited when something changed. */
export async function applySubscriptionSnapshot(db: DbExecutor, tenantId: string, snap: SubscriptionSnapshot, opts: { provider: string; eventAt?: Date | null; now: Date; actorUserId?: string | null }): Promise<typeof schema.subscriptions.$inferSelect> {
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  const items: MirroredItem[] = snap.items.map((i) => ({ itemId: i.itemId, priceId: i.priceId, lookupKey: i.lookupKey, unitAmountMinor: i.unitAmountMinor, currency: i.currency || PLATFORM_CURRENCY, interval: i.interval, quantity: i.quantity }));
  const planKey = planKeyOf(items);
  const patch = {
    provider: opts.provider,
    externalSubscriptionId: snap.id,
    externalCustomerId: snap.customerId || sub?.externalCustomerId || null,
    externalStatus: snap.status,
    collectionMethod: snap.collectionMethod,
    cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
    items,
    ...(planKey ? { planKey } : {}),
    ...(snap.paymentMethodSummary ? { paymentMethodSummary: snap.paymentMethodSummary } : {}),
    ...(snap.currentPeriodStart ? { currentPeriodStart: snap.currentPeriodStart } : {}),
    ...(snap.currentPeriodEnd ? { currentPeriodEnd: snap.currentPeriodEnd } : {}),
    trialEndsAt: snap.trialEnd,
    // the checkout is over once Stripe reports a subscription
    checkoutSessionId: null,
    checkoutUrl: null,
    checkoutExpiresAt: null,
    checkoutItems: null,
    ...(snap.status === "canceled" ? { cancelledAt: snap.canceledAt ?? opts.now } : {}),
    lastEventAt: opts.eventAt ?? sub?.lastEventAt ?? null,
    lastSyncedAt: opts.now,
    updatedAt: opts.now,
  };
  let row: typeof schema.subscriptions.$inferSelect;
  if (sub) [row] = (await db.update(schema.subscriptions).set(patch).where(eq(schema.subscriptions.id, sub.id)).returning()) as [typeof schema.subscriptions.$inferSelect];
  else {
    const [tenant] = await db.select({ planKey: schema.tenants.planKey, status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    [row] = (await db.insert(schema.subscriptions).values({ tenantId, planKey: planKey ?? tenant?.planKey ?? "starter", status: tenant?.status === "trial" ? "trialing" : "active", currency: items[0]?.currency ?? PLATFORM_CURRENCY, currentPeriodStart: snap.currentPeriodStart ?? opts.now, currentPeriodEnd: snap.currentPeriodEnd ?? opts.now, ...patch }).returning()) as [typeof schema.subscriptions.$inferSelect];
  }
  const before = { externalStatus: sub?.externalStatus ?? null, items: (sub?.items ?? []).map((i) => i.lookupKey).join(","), planKey: sub?.planKey ?? null, cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false };
  const after = { externalStatus: row.externalStatus, items: row.items.map((i) => i.lookupKey).join(","), planKey: row.planKey, cancelAtPeriodEnd: row.cancelAtPeriodEnd };
  const diff = Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k as keyof typeof before] !== v).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]));
  if (Object.keys(diff).length) await recordAudit(db, { tenantId, actorUserId: opts.actorUserId ?? null, actorType: opts.actorUserId ? "super_admin" : "system", action: "billing.subscription_synced", entityType: "subscription", entityId: row.id, diff, metadata: { provider: opts.provider, externalSubscriptionId: snap.id } });
  return row;
}

export type InvoiceFlag = "payment_failed" | "action_required" | "paid" | null;

/** Upserts a Stripe invoice into the ledger (unique on tenant + external id). A paid or void invoice never goes back to open. Audited on status changes. */
export async function upsertInvoiceSnapshot(db: DbExecutor, tenantId: string, inv: InvoiceSnapshot, opts: { provider: string; flag?: InvoiceFlag; eventAt?: Date | null; now: Date }): Promise<{ row: typeof schema.invoices.$inferSelect; statusChanged: boolean; previous: string | null }> {
  if (inv.status === "draft") throw new BillingError("invalid_input");
  const [existing] = await db.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.externalId, inv.id))).limit(1);
  const [sub] = await db.select({ id: schema.subscriptions.id }).from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  const status = mergeInvoiceStatus(existing?.status ?? null, inv.status);
  const lines = [];
  for (const l of inv.lines) {
    const item = catalogItemFor(l.lookupKey ?? (await lookupKeyForPrice(db, l.priceId)));
    lines.push(item ? { kind: item.kind, key: item.key, amountMinor: l.amountMinor, ...(l.proration ? { proration: true } : {}) } : { kind: "other", key: l.description ?? "", amountMinor: l.amountMinor, ...(l.proration ? { proration: true } : {}) });
  }
  const at = opts.eventAt ?? opts.now;
  const paid = status === "paid";
  const values = {
    subscriptionId: sub?.id ?? null,
    provider: opts.provider,
    hostedUrl: inv.hostedUrl ?? existing?.hostedUrl ?? null,
    pdfUrl: inv.pdfUrl ?? existing?.pdfUrl ?? null,
    status,
    kind: inv.billingReason === "subscription_update" || inv.billingReason === "manual" ? "adjustment" : "subscription",
    amountMinor: inv.totalMinor,
    subtotalMinor: inv.subtotalMinor,
    taxMinor: inv.taxMinor,
    currency: inv.currency || PLATFORM_CURRENCY,
    lines,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    issuedAt: inv.finalizedAt ?? inv.createdAt,
    dueAt: inv.dueAt ?? inv.finalizedAt ?? inv.createdAt,
    paidAt: paid ? (inv.paidAt ?? existing?.paidAt ?? at) : null,
    voidedAt: status === "void" ? (existing?.voidedAt ?? at) : null,
    collectionMethod: inv.collectionMethod,
    attemptCount: Math.max(inv.attemptCount, existing?.attemptCount ?? 0),
    nextPaymentAttemptAt: paid ? null : inv.nextPaymentAttemptAt,
    paymentFailedAt: paid || status === "void" ? null : opts.flag === "payment_failed" ? (existing?.paymentFailedAt ?? at) : (existing?.paymentFailedAt ?? null),
    actionRequiredAt: paid || status === "void" ? null : opts.flag === "action_required" ? (existing?.actionRequiredAt ?? at) : (existing?.actionRequiredAt ?? null),
    lastPaymentError: paid ? null : (inv.lastPaymentError ?? existing?.lastPaymentError ?? null),
  };
  let row: typeof schema.invoices.$inferSelect;
  if (existing) [row] = (await db.update(schema.invoices).set(values).where(eq(schema.invoices.id, existing.id)).returning()) as [typeof schema.invoices.$inferSelect];
  else [row] = (await db.insert(schema.invoices).values({ tenantId, number: inv.number ?? inv.id, externalId: inv.id, ...values }).returning()) as [typeof schema.invoices.$inferSelect];
  const statusChanged = (existing?.status ?? null) !== row.status;
  const flagChanged = (opts.flag === "payment_failed" && !existing?.paymentFailedAt) || (opts.flag === "action_required" && !existing?.actionRequiredAt);
  if (statusChanged || flagChanged) await recordAudit(db, { tenantId, actorType: "system", action: opts.flag === "payment_failed" ? "billing.payment_failed" : opts.flag === "action_required" ? "billing.payment_action_required" : row.status === "paid" ? "billing.invoice_paid" : "billing.invoice_synced", entityType: "invoice", entityId: row.id, diff: statusChanged ? { status: { from: existing?.status ?? null, to: row.status } } : {}, metadata: { provider: opts.provider, externalId: inv.id, number: row.number, attemptCount: row.attemptCount } });
  return { row, statusChanged, previous: existing?.status ?? null };
}
