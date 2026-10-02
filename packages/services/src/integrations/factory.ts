import { and, eq, gte, inArray, isNotNull, schema, sql } from "@keel/db";
import { AnthropicLlmProvider, MockLlmProvider, type AnthropicCredentials, type LlmProvider, GoogleAdsPlatform, MetaAdsPlatform, MockAdsPlatform, type MockAdsStructure, GoogleConversionsSink, MetaConversionsSink, MockAddressProvider, MockAudienceDestination, MockCommercePlatform, MockConversionSink, MockMessagingChannel, MockNotificationSink, MockPaymentGuarantee, MockReturnLabelProvider, PROCESSOR_GATEWAYS, ShopifyCommercePlatform, type MockPaymentOrder, SlackWebhookSink, decryptJson, integrationMode, type AddressProvider, type AudienceDestination, type AudienceProvider, type ConversionProvider, type ConversionSink, type MessagingChannel, type NotificationSink, type PaymentGuarantee, type ReturnLabelProvider, type AdsPlatform, type CommercePlatform, type GoogleAdsCredentials, type MetaCredentials, type NormalizedProduct, type ShopifyCredentials, MockCarrierProvider, type CarrierProvider } from "@keel/integrations";
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
    .select({ id: schema.productVariants.externalId, productId: schema.products.externalId, inv: schema.productVariants.inventoryItemExternalId, sku: schema.productVariants.sku, title: schema.productVariants.title, productTitle: schema.products.title, optionValues: schema.productVariants.optionValues, priceMinor: schema.productVariants.priceMinor, costMinor: schema.productVariants.costMinor, barcode: schema.productVariants.barcode, imageUrl: schema.products.imageUrl })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .where(and(eq(schema.productVariants.tenantId, tenant.id), eq(schema.productVariants.isActive, true)))
    .limit(400);
  const locations = await ctx.tx.select().from(schema.locations).where(eq(schema.locations.tenantId, tenant.id));
  const customers = await ctx.tx.select().from(schema.customers).where(eq(schema.customers.tenantId, tenant.id)).limit(300);
  const numbers = await ctx.tx.select({ n: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.tenantId, tenant.id)).orderBy(schema.orders.orderNumber);
  const levels = await ctx.tx.select({ inv: schema.productVariants.inventoryItemExternalId, loc: schema.locations.externalId, available: schema.inventoryLevels.available }).from(schema.inventoryLevels).innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.inventoryLevels.variantId)).innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId)).where(eq(schema.inventoryLevels.tenantId, tenant.id));
  const platform = new MockCommercePlatform({
    paymentOrders: await mockPaymentOrders(ctx, tenant.id),
    currency: tenant.currency,
    country: tenant.country,
    orderNumberPrefix: tenant.orderNumberPrefix,
    startOrderNumber: (numbers.at(-1)?.n ?? 1000) + 1,
    seed: tenant.id.charCodeAt(0) + tenant.id.charCodeAt(1),
    webhookSecret: row?.externalAccountId ? `mock-secret-${row.externalAccountId}` : undefined,
    variants: variants.filter((v) => v.id && v.productId && v.inv).map((v) => ({ externalId: v.id!, productExternalId: v.productId!, inventoryItemExternalId: v.inv!, sku: v.sku ?? "", title: v.title, productTitle: v.productTitle, optionValues: v.optionValues as Record<string, string>, priceMinor: v.priceMinor, unitCostMinor: v.costMinor, barcode: v.barcode, productImageUrl: v.imageUrl })),
    locations: locations.map((l) => ({ externalId: l.externalId ?? l.id, name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive })),
    customers: customers.map((c) => ({ externalId: c.externalId ?? c.id, email: c.email, phone: c.phone, firstName: c.firstName, lastName: c.lastName, country: c.country, city: c.city, zip: c.zip, acceptsMarketing: c.acceptsMarketing, tags: c.tags, platformCreatedAt: c.platformCreatedAt })),
    // the simulated store starts from the tenant's stock, so a sync only shows what really changed
    inventory: levels.filter((l) => l.inv && l.loc).map((l) => ({ inventoryItemExternalId: l.inv!, locationExternalId: l.loc!, available: l.available })),
    products: await mockStoreProducts(ctx, tenant.id),
  });
  commerceMocks.set(tenant.id, platform);
  return platform;
}

/**
 * The simulated store's catalog, as complete as Shopify's (issue #19): every product Keel holds with
 * a platform id, its gallery, SEO, category, channels, metafields and variant fields. A sync of the
 * untouched mock therefore changes nothing; writes change the store and Keel reads them back.
 */
async function mockStoreProducts(ctx: ServiceContext, tenantId: string): Promise<NormalizedProduct[]> {
  const products = await ctx.tx.select().from(schema.products).where(and(eq(schema.products.tenantId, tenantId), isNotNull(schema.products.externalId))).orderBy(schema.products.title);
  if (!products.length) return [];
  const variants = await ctx.tx.select().from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, tenantId), eq(schema.productVariants.isActive, true), isNotNull(schema.productVariants.externalId))).orderBy(schema.productVariants.title);
  const media = await ctx.tx.select().from(schema.productMedia).where(eq(schema.productMedia.tenantId, tenantId)).orderBy(schema.productMedia.position);
  const mediaExt = new Map(media.map((m) => [m.id, m.externalId]));
  return products.map((p) => {
    const gallery = media.filter((m) => m.productId === p.id && m.externalId);
    return {
      externalId: p.externalId!, title: p.title, handle: p.handle, vendor: p.vendor, productType: p.productType, status: p.status as "active" | "draft" | "archived", tags: p.tags, options: p.options as { name: string; values: string[] }[], imageUrl: p.imageUrl, platformCreatedAt: p.platformCreatedAt,
      platformUpdatedAt: p.platformUpdatedAt ?? p.syncedAt ?? null, descriptionHtml: p.descriptionHtml, seo: { title: p.seoTitle, description: p.seoDescription }, category: p.categoryId ? { id: p.categoryId, name: p.categoryName ?? p.categoryId } : null,
      collections: (p.collections as NormalizedProduct["collections"]) ?? [], publishedChannels: (p.publishedChannels as NormalizedProduct["publishedChannels"]) ?? [], metafields: (p.metafields as NormalizedProduct["metafields"]) ?? [],
      media: gallery.map((m) => ({ externalId: m.externalId!, type: m.type as "image" | "video" | "model", url: m.url, alt: m.alt, width: m.width, height: m.height })),
      variants: variants.filter((v) => v.productId === p.id).map((v) => ({
        externalId: v.externalId!, inventoryItemExternalId: v.inventoryItemExternalId, sku: v.sku, barcode: v.barcode, title: v.title, optionValues: v.optionValues as Record<string, string>, priceMinor: v.priceMinor, compareAtMinor: v.compareAtMinor, weightGrams: v.weightGrams,
        costMinor: v.costMinor,
        imageMediaExternalId: v.imageMediaId ? (mediaExt.get(v.imageMediaId) ?? null) : null, inventoryPolicy: (v.inventoryPolicy as "deny" | "continue" | null) ?? "deny", tracksInventory: v.tracksInventory ?? true, requiresShipping: v.requiresShipping ?? true, taxable: v.taxable ?? true, hsCode: v.hsCode, countryOfOrigin: v.countryOfOrigin,
      })),
    };
  });
}

/** Window of orders the simulated processor pays out (the seed writes the same payouts for it). */
export const MOCK_PAYOUT_DAYS = 100;

/** The tenant's recent orders paid through the processor, as the mock payouts are built from them. */
async function mockPaymentOrders(ctx: ServiceContext, tenantId: string): Promise<MockPaymentOrder[]> {
  const rows = await ctx.tx
    .select({ externalId: schema.orders.externalId, placedAt: schema.orders.placedAt, totalMinor: schema.orders.totalMinor, refundedMinor: schema.orders.refundedMinor, paymentStatus: schema.orders.paymentStatus, cancelledAt: schema.orders.cancelledAt, gateways: schema.orders.paymentGateways, refundedAt: sql<string | null>`(select min(t.occurred_at) from order_transactions t where t.order_id = ${schema.orders.id} and t.kind = 'refund')` })
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, tenantId), isNotNull(schema.orders.externalId), gte(schema.orders.placedAt, new Date(Date.now() - MOCK_PAYOUT_DAYS * 864e5)), inArray(schema.orders.paymentStatus, ["paid", "partially_refunded", "refunded"]), sql`${schema.orders.paymentGateways} && ${sql.raw(`array[${PROCESSOR_GATEWAYS.map((g) => `'${g}'`).join(",")}]::text[]`)}`));
  return rows.map((o) => ({ externalId: o.externalId!, placedAt: o.placedAt, totalMinor: o.totalMinor, refundedMinor: o.paymentStatus === "refunded" ? o.totalMinor : o.refundedMinor, refundedAt: o.cancelledAt ?? (o.refundedAt ? new Date(o.refundedAt) : null), gateways: o.gateways }));
}

/** Whether Keel may write to the ads platform below the campaign: always on Meta, on Google only once the tenant granted the write scope (`integrations.config.writeAccess`). */
export function adsWriteAccess(provider: string, row: { config: unknown } | null): boolean {
  if (provider === "meta") return true;
  return provider === "google" && (row?.config as { writeAccess?: unknown } | null)?.writeAccess === true;
}

export async function getAdsPlatformFor(ctx: ServiceContext, tenant: PlatformTenant, provider: "meta" | "google"): Promise<AdsPlatform> {
  const row = await integrationRow(ctx, provider);
  const writes = adsWriteAccess(provider, row);
  if (isLive(row)) {
    if (provider === "meta") return new MetaAdsPlatform(decryptJson<MetaCredentials>(row!.credentialsEncrypted!));
    return new GoogleAdsPlatform(decryptJson<GoogleAdsCredentials>(row!.credentialsEncrypted!), { writeEnabled: writes });
  }
  const key = `${tenant.id}:${provider}:${writes ? "rw" : "ro"}`;
  const cached = adsMocks.get(key);
  if (cached) return cached;
  const campaigns = await ctx.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, tenant.id), eq(schema.campaigns.platform, provider)));
  const platform = new MockAdsPlatform({ provider, currency: tenant.currency, readOnly: provider === "google", adWrites: writes, structure: await mockAdsStructure(ctx, tenant.id, provider), campaigns: campaigns.map((c) => ({ externalId: c.externalId, accountExternalId: c.accountExternalId ?? "", name: c.name, status: c.status as "active" | "paused" | "archived", objective: c.objective, dailyBudgetMinor: c.dailyBudgetMinor, currency: c.currency, platformCreatedAt: c.platformCreatedAt })) });
  adsMocks.set(key, platform);
  return platform;
}

/** The tenant's ad sets, ads, assets, keywords and search terms as the simulator reports them, so a mock sync updates the same rows. */
async function mockAdsStructure(ctx: ServiceContext, tenantId: string, provider: string): Promise<MockAdsStructure> {
  const camps = new Map((await ctx.tx.select({ id: schema.campaigns.id, ext: schema.campaigns.externalId }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, tenantId), eq(schema.campaigns.platform, provider)))).map((c) => [c.id, c.ext]));
  const sets = await ctx.tx.select().from(schema.adSets).where(and(eq(schema.adSets.tenantId, tenantId), eq(schema.adSets.platform, provider)));
  const setExt = new Map(sets.map((s) => [s.id, s.externalId]));
  const ads = await ctx.tx.select().from(schema.adCreatives).where(and(eq(schema.adCreatives.tenantId, tenantId), eq(schema.adCreatives.platform, provider)));
  const adExt = new Map(ads.map((a) => [a.id, a.externalId]));
  const assets = await ctx.tx.select().from(schema.adAssets).where(and(eq(schema.adAssets.tenantId, tenantId), eq(schema.adAssets.platform, provider)));
  const keywords = await ctx.tx.select().from(schema.adKeywords).where(and(eq(schema.adKeywords.tenantId, tenantId), eq(schema.adKeywords.platform, provider)));
  const kwExt = new Map(keywords.map((k) => [k.id, k.externalId]));
  const terms = await ctx.tx.select({ keywordId: schema.adSearchTerms.keywordId, text: schema.adSearchTerms.text }).from(schema.adSearchTerms).where(and(and(eq(schema.adSearchTerms.tenantId, tenantId), eq(schema.adSearchTerms.platform, provider)), eq(schema.adSearchTerms.isOther, false)));
  const st = (s: string) => (s === "paused" ? "paused" : s === "archived" ? "archived" : "active") as "active" | "paused" | "archived";
  return {
    adSets: sets.map((s) => ({ externalId: s.externalId, campaignExternalId: camps.get(s.campaignId) ?? "", name: s.name, status: st(s.status), optimizationGoal: s.optimizationGoal, dailyBudgetMinor: s.dailyBudgetMinor })),
    ads: ads.map((a) => ({ externalId: a.externalId, adSetExternalId: a.adSetId ? (setExt.get(a.adSetId) ?? null) : a.adsetExternalId, campaignExternalId: camps.get(a.campaignId) ?? "", name: a.name, status: st(a.status), format: a.format, headline: a.headline, body: a.body, finalUrl: a.finalUrl, urlTags: a.urlTags, thumbnailUrl: a.thumbnailUrl })),
    assets: assets.map((a) => ({ assetExternalId: a.assetExternalId, adExternalId: a.creativeId ? (adExt.get(a.creativeId) ?? null) : null, adSetExternalId: a.adSetId ? (setExt.get(a.adSetId) ?? null) : null, campaignExternalId: camps.get(a.campaignId) ?? "", type: a.type as "text" | "image" | "video", fieldType: a.fieldType, text: a.textContent, url: a.url, performanceLabel: a.performanceLabel })),
    keywords: keywords.map((k) => ({ externalId: k.externalId, adSetExternalId: k.adSetId ? (setExt.get(k.adSetId) ?? null) : null, campaignExternalId: camps.get(k.campaignId) ?? "", text: k.text, matchType: k.matchType as "exact" | "phrase" | "broad", qualityScore: k.qualityScore, status: st(k.status), negative: k.negative })),
    searchTerms: terms.filter((t) => t.keywordId && kwExt.has(t.keywordId)).map((t) => ({ keywordExternalId: kwExt.get(t.keywordId!)!, text: t.text })),
  };
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

/* ---------- alert delivery sinks ---------- */

const sinkMocks = new Map<string, MockNotificationSink>();

/**
 * Slack goes to the tenant's incoming webhook (integration row `slack`, credentials `{ webhookUrl }`).
 * In mock mode, or without credentials, a recording mock is returned so alerts still show "delivered (mock)".
 * Email is not a sink: it goes through the platform mailer (`queueEmail`, packages/services/src/email).
 */
export async function getNotificationSinks(ctx: ServiceContext): Promise<{ slack: NotificationSink | null; mock: { slack: boolean } }> {
  const row = await integrationRow(ctx, "slack");
  const slackLive = isLive(row);
  let slack: NotificationSink | null = null;
  if (slackLive) slack = new SlackWebhookSink(decryptJson<{ webhookUrl: string }>(row!.credentialsEncrypted!).webhookUrl);
  else if (row) {
    const m = sinkMocks.get(ctx.tenantId) ?? new MockNotificationSink();
    sinkMocks.set(ctx.tenantId, m);
    slack = m;
  }
  return { slack, mock: { slack: !slackLive } };
}

export function mockSinkFor(tenantId: string): MockNotificationSink | undefined {
  return sinkMocks.get(tenantId);
}

const guarantees = new Map<string, MockPaymentGuarantee>();
/**
 * Payment guarantee for instant exchanges. Only the mock exists: a live provider (Stripe manual
 * capture, Shopify Payments vaulted cards) needs an account and is part of the external block.
 */
export function getPaymentGuaranteeFor(tenantId: string): PaymentGuarantee {
  let g = guarantees.get(tenantId);
  if (!g) {
    g = new MockPaymentGuarantee();
    guarantees.set(tenantId, g);
  }
  return g;
}

const addressMocks = new Map<string, MockAddressProvider>();
/**
 * Address autocomplete and validation for the order-edit dialog. Only the mock exists: a live
 * provider (integration key `address`) and its guide page come with the external block (issue #7).
 */
export function getAddressProviderFor(tenantId: string): AddressProvider {
  let a = addressMocks.get(tenantId);
  if (!a) {
    a = new MockAddressProvider();
    addressMocks.set(tenantId, a);
  }
  return a;
}

/** Return label provider: the mock, until a carrier or EasyPost/Shippo account is connected (external block). */
export function getReturnLabelProviderFor(_tenantId: string): ReturnLabelProvider {
  return new MockReturnLabelProvider();
}

const carriers = new Map<string, MockCarrierProvider>();
/**
 * Carrier connector for delivery instructions (issue #28). Only the mock exists: a live carrier or
 * aggregator API is a per-account integration (`CarrierProvider`); in live mode, until one is sold
 * and wired here, there is none and instructions go by email.
 */
export function getCarrierProviderFor(tenantId: string): CarrierProvider | null {
  if (integrationMode() === "live") return null;
  let c = carriers.get(tenantId);
  if (!c) {
    c = new MockCarrierProvider();
    carriers.set(tenantId, c);
  }
  return c;
}
export function mockCarrierFor(tenantId: string): MockCarrierProvider | undefined {
  return carriers.get(tenantId);
}

const messaging = new Map<string, MockMessagingChannel>();
/**
 * Messaging channel for customer campaigns. Only the mock exists: email, SMS and WhatsApp
 * providers are per-account integrations (external block); the mock records what was sent.
 */
export function getMessagingChannelFor(tenantId: string): MessagingChannel {
  let m = messaging.get(tenantId);
  if (!m) {
    m = new MockMessagingChannel();
    messaging.set(tenantId, m);
  }
  return m;
}
export function mockMessagingFor(tenantId: string): MockMessagingChannel | undefined {
  return messaging.get(tenantId);
}

const audiences = new Map<string, MockAudienceDestination>();
/**
 * Audience destination for segment sync. Only mocks: Meta Custom Audiences, Google Customer Match
 * and email tools need the account's own credentials and permissions (external block, issue #7).
 */
export function getAudienceDestinationFor(tenantId: string, provider: AudienceProvider): AudienceDestination {
  const key = `${tenantId}:${provider}`;
  let d = audiences.get(key);
  if (!d) {
    d = new MockAudienceDestination(provider);
    audiences.set(key, d);
  }
  return d;
}
export function mockAudienceFor(tenantId: string, provider: AudienceProvider): MockAudienceDestination | undefined {
  return audiences.get(`${tenantId}:${provider}`);
}

const conversionMocks = new Map<string, MockConversionSink>();
/**
 * Server-side conversion sink: live when the platform integration is live and a destination
 * (Meta dataset, Google conversion action) is configured; the mock otherwise.
 */
export async function getConversionSinkFor(ctx: ServiceContext, provider: ConversionProvider, settings: { destinationId: string | null; testEventCode: string | null }): Promise<ConversionSink> {
  const row = await integrationRow(ctx, provider);
  if (isLive(row) && settings.destinationId) {
    if (provider === "meta") return new MetaConversionsSink(decryptJson<MetaCredentials>(row!.credentialsEncrypted!), settings.destinationId, { testEventCode: settings.testEventCode });
    return new GoogleConversionsSink(decryptJson<GoogleAdsCredentials>(row!.credentialsEncrypted!), settings.destinationId);
  }
  return mockConversionSinkFor(ctx.tenantId, provider);
}
export function mockConversionSinkFor(tenantId: string, provider: ConversionProvider): MockConversionSink {
  const key = `${tenantId}:${provider}`;
  let m = conversionMocks.get(key);
  if (!m) {
    m = new MockConversionSink(provider);
    conversionMocks.set(key, m);
  }
  return m;
}

/* ---------- language model (AI assistant) ---------- */

const llmMocks = new Map<string, MockLlmProvider>();

/**
 * The assistant runs on the store's own Anthropic key, connected in Integrations (provider
 * `anthropic`, credentials `{ apiKey }`), so the store pays the model provider directly. Null when
 * the integration is not connected; the deterministic mock when it is connected in mock mode.
 */
export async function getLlmProviderFor(ctx: ServiceContext): Promise<LlmProvider | null> {
  const row = await integrationRow(ctx, "anthropic");
  if (!row || row.status === "not_connected") return null;
  if (isLive(row)) return new AnthropicLlmProvider(decryptJson<AnthropicCredentials>(row.credentialsEncrypted!));
  const cached = llmMocks.get(ctx.tenantId) ?? new MockLlmProvider();
  llmMocks.set(ctx.tenantId, cached);
  return cached;
}
