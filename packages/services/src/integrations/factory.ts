import { and, eq, schema } from "@keel/db";
import { GoogleAdsPlatform, MetaAdsPlatform, MockAdsPlatform, MockCommercePlatform, ShopifyCommercePlatform, decryptJson, integrationMode, type AdsPlatform, type CommercePlatform, type GoogleAdsCredentials, type MetaCredentials, type ShopifyCredentials } from "@keel/integrations";
import type { ServiceContext } from "../context";

export interface PlatformTenant {
  id: string;
  currency: string;
  country: string;
  orderNumberPrefix: string;
}

/**
 * Adapter factory shared by the web app and the job runner. The integration row decides
 * the mode per tenant (`mock` | `live`); `KEEL_INTEGRATION_MODE=mock` forces mock everywhere
 * so no development or test process can ever reach a real API. Mocks are in-memory
 * simulators cached per process, so a webhook simulated now is visible to the next sync.
 */
const commerceMocks = new Map<string, MockCommercePlatform>();
const adsMocks = new Map<string, MockAdsPlatform>();
const liveCommerce = new Map<string, { key: string; platform: CommercePlatform }>();

export async function integrationRow(ctx: ServiceContext, provider: string) {
  const [row] = await ctx.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, provider))).limit(1);
  return row ?? null;
}

export function isLive(row: { mode: string; credentialsEncrypted: string | null; status: string } | null): boolean {
  return integrationMode() === "live" && !!row && row.mode === "live" && !!row.credentialsEncrypted && row.status !== "not_connected";
}

export async function getCommercePlatformFor(ctx: ServiceContext, tenant: PlatformTenant): Promise<CommercePlatform> {
  const row = await integrationRow(ctx, "shopify");
  if (isLive(row)) {
    const key = row!.credentialsEncrypted!;
    const cached = liveCommerce.get(tenant.id);
    if (cached && cached.key === key) return cached.platform;
    const platform = new ShopifyCommercePlatform(decryptJson<ShopifyCredentials>(key));
    liveCommerce.set(tenant.id, { key, platform });
    return platform;
  }
  const cached = commerceMocks.get(tenant.id);
  if (cached) return cached;
  const variants = await ctx.tx
    .select({ id: schema.productVariants.externalId, productId: schema.products.externalId, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title, optionValues: schema.productVariants.optionValues, priceMinor: schema.productVariants.priceMinor })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.tenantId, tenant.id), eq(schema.productVariants.isActive, true)))
    .limit(400);
  const locations = await ctx.tx.select().from(schema.locations).where(eq(schema.locations.tenantId, tenant.id));
  const customers = await ctx.tx.select().from(schema.customers).where(eq(schema.customers.tenantId, tenant.id)).limit(300);
  const numbers = await ctx.tx.select({ n: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.tenantId, tenant.id)).orderBy(schema.orders.orderNumber);
  const platform = new MockCommercePlatform({
    currency: tenant.currency,
    country: tenant.country,
    orderNumberPrefix: tenant.orderNumberPrefix,
    startOrderNumber: (numbers.at(-1)?.n ?? 1000) + 1,
    seed: tenant.id.charCodeAt(0) + tenant.id.charCodeAt(1),
    webhookSecret: row?.externalAccountId ? `mock-secret-${row.externalAccountId}` : undefined,
    variants: variants.filter((v) => v.id && v.productId && v.inv).map((v) => ({ externalId: v.id!, productExternalId: v.productId!, inventoryItemExternalId: v.inv!, sku: v.sku ?? "", title: v.title, productTitle: v.productTitle, optionValues: v.optionValues as Record<string, string>, priceMinor: v.priceMinor })),
    locations: locations.map((l) => ({ externalId: l.externalId ?? l.id, name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive })),
    customers: customers.map((c) => ({ externalId: c.externalId ?? c.id, email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName, country: c.country, city: c.city, zip: c.zip, acceptsMarketing: c.acceptsMarketing, tags: c.tags, platformCreatedAt: c.platformCreatedAt })),
  });
  commerceMocks.set(tenant.id, platform);
  return platform;
}

export async function getAdsPlatformFor(ctx: ServiceContext, tenant: PlatformTenant, provider: "meta" | "google"): Promise<AdsPlatform> {
  const row = await integrationRow(ctx, provider);
  if (isLive(row)) {
    if (provider === "meta") return new MetaAdsPlatform(decryptJson<MetaCredentials>(row!.credentialsEncrypted!));
    return new GoogleAdsPlatform(decryptJson<GoogleAdsCredentials>(row!.credentialsEncrypted!));
  }
  const key = `${tenant.id}:${provider}`;
  const cached = adsMocks.get(key);
  if (cached) return cached;
  const campaigns = await ctx.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, tenant.id), eq(schema.campaigns.platform, provider)));
  const platform = new MockAdsPlatform({ provider, currency: tenant.currency, readOnly: provider === "google", campaigns: campaigns.map((c) => ({ externalId: c.externalId, accountExternalId: c.accountExternalId ?? "", name: c.name, status: c.status as "active" | "paused" | "archived", objective: c.objective, dailyBudgetMinor: c.dailyBudgetMinor, currency: c.currency, platformCreatedAt: c.platformCreatedAt })) });
  adsMocks.set(key, platform);
  return platform;
}

/** The mock commerce simulator for a tenant, when one is cached (webhook simulation, tests). */
export function mockCommerceFor(tenantId: string): MockCommercePlatform | undefined {
  return commerceMocks.get(tenantId);
}

export function resetMockPlatforms(): void {
  commerceMocks.clear();
  adsMocks.clear();
  liveCommerce.clear();
}
