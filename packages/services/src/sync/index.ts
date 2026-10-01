import { and, desc, eq, inArray, schema, sql } from "@keel/db";
import { DEFAULT_PRECEDENCE, addressKey, deriveChannel, diffRecords, extractAttribution, hasChanges, matchCampaign, nameZipKey, normalizeEmail, normalizePhone, resolveShipmentStatus, type CampaignRef, type ShipmentStatus } from "@keel/core";
import { IntegrationError, type AdsPlatform, type CommercePlatform, type NormalizedCustomer, type NormalizedDiscount, type NormalizedInventoryLevel, type NormalizedLocation, type NormalizedOrder, type NormalizedProduct } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { recomputeOrderStatus } from "../orders/state";

export type ImportSource = "webhook" | "sync" | "backfill" | "reconcile";
export interface ImportOutcome {
  id: string;
  outcome: "created" | "updated" | "unchanged";
}
export interface ImportOptions {
  /** Tenant default country, used to normalise phone numbers. */
  country: string;
  source: ImportSource;
  /** Campaign refs for attribution matching; loaded once per batch when omitted. */
  campaigns?: CampaignRef[];
}

const errMessage = (e: unknown) => (e instanceof Error ? `${e instanceof IntegrationError ? `[${e.code}] ` : ""}${e.message}` : String(e));

/* ---------- customers ---------- */

export async function upsertCustomer(ctx: ServiceContext, c: NormalizedCustomer, country: string): Promise<string> {
  const now = ctx.now ?? new Date();
  const emailNormalized = normalizeEmail(c.email);
  const values = { email: c.email, emailNormalized, phone: c.phone, phoneE164: normalizePhone(c.phone, c.country ?? country), firstName: c.firstName, lastName: c.lastName, country: c.country, city: c.city, zip: c.zip, acceptsMarketing: c.acceptsMarketing, tags: c.tags, platformCreatedAt: c.platformCreatedAt, syncedAt: now, updatedAt: now };
  const [byExternal] = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.externalId, c.externalId))).limit(1);
  if (byExternal) {
    await ctx.tx.update(schema.customers).set(values).where(eq(schema.customers.id, byExternal.id));
    return byExternal.id;
  }
  if (emailNormalized) {
    const [byEmail] = await ctx.tx.select({ id: schema.customers.id, externalId: schema.customers.externalId }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.emailNormalized, emailNormalized), sql`${schema.customers.externalId} is null`)).limit(1);
    if (byEmail) {
      await ctx.tx.update(schema.customers).set({ ...values, externalId: c.externalId }).where(eq(schema.customers.id, byEmail.id));
      return byEmail.id;
    }
  }
  const [row] = await ctx.tx.insert(schema.customers).values({ tenantId: ctx.tenantId, externalId: c.externalId, ...values }).onConflictDoUpdate({ target: [schema.customers.tenantId, schema.customers.externalId], set: values }).returning({ id: schema.customers.id });
  return row!.id;
}

/* ---------- orders ---------- */

const ORDER_DIFF_FIELDS = ["paymentStatus", "financialStatusRaw", "fulfillmentStatusRaw", "totalMinor", "refundedMinor", "cancelledAt", "platformTags", "note", "email", "phone"] as const;

async function loadCampaignRefs(ctx: ServiceContext): Promise<CampaignRef[]> {
  return ctx.tx.select({ id: schema.campaigns.id, externalId: schema.campaigns.externalId, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, ctx.tenantId));
}

/**
 * Idempotent upsert of a platform order into the canonical model. Local decisions
 * (manual status, assignment, hold, returns) are preserved; the canonical status is
 * recomputed afterwards by the single writer. Returns what happened for the sync log.
 */
export async function importOrder(ctx: ServiceContext, o: NormalizedOrder, opts: ImportOptions): Promise<ImportOutcome> {
  const now = ctx.now ?? new Date();
  const [existing] = await ctx.tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.externalId, o.externalId))).limit(1);
  if (existing && existing.platformUpdatedAt && existing.platformUpdatedAt.getTime() > o.platformUpdatedAt.getTime() && opts.source !== "reconcile") return { id: existing.id, outcome: "unchanged" };
  const customerId = o.customer ? await upsertCustomer(ctx, o.customer, opts.country) : existing?.customerId ?? null;
  const ship = o.shippingAddress;
  const values = {
    orderNumber: o.orderNumber,
    name: o.name,
    customerId,
    customerName: o.customerName,
    email: o.email,
    emailNormalized: normalizeEmail(o.email),
    phone: normalizePhone(o.phone ?? ship?.phone ?? null, ship?.country ?? opts.country) ?? o.phone,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    paymentGateways: o.paymentGateways,
    financialStatusRaw: o.financialStatusRaw,
    fulfillmentStatusRaw: o.fulfillmentStatusRaw,
    platformTags: o.tags.map((t) => t.toLowerCase()),
    currency: o.currency,
    subtotalMinor: o.subtotalMinor,
    discountMinor: o.discountMinor,
    shippingMinor: o.shippingMinor,
    taxMinor: o.taxMinor,
    totalMinor: o.totalMinor,
    refundedMinor: Math.max(existing?.refundedMinor ?? 0, o.refundedMinor),
    shippingAddress: ship,
    billingAddress: o.billingAddress,
    shippingCountry: ship?.country ?? null,
    shippingZip: ship?.zip ?? null,
    shippingCity: ship?.city ?? null,
    addressKey: addressKey(ship),
    nameZipKey: nameZipKey(ship?.name ?? o.customerName, ship?.zip),
    note: o.note,
    noteAttributes: o.noteAttributes,
    landingSite: o.landingSite,
    referringSite: o.referringSite,
    sourceChannel: o.sourceChannel,
    placedAt: o.placedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    closedAt: o.closedAt,
    platformUpdatedAt: o.platformUpdatedAt,
    syncedAt: now,
    updatedAt: now,
  };
  let orderId: string;
  let outcome: ImportOutcome["outcome"];
  if (existing) {
    orderId = existing.id;
    await ctx.tx.update(schema.orders).set(values).where(eq(schema.orders.id, orderId));
    const diff = diffRecords<Record<string, unknown>>(Object.fromEntries(ORDER_DIFF_FIELDS.map((f) => [f, existing[f]])), Object.fromEntries(ORDER_DIFF_FIELDS.map((f) => [f, values[f]])));
    outcome = hasChanges(diff) ? "updated" : "unchanged";
    if (outcome === "updated") await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "platform_update", actorType: "integration", actorUserId: null, diff, metadata: { source: opts.source }, createdAt: now });
  } else {
    const [row] = await ctx.tx.insert(schema.orders).values({ tenantId: ctx.tenantId, externalId: o.externalId, status: "new", statusSource: "rule", ...values }).returning({ id: schema.orders.id });
    orderId = row!.id;
    outcome = "created";
    await ctx.tx.insert(schema.orderEvents).values({ tenantId: ctx.tenantId, orderId, type: "imported", actorType: "integration", actorUserId: null, diff: {}, metadata: { source: opts.source, externalId: o.externalId }, createdAt: now });
  }

  // lines: match catalog by external ids, upsert by line external id
  const variantIds = o.lines.map((l) => l.variantExternalId).filter((v): v is string => Boolean(v));
  const variants = variantIds.length ? await ctx.tx.select({ id: schema.productVariants.id, externalId: schema.productVariants.externalId, productId: schema.productVariants.productId, costMinor: schema.productVariants.costMinor }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.externalId, variantIds))) : [];
  for (const l of o.lines) {
    const v = variants.find((x) => x.externalId === l.variantExternalId);
    const lineValues = { orderId, productId: v?.productId ?? null, variantId: v?.id ?? null, sku: l.sku, title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, currentQuantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor, discountMinor: l.discountMinor, totalMinor: l.totalMinor, isAncillary: false };
    await ctx.tx.insert(schema.orderLines).values({ tenantId: ctx.tenantId, externalId: l.externalId, unitCostMinor: v?.costMinor ?? null, ...lineValues }).onConflictDoUpdate({ target: [schema.orderLines.tenantId, schema.orderLines.externalId], set: lineValues });
  }
  // discounts: replace
  await ctx.tx.delete(schema.orderDiscounts).where(eq(schema.orderDiscounts.orderId, orderId));
  if (o.discounts.length) await ctx.tx.insert(schema.orderDiscounts).values(o.discounts.map((d) => ({ tenantId: ctx.tenantId, orderId, code: d.code, type: d.type, amountMinor: d.amountMinor })));
  // attribution
  const attribution = extractAttribution({ landingSite: o.landingSite, referringSite: o.referringSite, noteAttributes: o.noteAttributes });
  const campaigns = opts.campaigns ?? (await loadCampaignRefs(ctx));
  const campaign = matchCampaign(attribution, campaigns);
  const attrValues = { utmSource: attribution.utmSource, utmMedium: attribution.utmMedium, utmCampaign: attribution.utmCampaign, utmContent: attribution.utmContent, utmTerm: attribution.utmTerm, clickIds: attribution.clickIds, campaignId: campaign?.id ?? null, channel: deriveChannel(attribution, o.referringSite, o.sourceChannel), source: opts.source, capturedAt: now };
  await ctx.tx.insert(schema.orderAttribution).values({ tenantId: ctx.tenantId, orderId, ...attrValues }).onConflictDoUpdate({ target: [schema.orderAttribution.orderId], set: attrValues });
  // fulfillments → shipments with per-source state and resolver
  for (const f of o.fulfillments) await importFulfillment(ctx, orderId, f, now);
  await recomputeOrderStatus(ctx, orderId, { eventMetadata: { source: opts.source } });
  return { id: orderId, outcome };
}

async function importFulfillment(ctx: ServiceContext, orderId: string, f: NormalizedOrder["fulfillments"][number], now: Date): Promise<void> {
  const [existing] = await ctx.tx.select().from(schema.shipments).where(and(eq(schema.shipments.tenantId, ctx.tenantId), eq(schema.shipments.externalId, f.externalId))).limit(1);
  let shipmentId: string;
  if (existing) {
    shipmentId = existing.id;
    await ctx.tx.update(schema.shipments).set({ trackingNumber: f.trackingNumber ?? existing.trackingNumber, trackingUrl: f.trackingUrl ?? existing.trackingUrl, carrier: f.carrier ?? existing.carrier, shippedAt: existing.shippedAt ?? f.createdAt, deliveredAt: f.deliveredAt ?? existing.deliveredAt, lastEventAt: f.updatedAt, updatedAt: now }).where(eq(schema.shipments.id, shipmentId));
  } else {
    const [row] = await ctx.tx.insert(schema.shipments).values({ tenantId: ctx.tenantId, orderId, externalId: f.externalId, trackingNumber: f.trackingNumber, trackingUrl: f.trackingUrl, carrier: f.carrier, status: "pending", shippedAt: f.createdAt, deliveredAt: f.deliveredAt, lastEventAt: f.updatedAt }).returning({ id: schema.shipments.id });
    shipmentId = row!.id;
  }
  const [prevState] = await ctx.tx.select().from(schema.shipmentSourceStates).where(and(eq(schema.shipmentSourceStates.shipmentId, shipmentId), eq(schema.shipmentSourceStates.source, "shopify"))).limit(1);
  await ctx.tx.insert(schema.shipmentSourceStates).values({ tenantId: ctx.tenantId, shipmentId, source: "shopify", status: f.status, detail: null, externalStatus: f.externalStatus, lastEventAt: f.updatedAt, raw: {}, updatedAt: now }).onConflictDoUpdate({ target: [schema.shipmentSourceStates.shipmentId, schema.shipmentSourceStates.source], set: { status: f.status, externalStatus: f.externalStatus, lastEventAt: f.updatedAt, updatedAt: now } });
  if (!prevState || prevState.status !== f.status) await ctx.tx.insert(schema.shipmentEvents).values({ tenantId: ctx.tenantId, shipmentId, source: "shopify", status: f.status, description: f.externalStatus, location: null, occurredAt: f.updatedAt });
  const states = await ctx.tx.select({ source: schema.shipmentSourceStates.source, status: schema.shipmentSourceStates.status, lastEventAt: schema.shipmentSourceStates.lastEventAt }).from(schema.shipmentSourceStates).where(eq(schema.shipmentSourceStates.shipmentId, shipmentId));
  const resolved = resolveShipmentStatus({ states: states.map((s) => ({ source: s.source, status: s.status as ShipmentStatus, lastEventAt: s.lastEventAt ?? now })), previousStatus: (existing?.status as ShipmentStatus | undefined) ?? null, exceptionReason: existing?.exceptionReason ?? null, exceptionSince: existing?.exceptionSince ?? null, precedence: DEFAULT_PRECEDENCE, stickyExceptionDays: 15, now });
  await ctx.tx.update(schema.shipments).set({ status: resolved.status, sourceOfTruth: resolved.sourceOfTruth, exceptionReason: resolved.exceptionReason, exceptionSince: resolved.exceptionSince, deliveredAt: resolved.status === "delivered" ? (f.deliveredAt ?? existing?.deliveredAt ?? f.updatedAt) : (existing?.deliveredAt ?? f.deliveredAt) }).where(eq(schema.shipments.id, shipmentId));
}

/* ---------- catalog ---------- */

export async function importLocation(ctx: ServiceContext, l: NormalizedLocation): Promise<string> {
  const now = ctx.now ?? new Date();
  const values = { name: l.name, country: l.country, isDefault: l.isDefault, isActive: l.isActive, updatedAt: now };
  const [row] = await ctx.tx.insert(schema.locations).values({ tenantId: ctx.tenantId, externalId: l.externalId, ...values }).onConflictDoUpdate({ target: [schema.locations.tenantId, schema.locations.externalId], set: values }).returning({ id: schema.locations.id });
  return row!.id;
}

export async function importProduct(ctx: ServiceContext, p: NormalizedProduct): Promise<{ id: string; outcome: "created" | "updated" }> {
  const now = ctx.now ?? new Date();
  const values = { title: p.title, handle: p.handle, vendor: p.vendor, productType: p.productType, status: p.status, tags: p.tags, options: p.options, imageUrl: p.imageUrl, platformCreatedAt: p.platformCreatedAt, syncedAt: now, updatedAt: now };
  const [existing] = await ctx.tx.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.externalId, p.externalId))).limit(1);
  const [row] = await ctx.tx.insert(schema.products).values({ tenantId: ctx.tenantId, externalId: p.externalId, ...values }).onConflictDoUpdate({ target: [schema.products.tenantId, schema.products.externalId], set: values }).returning({ id: schema.products.id });
  const productId = row!.id;
  const keep: string[] = [];
  for (const v of p.variants) {
    const vv = { productId, inventoryItemExternalId: v.inventoryItemExternalId, sku: v.sku, barcode: v.barcode, title: v.title, optionValues: v.optionValues, priceMinor: v.priceMinor, compareAtMinor: v.compareAtMinor, weightGrams: v.weightGrams, isActive: true, syncedAt: now, updatedAt: now };
    const [vr] = await ctx.tx.insert(schema.productVariants).values({ tenantId: ctx.tenantId, externalId: v.externalId, ...vv }).onConflictDoUpdate({ target: [schema.productVariants.tenantId, schema.productVariants.externalId], set: vv }).returning({ id: schema.productVariants.id });
    keep.push(vr!.id);
  }
  if (keep.length) await ctx.tx.update(schema.productVariants).set({ isActive: false, updatedAt: now }).where(and(eq(schema.productVariants.productId, productId), sql`${schema.productVariants.id} <> all(${sql.param(keep)}::uuid[])`));
  return { id: productId, outcome: existing ? "updated" : "created" };
}

export async function importInventoryLevel(ctx: ServiceContext, lvl: NormalizedInventoryLevel): Promise<boolean> {
  const now = ctx.now ?? new Date();
  const [variant] = await ctx.tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.inventoryItemExternalId, lvl.inventoryItemExternalId))).limit(1);
  const [location] = await ctx.tx.select({ id: schema.locations.id }).from(schema.locations).where(and(eq(schema.locations.tenantId, ctx.tenantId), eq(schema.locations.externalId, lvl.locationExternalId))).limit(1);
  if (!variant || !location) return false;
  const values = { available: lvl.available, onHand: lvl.onHand ?? lvl.available, committed: lvl.committed ?? 0, syncedAt: lvl.updatedAt, updatedAt: now };
  await ctx.tx.insert(schema.inventoryLevels).values({ tenantId: ctx.tenantId, variantId: variant.id, locationId: location.id, ...values }).onConflictDoUpdate({ target: [schema.inventoryLevels.variantId, schema.inventoryLevels.locationId], set: values });
  return true;
}

export async function importDiscount(ctx: ServiceContext, d: NormalizedDiscount): Promise<void> {
  const now = ctx.now ?? new Date();
  const values = { externalId: d.externalId, title: d.title, type: d.type, value: d.value, minimumAmountMinor: d.minimumAmountMinor, usageLimit: d.usageLimit, usedCount: d.usedCount, startsAt: d.startsAt, endsAt: d.endsAt, isActive: d.isActive, syncedAt: now, updatedAt: now };
  await ctx.tx.insert(schema.discounts).values({ tenantId: ctx.tenantId, code: d.code, source: "platform", ...values }).onConflictDoUpdate({ target: [schema.discounts.tenantId, schema.discounts.code], set: values });
}

/* ---------- health ---------- */

export async function recordHealth(ctx: ServiceContext, source: string, ok: boolean, info: { error?: string | null; rowsWritten?: number; lastMetricDate?: string | null; freshnessMinutes?: number } = {}): Promise<void> {
  const now = ctx.now ?? new Date();
  const [prev] = await ctx.tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenantId), eq(schema.integrationHealth.source, source))).limit(1);
  const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const values = { status: ok ? "ok" : consecutiveFailures >= 3 ? "error" : "degraded", lastAttemptAt: now, lastSuccessAt: ok ? now : prev?.lastSuccessAt ?? null, lastMetricDate: info.lastMetricDate ?? prev?.lastMetricDate ?? null, consecutiveFailures, rowsWrittenLast: info.rowsWritten ?? (ok ? 0 : prev?.rowsWrittenLast ?? 0), freshnessMinutes: info.freshnessMinutes ?? prev?.freshnessMinutes ?? 60, lastError: ok ? null : info.error ?? prev?.lastError ?? null, updatedAt: now };
  await ctx.tx.insert(schema.integrationHealth).values({ tenantId: ctx.tenantId, source, ...values }).onConflictDoUpdate({ target: [schema.integrationHealth.tenantId, schema.integrationHealth.source], set: values });
  const provider = source.split(":")[0]!;
  await ctx.tx.update(schema.integrations).set(ok ? { lastSyncAt: now, lastSuccessAt: now, lastError: null, status: "connected", updatedAt: now } : { lastSyncAt: now, lastError: info.error ?? null, status: consecutiveFailures >= 3 ? "error" : "connected", updatedAt: now }).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, provider), sql`${schema.integrations.status} <> 'not_connected'`));
}

/* ---------- webhooks ---------- */

export async function recordWebhookEvent(ctx: ServiceContext, input: { source: string; topic: string; externalId: string; sourceUpdatedAt: string; payload: unknown }): Promise<{ id: string | null; duplicate: boolean }> {
  const [row] = await ctx.tx.insert(schema.webhookEvents).values({ tenantId: ctx.tenantId, source: input.source, topic: input.topic, externalId: input.externalId, sourceUpdatedAt: input.sourceUpdatedAt, payload: input.payload as Record<string, unknown>, status: "pending", receivedAt: ctx.now ?? new Date() }).onConflictDoNothing().returning({ id: schema.webhookEvents.id });
  return row ? { id: row.id, duplicate: false } : { id: null, duplicate: true };
}

export interface WebhookResult {
  status: "processed" | "failed" | "skipped";
  topic: string;
  error?: string;
}

/** Topic → handler dispatch; every handler is an idempotent upsert, so replays are safe. */
export async function processWebhookEvent(ctx: ServiceContext, platform: CommercePlatform, eventId: string, opts: { country: string }): Promise<WebhookResult> {
  const now = ctx.now ?? new Date();
  const [ev] = await ctx.tx.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.id, eventId))).limit(1);
  if (!ev) return { status: "skipped", topic: "unknown", error: "event_not_found" };
  if (ev.status === "processed") return { status: "skipped", topic: ev.topic };
  const payload = ev.payload as Record<string, unknown>;
  const topic = ev.topic;
  try {
    const family = topic.split("/")[0];
    if (family === "orders") {
      await importOrder(ctx, platform.parseWebhookOrder(payload), { country: opts.country, source: "webhook" });
    } else if (family === "fulfillments") {
      const orderExternalId = payload.__normalized ? null : String(payload.order_id ?? "");
      const order = payload.__normalized ? platform.parseWebhookOrder(payload) : orderExternalId ? await platform.fetchOrder(orderExternalId) : null;
      if (order) await importOrder(ctx, order, { country: opts.country, source: "webhook" });
    } else if (family === "products") {
      if (topic === "products/delete") await ctx.tx.update(schema.products).set({ status: "archived", updatedAt: now }).where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.externalId, String(payload.id))));
      else await importProduct(ctx, platform.parseWebhookProduct(payload));
    } else if (topic === "inventory_levels/update") {
      await importInventoryLevel(ctx, platform.parseWebhookInventoryLevel(payload));
    } else if (family === "customers") {
      const c = platform.parseWebhookCustomer(payload);
      if (c) await upsertCustomer(ctx, c, opts.country);
    } else if (topic === "app/uninstalled") {
      await ctx.tx.update(schema.integrations).set({ status: "not_connected", lastError: "App uninstalled from the store", credentialsEncrypted: null, updatedAt: now }).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, platform.provider)));
    }
    // returns/* and unknown topics are logged only in this version.
    await ctx.tx.update(schema.webhookEvents).set({ status: "processed", attempts: ev.attempts + 1, lastError: null, processedAt: now }).where(eq(schema.webhookEvents.id, ev.id));
    await recordHealth(ctx, `${ev.source}:webhooks`, true, { rowsWritten: 1, freshnessMinutes: 30 });
    return { status: "processed", topic };
  } catch (e) {
    const error = errMessage(e);
    await ctx.tx.update(schema.webhookEvents).set({ status: "failed", attempts: ev.attempts + 1, lastError: error }).where(eq(schema.webhookEvents.id, ev.id));
    await recordHealth(ctx, `${ev.source}:webhooks`, false, { error });
    return { status: "failed", topic, error };
  }
}

export async function retryFailedWebhooks(ctx: ServiceContext, platform: CommercePlatform, opts: { country: string; maxAttempts?: number; limit?: number }): Promise<{ retried: number; processed: number }> {
  const rows = await ctx.tx.select({ id: schema.webhookEvents.id }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.source, platform.provider), inArray(schema.webhookEvents.status, ["failed", "pending"]), sql`${schema.webhookEvents.attempts} < ${opts.maxAttempts ?? 5}`)).orderBy(schema.webhookEvents.receivedAt).limit(opts.limit ?? 50);
  let processed = 0;
  for (const r of rows) if ((await processWebhookEvent(ctx, platform, r.id, opts)).status === "processed") processed++;
  return { retried: rows.length, processed };
}

/* ---------- sync runs ---------- */

export type SyncKind = "initial" | "delta" | "reconcile";
interface OrdersCursor {
  nextCursor?: string | null;
  updatedSince?: string | null;
  createdSince?: string | null;
  highWaterMark?: string | null;
  pages?: number;
}

/**
 * Resumable orders sync: one `sync_runs` row per pass, cursor persisted after every page,
 * stops at the time budget and resumes on the next call from the saved cursor.
 * Delta uses the previous high-water mark minus a 2-minute overlap; initial walks everything.
 */
export async function runOrdersSync(ctx: ServiceContext, platform: CommercePlatform, opts: { kind: SyncKind; country: string; budgetMs?: number; pageSize?: number; reconcileDays?: number }): Promise<{ runId: string; rowsWritten: number; finished: boolean; error: string | null }> {
  const now = ctx.now ?? new Date();
  const budgetMs = opts.budgetMs ?? 20_000;
  const started = Date.now();
  const provider = platform.provider;
  const [paused] = await ctx.tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, "orders"), eq(schema.syncRuns.kind, opts.kind), eq(schema.syncRuns.status, "paused"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  let cursor: OrdersCursor;
  let runId: string;
  let rowsWritten = 0;
  if (paused) {
    runId = paused.id;
    cursor = paused.cursor as OrdersCursor;
    rowsWritten = paused.rowsWritten;
    await ctx.tx.update(schema.syncRuns).set({ status: "running" }).where(eq(schema.syncRuns.id, runId));
  } else {
    const [last] = await ctx.tx.select({ cursor: schema.syncRuns.cursor }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, "orders"), eq(schema.syncRuns.status, "success"))).orderBy(desc(schema.syncRuns.finishedAt)).limit(1);
    const hwm = (last?.cursor as OrdersCursor | undefined)?.highWaterMark ?? null;
    cursor = opts.kind === "delta" ? { nextCursor: null, updatedSince: hwm ? new Date(new Date(hwm).getTime() - 120_000).toISOString() : new Date(now.getTime() - 30 * 864e5).toISOString(), highWaterMark: hwm, pages: 0 } : opts.kind === "reconcile" ? { nextCursor: null, createdSince: new Date(now.getTime() - (opts.reconcileDays ?? 35) * 864e5).toISOString(), highWaterMark: hwm, pages: 0 } : { nextCursor: null, highWaterMark: null, pages: 0 };
    const [run] = await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider, objectType: "orders", kind: opts.kind, status: "running", cursor, startedAt: now }).returning({ id: schema.syncRuns.id });
    runId = run!.id;
  }
  const campaigns = await loadCampaignRefs(ctx);
  let maxUpdated = cursor.highWaterMark ? new Date(cursor.highWaterMark) : null;
  try {
    for (;;) {
      const page = await platform.fetchOrders({ cursor: cursor.nextCursor ?? null, updatedSince: cursor.updatedSince ? new Date(cursor.updatedSince) : null, createdSince: cursor.createdSince ? new Date(cursor.createdSince) : null, limit: opts.pageSize ?? 50 });
      for (const o of page.items) {
        const r = await importOrder(ctx, o, { country: opts.country, source: opts.kind === "reconcile" ? "reconcile" : opts.kind === "initial" ? "backfill" : "sync", campaigns });
        if (r.outcome !== "unchanged") rowsWritten++;
        if (!maxUpdated || o.platformUpdatedAt > maxUpdated) maxUpdated = o.platformUpdatedAt;
      }
      cursor = { ...cursor, nextCursor: page.nextCursor, highWaterMark: maxUpdated?.toISOString() ?? cursor.highWaterMark ?? null, pages: (cursor.pages ?? 0) + 1 };
      if (!page.nextCursor) {
        await ctx.tx.update(schema.syncRuns).set({ status: "success", cursor: { ...cursor, nextCursor: null }, rowsWritten, finishedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
        await recordHealth(ctx, provider, true, { rowsWritten, freshnessMinutes: 30 });
        return { runId, rowsWritten, finished: true, error: null };
      }
      await ctx.tx.update(schema.syncRuns).set({ cursor, rowsWritten }).where(eq(schema.syncRuns.id, runId));
      if (Date.now() - started > budgetMs) {
        await ctx.tx.update(schema.syncRuns).set({ status: "paused", cursor, rowsWritten }).where(eq(schema.syncRuns.id, runId));
        return { runId, rowsWritten, finished: false, error: null };
      }
    }
  } catch (e) {
    const error = errMessage(e);
    await ctx.tx.update(schema.syncRuns).set({ status: "error", error, cursor, rowsWritten, finishedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
    await recordHealth(ctx, provider, false, { error, rowsWritten });
    return { runId, rowsWritten, finished: false, error };
  }
}

/** Locations, products (+variants), inventory levels and discounts; one run row per object type. */
export async function runCatalogSync(ctx: ServiceContext, platform: CommercePlatform): Promise<{ products: number; inventory: number; discounts: number; error: string | null }> {
  const now = ctx.now ?? new Date();
  const provider = platform.provider;
  const runRow = async (objectType: string) => (await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider, objectType, kind: "delta", status: "running", startedAt: now }).returning({ id: schema.syncRuns.id }))[0]!.id;
  const finish = (id: string, rows: number, error: string | null) => ctx.tx.update(schema.syncRuns).set({ status: error ? "error" : "success", rowsWritten: rows, error, finishedAt: new Date() }).where(eq(schema.syncRuns.id, id));
  let products = 0;
  let inventory = 0;
  let discounts = 0;
  const run = await runRow("catalog");
  try {
    for (const l of await platform.fetchLocations()) await importLocation(ctx, l);
    let cursor: string | null = null;
    do {
      const page = await platform.fetchProducts({ cursor, limit: 50 });
      for (const p of page.items) {
        await importProduct(ctx, p);
        products++;
      }
      cursor = page.nextCursor;
    } while (cursor);
    const items = (await ctx.tx.select({ inv: schema.productVariants.inventoryItemExternalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.isActive, true), sql`${schema.productVariants.inventoryItemExternalId} is not null`))).map((r) => r.inv!);
    for (let i = 0; i < items.length; i += 100) for (const lvl of await platform.fetchInventoryLevels(items.slice(i, i + 100))) if (await importInventoryLevel(ctx, lvl)) inventory++;
    let dc: string | null = null;
    do {
      const page = await platform.fetchDiscounts({ cursor: dc, limit: 100 });
      for (const d of page.items) {
        await importDiscount(ctx, d);
        discounts++;
      }
      dc = page.nextCursor;
    } while (dc);
    await finish(run, products + inventory + discounts, null);
    await recordHealth(ctx, `${provider}:catalog`, true, { rowsWritten: products + inventory + discounts, freshnessMinutes: 24 * 60 });
    return { products, inventory, discounts, error: null };
  } catch (e) {
    const error = errMessage(e);
    await finish(run, products + inventory + discounts, error);
    await recordHealth(ctx, `${provider}:catalog`, false, { error });
    return { products, inventory, discounts, error };
  }
}

/** Campaigns and daily metrics for a window; metrics are upserted per (campaign, day) so re-runs are idempotent. */
export async function runAdsSync(ctx: ServiceContext, platform: AdsPlatform, window: { since: string; until: string }): Promise<{ campaigns: number; metrics: number; error: string | null }> {
  const now = ctx.now ?? new Date();
  const provider = platform.provider;
  const [run] = await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider, objectType: "metrics", kind: "delta", status: "running", cursor: window, startedAt: now }).returning({ id: schema.syncRuns.id });
  let campaigns = 0;
  let metrics = 0;
  try {
    const remote = await platform.fetchCampaigns();
    const idByExternal = new Map<string, string>();
    for (const c of remote) {
      const values = { accountExternalId: c.accountExternalId, name: c.name, status: c.status, objective: c.objective, dailyBudgetMinor: c.dailyBudgetMinor, currency: c.currency, platformCreatedAt: c.platformCreatedAt, syncedAt: now, updatedAt: now };
      const [row] = await ctx.tx.insert(schema.campaigns).values({ tenantId: ctx.tenantId, platform: provider, externalId: c.externalId, ...values }).onConflictDoUpdate({ target: [schema.campaigns.tenantId, schema.campaigns.platform, schema.campaigns.externalId], set: values }).returning({ id: schema.campaigns.id });
      idByExternal.set(c.externalId, row!.id);
      campaigns++;
    }
    const rows = await platform.fetchDailyMetrics(window);
    let lastDate: string | null = null;
    for (const m of rows) {
      const campaignId = idByExternal.get(m.campaignExternalId);
      if (!campaignId) continue;
      const values = { spendMinor: m.spendMinor, impressions: m.impressions, clicks: m.clicks, viewContent: m.viewContent, purchases: m.purchases, purchaseValueMinor: m.purchaseValueMinor };
      await ctx.tx.insert(schema.adMetricsDaily).values({ tenantId: ctx.tenantId, campaignId, date: m.date, ...values }).onConflictDoUpdate({ target: [schema.adMetricsDaily.campaignId, schema.adMetricsDaily.date], set: values });
      metrics++;
      if (!lastDate || m.date > lastDate) lastDate = m.date;
    }
    await ctx.tx.update(schema.syncRuns).set({ status: "success", rowsWritten: campaigns + metrics, finishedAt: new Date() }).where(eq(schema.syncRuns.id, run!.id));
    await recordHealth(ctx, provider, true, { rowsWritten: metrics, lastMetricDate: lastDate, freshnessMinutes: provider === "google" ? 720 : 120 });
    return { campaigns, metrics, error: null };
  } catch (e) {
    const error = errMessage(e);
    await ctx.tx.update(schema.syncRuns).set({ status: "error", error, rowsWritten: campaigns + metrics, finishedAt: new Date() }).where(eq(schema.syncRuns.id, run!.id));
    await recordHealth(ctx, provider, false, { error });
    return { campaigns, metrics, error };
  }
}

/* ---------- overview for the integrations page ---------- */

export async function integrationOverview(ctx: ServiceContext) {
  const integrations = await ctx.tx.select().from(schema.integrations).where(eq(schema.integrations.tenantId, ctx.tenantId)).orderBy(schema.integrations.provider);
  const health = await ctx.tx.select().from(schema.integrationHealth).where(eq(schema.integrationHealth.tenantId, ctx.tenantId)).orderBy(schema.integrationHealth.source);
  const runs = await ctx.tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.tenantId, ctx.tenantId)).orderBy(desc(schema.syncRuns.startedAt)).limit(25);
  const webhooks = await ctx.tx.select({ id: schema.webhookEvents.id, source: schema.webhookEvents.source, topic: schema.webhookEvents.topic, externalId: schema.webhookEvents.externalId, status: schema.webhookEvents.status, attempts: schema.webhookEvents.attempts, lastError: schema.webhookEvents.lastError, receivedAt: schema.webhookEvents.receivedAt, processedAt: schema.webhookEvents.processedAt }).from(schema.webhookEvents).where(eq(schema.webhookEvents.tenantId, ctx.tenantId)).orderBy(desc(schema.webhookEvents.receivedAt)).limit(30);
  const [counts] = await ctx.tx.select({ failed: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'failed')::int`, pending: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'pending')::int`, processed24h: sql<number>`count(*) filter (where ${schema.webhookEvents.status} = 'processed' and ${schema.webhookEvents.processedAt} > now() - interval '24 hours')::int` }).from(schema.webhookEvents).where(eq(schema.webhookEvents.tenantId, ctx.tenantId));
  return { integrations, health, runs, webhooks, webhookCounts: counts ?? { failed: 0, pending: 0, processed24h: 0 } };
}
