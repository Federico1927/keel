import { and, eq, schema } from "@keel/db";
import { MockAdsPlatform, MockCommercePlatform, integrationMode, type AdsPlatform, type CommercePlatform } from "@keel/integrations";
import type { TenantContext } from "./tenant";

/**
 * Adapter factory. In mock mode (default) the adapters are in-memory simulators built
 * from the tenant's own catalog, cached per process. Live adapters arrive in phase 9.
 */
const commerceCache = new Map<string, MockCommercePlatform>();
const adsCache = new Map<string, MockAdsPlatform>();

export async function getCommercePlatform(ctx: TenantContext): Promise<CommercePlatform> {
  if (integrationMode() === "live") throw new Error("live adapters are configured in phase 9");
  const cached = commerceCache.get(ctx.tenant.id);
  if (cached) return cached;
  const { variants, locations, customers, maxNumber } = await ctx.run(async (tx) => {
    const variants = await tx
      .select({ id: schema.productVariants.externalId, productId: schema.products.externalId, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title, optionValues: schema.productVariants.optionValues, priceMinor: schema.productVariants.priceMinor })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.isActive, true)))
      .limit(400);
    const locations = await tx.select().from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id));
    const customers = await tx.select().from(schema.customers).where(eq(schema.customers.tenantId, ctx.tenant.id)).limit(300);
    const [m] = await tx.select({ n: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenant.id)).orderBy(schema.orders.orderNumber).limit(1);
    const all = await tx.select({ n: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.tenantId, ctx.tenant.id));
    void m;
    return { variants, locations, customers, maxNumber: all.reduce((a, b) => Math.max(a, b.n), 1000) };
  });
  const platform = new MockCommercePlatform({
    currency: ctx.tenant.currency,
    country: ctx.tenant.country,
    orderNumberPrefix: ctx.tenant.orderNumberPrefix,
    startOrderNumber: maxNumber + 1,
    seed: ctx.tenant.id.charCodeAt(0) + ctx.tenant.id.charCodeAt(1),
    variants: variants.filter((v) => v.id && v.productId && v.inv).map((v) => ({ externalId: v.id!, productExternalId: v.productId!, inventoryItemExternalId: v.inv!, sku: v.sku ?? "", title: v.title, productTitle: v.productTitle, optionValues: v.optionValues as Record<string, string>, priceMinor: v.priceMinor })),
    locations: locations.map((l) => ({ externalId: l.externalId ?? l.id, name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive })),
    customers: customers.map((c) => ({ externalId: c.externalId ?? c.id, email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName, country: c.country, city: c.city, zip: c.zip, acceptsMarketing: c.acceptsMarketing, tags: c.tags, platformCreatedAt: c.platformCreatedAt })),
  });
  commerceCache.set(ctx.tenant.id, platform);
  return platform;
}

export async function getAdsPlatform(ctx: TenantContext, provider: "meta" | "google"): Promise<AdsPlatform> {
  if (integrationMode() === "live") throw new Error("live adapters are configured in phase 9");
  const key = `${ctx.tenant.id}:${provider}`;
  const cached = adsCache.get(key);
  if (cached) return cached;
  const campaigns = await ctx.run((tx) => tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenant.id), eq(schema.campaigns.platform, provider))));
  const platform = new MockAdsPlatform({
    provider,
    currency: ctx.tenant.currency,
    readOnly: provider === "google",
    campaigns: campaigns.map((c) => ({ externalId: c.externalId, accountExternalId: c.accountExternalId ?? "", name: c.name, status: c.status as "active" | "paused" | "archived", objective: c.objective, dailyBudgetMinor: c.dailyBudgetMinor, currency: c.currency, platformCreatedAt: c.platformCreatedAt })),
  });
  adsCache.set(key, platform);
  return platform;
}

/** Used by tests and the integrations page to reset the simulators. */
export function resetMockAdapters(): void {
  commerceCache.clear();
  adsCache.clear();
}
