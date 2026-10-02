import { and, eq, inArray, schema } from "@hullwise/db";
import { LoopSubscriptionProvider, MockSubscriptionProvider, RechargeSubscriptionProvider, SUBSCRIPTION_PROVIDERS, ShopifySubscriptionProvider, decryptJson, isSubscriptionProvider, type LoopCredentials, type NormalizedBillingAttempt, type NormalizedSubscriptionContract, type RechargeCredentials, type ShopifyCredentials, type SubscriptionProvider, type SubscriptionProviderKey } from "@hullwise/integrations";
import type { SubscriptionInterval, SubscriptionStatus } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { integrationRow, isLive } from "../integrations/factory";

export const SUBSCRIPTIONS_ADDON = "addon.subscriptions";

/** Whether the tenant has `addon.subscriptions` active (read inside the tenant transaction). */
export async function subscriptionsEnabled(ctx: ServiceContext): Promise<boolean> {
  const [row] = await ctx.tx.select({ id: schema.tenantAddons.id }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, ctx.tenantId), eq(schema.tenantAddons.moduleKey, SUBSCRIPTIONS_ADDON), eq(schema.tenantAddons.isActive, true))).limit(1);
  return Boolean(row);
}

export class SubscriptionsDisabledError extends Error {
  constructor() {
    super("addon.subscriptions is not active for this tenant");
    this.name = "SubscriptionsDisabledError";
  }
}
export async function assertSubscriptionsEnabled(ctx: ServiceContext): Promise<void> {
  if (!(await subscriptionsEnabled(ctx))) throw new SubscriptionsDisabledError();
}

/** The tenant's subscription app integration row (the first connected of Shopify Subscriptions, Recharge, Loop). */
export async function subscriptionIntegration(ctx: ServiceContext) {
  const rows = await ctx.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), inArray(schema.integrations.provider, [...SUBSCRIPTION_PROVIDERS])));
  return rows.sort((a, b) => Number(b.status !== "not_connected") - Number(a.status !== "not_connected") || SUBSCRIPTION_PROVIDERS.indexOf(a.provider as SubscriptionProviderKey) - SUBSCRIPTION_PROVIDERS.indexOf(b.provider as SubscriptionProviderKey))[0] ?? null;
}

const mocks = new Map<string, MockSubscriptionProvider>();

/**
 * The adapter for the tenant's subscription app: live with the stored credentials (Shopify
 * Subscriptions reuses the store's Shopify credentials), otherwise the simulator built from the
 * contracts Hullwise holds, cached per process so actions and simulated renewals persist between
 * requests. Null when no subscription app is connected.
 */
export async function getSubscriptionProviderFor(ctx: ServiceContext): Promise<SubscriptionProvider | null> {
  const row = await subscriptionIntegration(ctx);
  if (!row || row.status === "not_connected" || !isSubscriptionProvider(row.provider)) return null;
  if (isLive(row)) {
    if (row.provider === "recharge") return new RechargeSubscriptionProvider(decryptJson<RechargeCredentials>(row.credentialsEncrypted!));
    if (row.provider === "loop") return new LoopSubscriptionProvider(decryptJson<LoopCredentials>(row.credentialsEncrypted!));
    const shop = await integrationRow(ctx, "shopify");
    const creds = shop?.credentialsEncrypted ? decryptJson<ShopifyCredentials>(shop.credentialsEncrypted) : decryptJson<ShopifyCredentials>(row.credentialsEncrypted!);
    return new ShopifySubscriptionProvider(creds);
  }
  const cached = mocks.get(ctx.tenantId);
  if (cached && cached.provider === row.provider) return cached;
  const mock = new MockSubscriptionProvider({ provider: row.provider, ...(await mockStateFromDb(ctx)) });
  mocks.set(ctx.tenantId, mock);
  return mock;
}

/** The cached simulator of a tenant (tests, the "simulate renewal" button). */
export function mockSubscriptionsFor(tenantId: string): MockSubscriptionProvider | undefined {
  return mocks.get(tenantId);
}
export function resetMockSubscriptions(): void {
  mocks.clear();
}

/** The simulated app starts from Hullwise's own rows, so a sync of the untouched mock changes nothing. */
async function mockStateFromDb(ctx: ServiceContext): Promise<{ contracts: NormalizedSubscriptionContract[]; attempts: NormalizedBillingAttempt[] }> {
  const contracts = await ctx.tx.select({ c: schema.subscriptionContracts, ext: schema.customers.externalId, email: schema.customers.email, first: schema.customers.firstName, last: schema.customers.lastName, phone: schema.customers.phone }).from(schema.subscriptionContracts).leftJoin(schema.customers, eq(schema.customers.id, schema.subscriptionContracts.customerId)).where(eq(schema.subscriptionContracts.tenantId, ctx.tenantId));
  if (!contracts.length) return { contracts: [], attempts: [] };
  const lines = await ctx.tx.select({ l: schema.subscriptionContractLines, productExt: schema.products.externalId }).from(schema.subscriptionContractLines).leftJoin(schema.products, eq(schema.products.id, schema.subscriptionContractLines.productId)).where(eq(schema.subscriptionContractLines.tenantId, ctx.tenantId));
  const attempts = await ctx.tx.select({ a: schema.subscriptionBillingAttempts, contractExt: schema.subscriptionContracts.externalId }).from(schema.subscriptionBillingAttempts).innerJoin(schema.subscriptionContracts, eq(schema.subscriptionContracts.id, schema.subscriptionBillingAttempts.contractId)).where(eq(schema.subscriptionBillingAttempts.tenantId, ctx.tenantId));
  const byContract = new Map<string, typeof lines>();
  for (const l of lines) byContract.set(l.l.contractId, [...(byContract.get(l.l.contractId) ?? []), l]);
  return {
    contracts: contracts.map(({ c, ext, email, first, last, phone }) => ({
      externalId: c.externalId, status: c.status as SubscriptionStatus, customer: c.customerId ? { externalId: ext, email, firstName: first, lastName: last, phone } : null, currency: c.currency,
      lines: (byContract.get(c.id) ?? []).map(({ l, productExt }) => ({ externalId: l.externalId, variantExternalId: l.variantExternalId, productExternalId: productExt, sku: l.sku, title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
      intervalUnit: c.intervalUnit as SubscriptionInterval, intervalCount: c.intervalCount, nextBillingAt: c.nextBillingAt, priceMinor: c.priceMinor, discounts: c.discounts as NormalizedSubscriptionContract["discounts"], createdAt: c.activatedAt, endedAt: c.endedAt, pausedAt: c.pausedAt,
      cancellationReasonRaw: c.cancellationReasonRaw, cancelledForNonPayment: c.cancellationKind === "involuntary", originOrderExternalId: c.originOrderExternalId, updatedAt: c.platformUpdatedAt ?? c.updatedAt,
    })),
    attempts: attempts.map(({ a, contractExt }) => ({ externalId: a.externalId, contractExternalId: contractExt, status: a.status as NormalizedBillingAttempt["status"], errorCode: a.errorCode as NormalizedBillingAttempt["errorCode"], errorMessage: a.errorMessage, amountMinor: a.amountMinor, currency: a.currency, orderExternalId: a.orderExternalId, attemptedAt: a.attemptedAt, nextRetryAt: a.nextRetryAt, cycleKey: a.cycleKey })),
  };
}
