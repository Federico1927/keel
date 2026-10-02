import { and, eq, schema } from "@keel/db";
import { AnthropicLlmProvider, MockLlmProvider, type AnthropicCredentials, type LlmProvider, GoogleAdsPlatform, MetaAdsPlatform, MockAdsPlatform, GoogleConversionsSink, MetaConversionsSink, MockAddressProvider, MockAudienceDestination, MockCarrierProvider, MockCommercePlatform, MockConversionSink, MockMessagingChannel, MockNotificationSink, MockPaymentGuarantee, MockReturnLabelProvider, ShopifyCommercePlatform, SlackWebhookSink, decryptJson, integrationMode, type AddressProvider, type CarrierProvider, type AudienceDestination, type AudienceProvider, type ConversionProvider, type ConversionSink, type MessagingChannel, type NotificationSink, type PaymentGuarantee, type ReturnLabelProvider, type AdsPlatform, type CommercePlatform, type GoogleAdsCredentials, type MetaCredentials, type ShopifyCredentials } from "@keel/integrations";
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
