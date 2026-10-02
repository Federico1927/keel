import { and, desc, eq, inArray, lte, schema, sql } from "@hullwise/db";
import { SALE_STATUSES } from "@hullwise/core";
import { CONVERSION_PROVIDERS, fbcFromClickId, hashUserData, type ConversionEvent, type ConversionProvider, type ConversionSink } from "@hullwise/integrations";
import type { ServiceContext } from "../context";

const SALE = SALE_STATUSES as readonly string[];
const MAX_ATTEMPTS = 6;
const BATCH = 200;

export interface ConversionSettingsView {
  provider: ConversionProvider;
  enabled: boolean;
  destinationId: string | null;
  testEventCode: string | null;
  requireConsent: boolean;
  lookbackDays: number;
}

const DEFAULTS = (provider: ConversionProvider): ConversionSettingsView => ({ provider, enabled: false, destinationId: null, testEventCode: null, requireConsent: true, lookbackDays: provider === "meta" ? 7 : 30 });

export async function getConversionSettings(ctx: ServiceContext): Promise<ConversionSettingsView[]> {
  const rows = await ctx.tx.select().from(schema.conversionSettings).where(eq(schema.conversionSettings.tenantId, ctx.tenantId));
  return CONVERSION_PROVIDERS.map((p) => {
    const r = rows.find((x) => x.provider === p);
    return r ? { provider: p, enabled: r.enabled, destinationId: r.destinationId, testEventCode: r.testEventCode, requireConsent: r.requireConsent, lookbackDays: r.lookbackDays } : DEFAULTS(p);
  });
}

export async function saveConversionSettings(ctx: ServiceContext, input: ConversionSettingsView): Promise<void> {
  // Meta drops events older than 7 days; Google click conversions are accepted for 90
  const max = input.provider === "meta" ? 7 : 90;
  const values = { enabled: input.enabled, destinationId: input.destinationId?.trim() || null, testEventCode: input.testEventCode?.trim() || null, requireConsent: input.requireConsent, lookbackDays: Math.min(max, Math.max(1, Math.round(input.lookbackDays))), updatedAt: new Date() };
  await ctx.tx.insert(schema.conversionSettings).values({ tenantId: ctx.tenantId, provider: input.provider, ...values }).onConflictDoUpdate({ target: [schema.conversionSettings.tenantId, schema.conversionSettings.provider], set: values });
}

export const conversionEventId = (orderExternalId: string | null, orderId: string) => `order-${orderExternalId ?? orderId}`;

/**
 * Queues every sale-scope order inside the lookback that has no row yet for the platform. Orders
 * of customers without marketing consent are logged as skipped when the store requires consent,
 * so the decision is visible and never revisited.
 */
export async function enqueueConversions(ctx: ServiceContext): Promise<{ queued: number; skipped: number }> {
  const now = ctx.now ?? new Date();
  let queued = 0;
  let skipped = 0;
  for (const s of await getConversionSettings(ctx)) {
    if (!s.enabled) continue;
    const since = new Date(now.getTime() - s.lookbackDays * 864e5);
    const rows = await ctx.tx.execute<{ id: string; external_id: string | null; accepts: boolean | null }>(sql`
      select o.id, o.external_id, c.accepts_marketing as accepts from orders o left join customers c on c.id = o.customer_id
      where o.tenant_id = ${ctx.tenantId} and o.placed_at >= ${since} and o.status in ${SALE}
        and not exists (select 1 from conversion_events ce where ce.tenant_id = ${ctx.tenantId} and ce.provider = ${s.provider} and ce.order_id = o.id)
      order by o.placed_at limit 2000`);
    const values = rows.rows.map((r) => {
      const consent = !s.requireConsent || r.accepts === true;
      if (consent) queued++;
      else skipped++;
      return { tenantId: ctx.tenantId, provider: s.provider, orderId: r.id, eventId: conversionEventId(r.external_id, r.id), status: consent ? "pending" : "skipped", reason: consent ? null : "no_consent", nextAttemptAt: consent ? now : null };
    });
    for (let i = 0; i < values.length; i += 500) await ctx.tx.insert(schema.conversionEvents).values(values.slice(i, i + 500)).onConflictDoNothing();
  }
  return { queued, skipped };
}

type OrderRow = {
  id: string; external_id: string | null; placed_at: string | Date; total_minor: number; currency: string; customer_id: string | null;
  email: string | null; phone_e164: string | null; first_name: string | null; last_name: string | null; shipping_city: string | null; shipping_zip: string | null; shipping_country: string | null;
  click_ids: Record<string, string> | null; px_ip: string | null; px_ua: string | null; px_url: string | null; px_props: Record<string, string> | null;
};

/** Builds platform-neutral events: hashed customer fields, click ids from the order, browser data from the pixel's checkout event. */
export async function buildConversionEvents(ctx: ServiceContext, orderIds: string[]): Promise<Map<string, ConversionEvent>> {
  if (!orderIds.length) return new Map();
  const rows = await ctx.tx.execute<OrderRow>(sql`
    select o.id, o.external_id, o.placed_at, o.total_minor, o.currency, o.customer_id, coalesce(o.email, c.email) as email, coalesce(o.phone_e164, c.phone_e164) as phone_e164,
      c.first_name, c.last_name, o.shipping_city, o.shipping_zip, o.shipping_country, a.click_ids,
      px.client_ip as px_ip, px.user_agent as px_ua, px.url as px_url, px.props as px_props
    from orders o
    left join customers c on c.id = o.customer_id
    left join order_attribution a on a.order_id = o.id
    left join lateral (
      select e.client_ip, e.user_agent, e.url, e.props from pixel_events e
      where e.tenant_id = o.tenant_id and e.event = 'checkout_completed' and e.props->>'orderId' = o.external_id
      order by e.occurred_at desc limit 1
    ) px on true
    where o.tenant_id = ${ctx.tenantId} and o.id = any(${sql.param(orderIds)}::uuid[])`);
  const out = new Map<string, ConversionEvent>();
  for (const r of rows.rows) {
    const placedAt = new Date(r.placed_at);
    const clicks = r.click_ids ?? {};
    const fbc = r.px_props?.fbc ?? (clicks.fbclid ? fbcFromClickId(clicks.fbclid, placedAt) : null);
    out.set(r.id, {
      eventId: conversionEventId(r.external_id, r.id),
      eventName: "Purchase",
      eventTime: placedAt,
      orderExternalId: r.external_id ?? r.id,
      valueMinor: Number(r.total_minor),
      currency: r.currency,
      user: hashUserData({ email: r.email, phoneE164: r.phone_e164, firstName: r.first_name, lastName: r.last_name, city: r.shipping_city, zip: r.shipping_zip, country: r.shipping_country, externalId: r.customer_id }),
      clickIds: { fbclid: clicks.fbclid, gclid: clicks.gclid, gbraid: clicks.gbraid, wbraid: clicks.wbraid },
      fbp: r.px_props?.fbp ?? null,
      fbc,
      clientIp: r.px_ip,
      userAgent: r.px_ua,
      sourceUrl: r.px_url,
    });
  }
  return out;
}

export interface SendSummary {
  provider: ConversionProvider;
  sent: number;
  failed: number;
  skipped: number;
}

/** Sends due events per platform in batches; a failed batch backs off exponentially, up to six attempts. */
export async function sendDueConversions(ctx: ServiceContext, sinkFor: (provider: ConversionProvider, settings: ConversionSettingsView) => ConversionSink | Promise<ConversionSink>): Promise<SendSummary[]> {
  const now = ctx.now ?? new Date();
  const out: SendSummary[] = [];
  for (const s of await getConversionSettings(ctx)) {
    if (!s.enabled) continue;
    const due = await ctx.tx.select().from(schema.conversionEvents).where(and(eq(schema.conversionEvents.tenantId, ctx.tenantId), eq(schema.conversionEvents.provider, s.provider), inArray(schema.conversionEvents.status, ["pending", "failed"]), lte(schema.conversionEvents.nextAttemptAt, now))).orderBy(schema.conversionEvents.createdAt).limit(BATCH);
    const summary: SendSummary = { provider: s.provider, sent: 0, failed: 0, skipped: 0 };
    if (!due.length) {
      out.push(summary);
      continue;
    }
    const events = await buildConversionEvents(ctx, due.map((d) => d.orderId));
    const batch = due.filter((d) => events.has(d.orderId));
    const sink = await sinkFor(s.provider, s);
    const fail = async (rowIds: string[], error: string) => {
      for (const d of batch.filter((x) => rowIds.includes(x.id))) {
        const attempts = d.attempts + 1;
        await ctx.tx.update(schema.conversionEvents).set({ status: "failed", attempts, lastError: error.slice(0, 300), nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 5 * 60_000 * 2 ** (attempts - 1)) }).where(eq(schema.conversionEvents.id, d.id));
        summary.failed++;
      }
    };
    try {
      const results = await sink.send(batch.map((d) => events.get(d.orderId)!));
      const byEvent = new Map(results.map((r) => [r.eventId, r]));
      for (const d of batch) {
        const r = byEvent.get(d.eventId);
        const payload = events.get(d.orderId)!;
        if (r?.ok) {
          await ctx.tx.update(schema.conversionEvents).set({ status: "sent", attempts: d.attempts + 1, sentAt: now, lastError: null, nextAttemptAt: null, payload: { ...payload, eventTime: payload.eventTime.toISOString() } }).where(eq(schema.conversionEvents.id, d.id));
          summary.sent++;
        } else if (r?.skipped) {
          await ctx.tx.update(schema.conversionEvents).set({ status: "skipped", reason: "no_identifier", nextAttemptAt: null, lastError: r.error ?? null }).where(eq(schema.conversionEvents.id, d.id));
          summary.skipped++;
        } else {
          await fail([d.id], r?.error ?? "no result");
        }
      }
    } catch (e) {
      await fail(batch.map((d) => d.id), e instanceof Error ? e.message : String(e));
    }
    out.push(summary);
  }
  return out;
}

/** Puts failed events back in the queue now (after fixing credentials, for instance). */
export async function retryFailedConversions(ctx: ServiceContext, provider: ConversionProvider): Promise<number> {
  const now = ctx.now ?? new Date();
  const rows = await ctx.tx.update(schema.conversionEvents).set({ status: "pending", attempts: 0, nextAttemptAt: now }).where(and(eq(schema.conversionEvents.tenantId, ctx.tenantId), eq(schema.conversionEvents.provider, provider), eq(schema.conversionEvents.status, "failed"))).returning({ id: schema.conversionEvents.id });
  return rows.length;
}

export interface ConversionStats {
  provider: ConversionProvider;
  sent: number;
  failed: number;
  pending: number;
  skippedConsent: number;
  skippedIdentifier: number;
  lastSentAt: Date | null;
}

export async function conversionStats(ctx: ServiceContext, days = 7): Promise<ConversionStats[]> {
  const since = new Date((ctx.now ?? new Date()).getTime() - days * 864e5);
  const rows = await ctx.tx.execute<{ provider: string; sent: number; failed: number; pending: number; consent: number; ident: number; last: string | null }>(sql`
    select provider, count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'skipped' and reason = 'no_consent')::int as consent, count(*) filter (where status = 'skipped' and reason = 'no_identifier')::int as ident, max(sent_at) as last
    from conversion_events where tenant_id = ${ctx.tenantId} and created_at >= ${since} group by provider`);
  return CONVERSION_PROVIDERS.map((p) => {
    const r = rows.rows.find((x) => x.provider === p);
    return { provider: p, sent: r?.sent ?? 0, failed: r?.failed ?? 0, pending: r?.pending ?? 0, skippedConsent: r?.consent ?? 0, skippedIdentifier: r?.ident ?? 0, lastSentAt: r?.last ? new Date(r.last) : null };
  });
}

export async function conversionLog(ctx: ServiceContext, limit = 30) {
  return ctx.tx
    .select({ id: schema.conversionEvents.id, provider: schema.conversionEvents.provider, eventId: schema.conversionEvents.eventId, status: schema.conversionEvents.status, reason: schema.conversionEvents.reason, attempts: schema.conversionEvents.attempts, lastError: schema.conversionEvents.lastError, sentAt: schema.conversionEvents.sentAt, createdAt: schema.conversionEvents.createdAt, orderId: schema.conversionEvents.orderId, orderName: schema.orders.name })
    .from(schema.conversionEvents)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.conversionEvents.orderId))
    .where(eq(schema.conversionEvents.tenantId, ctx.tenantId))
    .orderBy(desc(schema.conversionEvents.createdAt))
    .limit(limit);
}
