import { and, desc, eq, inArray, lte, schema, sql } from "@hullwise/db";
import { SALE_STATUSES, adjustmentEventId, decideConversionAdjustment, purchaseStillDue, type ConversionAdjustmentKind, type ConversionKind, type OrderConversionFacts } from "@hullwise/core";
import { CONVERSION_ADJUSTMENT_SUPPORT, CONVERSION_PROVIDERS, fbcFromClickId, hashUserData, type ConversionAdjustment, type ConversionEvent, type ConversionProvider, type ConversionResult, type ConversionSink } from "@hullwise/integrations";
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
        and not exists (select 1 from conversion_events ce where ce.tenant_id = ${ctx.tenantId} and ce.provider = ${s.provider} and ce.order_id = o.id and ce.kind = 'purchase')
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

type DueRow = typeof schema.conversionEvents.$inferSelect;
const backoff = (now: Date, attempts: number) => (attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 5 * 60_000 * 2 ** (attempts - 1)));

/**
 * Sends due rows per platform in batches: purchases through `send`, retractions and restatements
 * through `adjust` (#82). A purchase whose order stopped being a sale before it left is skipped
 * (`withdrawn`); a failed batch backs off exponentially, up to six attempts.
 */
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
    const facts = await orderFacts(ctx, [...new Set(due.map((d) => d.orderId))]);
    const purchases: DueRow[] = [];
    const adjustments: DueRow[] = [];
    for (const d of due) {
      const f = facts.get(d.orderId);
      if (d.kind === "purchase" && f && !purchaseStillDue(f)) {
        await ctx.tx.update(schema.conversionEvents).set({ status: "skipped", reason: "withdrawn", nextAttemptAt: null }).where(eq(schema.conversionEvents.id, d.id));
        summary.skipped++;
      } else (d.kind === "purchase" ? purchases : adjustments).push(d);
    }
    const events = await buildConversionEvents(ctx, purchases.map((d) => d.orderId));
    const batch = purchases.filter((d) => events.has(d.orderId));
    const adjBatch = await buildAdjustments(ctx, adjustments, now);
    if (!batch.length && !adjBatch.length) {
      out.push(summary);
      continue;
    }
    const sink = await sinkFor(s.provider, s);
    const fail = async (rows: DueRow[], error: string) => {
      for (const d of rows) {
        const attempts = d.attempts + 1;
        await ctx.tx.update(schema.conversionEvents).set({ status: "failed", attempts, lastError: error.slice(0, 300), nextAttemptAt: backoff(now, attempts) }).where(eq(schema.conversionEvents.id, d.id));
        summary.failed++;
      }
    };
    const record = async (rows: DueRow[], results: ConversionResult[], payloadOf: (d: DueRow) => Record<string, unknown>) => {
      const byEvent = new Map(results.map((r) => [r.eventId, r]));
      for (const d of rows) {
        const r = byEvent.get(d.eventId);
        if (r?.ok) {
          await ctx.tx.update(schema.conversionEvents).set({ status: "sent", attempts: d.attempts + 1, sentAt: now, lastError: null, nextAttemptAt: null, payload: payloadOf(d) }).where(eq(schema.conversionEvents.id, d.id));
          summary.sent++;
        } else if (r?.skipped) {
          await ctx.tx.update(schema.conversionEvents).set({ status: "skipped", reason: d.kind === "purchase" ? "no_identifier" : "unsupported", nextAttemptAt: null, lastError: r.error ?? null }).where(eq(schema.conversionEvents.id, d.id));
          summary.skipped++;
        } else {
          await fail([d], r?.error ?? "no result");
        }
      }
    };
    if (batch.length) {
      try {
        const results = await sink.send(batch.map((d) => events.get(d.orderId)!));
        await record(batch, results, (d) => {
          const e = events.get(d.orderId)!;
          return { ...e, eventTime: e.eventTime.toISOString() };
        });
      } catch (e) {
        await fail(batch, e instanceof Error ? e.message : String(e));
      }
    }
    if (adjBatch.length) {
      const rows = adjBatch.map((a) => a.row);
      if (!sink.adjust) {
        // the platform has no adjustment mechanism (Meta): logged, never retried
        await record(rows, rows.map((d) => ({ eventId: d.eventId, ok: false, skipped: true, error: "unsupported" })), () => ({}));
      } else {
        try {
          const results = await sink.adjust(adjBatch.map((a) => a.adjustment));
          const byRow = new Map(adjBatch.map((a) => [a.row.id, a.adjustment]));
          await record(rows, results, (d) => {
            const a = byRow.get(d.id)!;
            return { ...a, conversionTime: a.conversionTime.toISOString(), adjustedAt: a.adjustedAt.toISOString() };
          });
        } catch (e) {
          await fail(rows, e instanceof Error ? e.message : String(e));
        }
      }
    }
    out.push(summary);
  }
  return out;
}

/* ---------- retractions and restatements (#82) ---------- */

async function orderFacts(ctx: ServiceContext, orderIds: string[]): Promise<Map<string, OrderConversionFacts & { externalId: string | null; currency: string; placedAt: Date }>> {
  if (!orderIds.length) return new Map();
  const rows = await ctx.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId, status: schema.orders.status, cancelledAt: schema.orders.cancelledAt, paymentStatus: schema.orders.paymentStatus, totalMinor: schema.orders.totalMinor, refundedMinor: schema.orders.refundedMinor, currency: schema.orders.currency, placedAt: schema.orders.placedAt }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.id, orderIds)));
  return new Map(rows.map((r) => [r.id, { status: r.status, cancelled: r.cancelledAt !== null, paymentStatus: r.paymentStatus, totalMinor: r.totalMinor, refundedMinor: r.refundedMinor, externalId: r.externalId, currency: r.currency, placedAt: r.placedAt }]));
}

/** Adjustment requests for due rows: the order id and time the purchase was sent with, and the click ids. */
async function buildAdjustments(ctx: ServiceContext, rows: DueRow[], now: Date): Promise<{ row: DueRow; adjustment: ConversionAdjustment }[]> {
  if (!rows.length) return [];
  const orderIds = [...new Set(rows.map((r) => r.orderId))];
  const purchases = await ctx.tx.select({ orderId: schema.conversionEvents.orderId, provider: schema.conversionEvents.provider, payload: schema.conversionEvents.payload }).from(schema.conversionEvents).where(and(eq(schema.conversionEvents.tenantId, ctx.tenantId), eq(schema.conversionEvents.kind, "purchase"), inArray(schema.conversionEvents.orderId, orderIds)));
  const facts = await orderFacts(ctx, orderIds);
  const clicks = new Map((await ctx.tx.select({ orderId: schema.orderAttribution.orderId, clickIds: schema.orderAttribution.clickIds }).from(schema.orderAttribution).where(and(eq(schema.orderAttribution.tenantId, ctx.tenantId), inArray(schema.orderAttribution.orderId, orderIds)))).map((c) => [c.orderId, (c.clickIds ?? {}) as Record<string, string>]));
  return rows.flatMap((row) => {
    const f = facts.get(row.orderId);
    if (!f) return [];
    const sent = purchases.find((p) => p.orderId === row.orderId && p.provider === row.provider)?.payload as { orderExternalId?: string; eventTime?: string; currency?: string } | null | undefined;
    const c = clicks.get(row.orderId) ?? {};
    return [{ row, adjustment: { eventId: row.eventId, kind: row.kind as ConversionAdjustmentKind, orderExternalId: sent?.orderExternalId ?? f.externalId ?? row.orderId, conversionTime: sent?.eventTime ? new Date(sent.eventTime) : f.placedAt, adjustedAt: now, valueMinor: row.valueMinor, currency: sent?.currency ?? f.currency, clickIds: { gclid: c.gclid, gbraid: c.gbraid, wbraid: c.wbraid } } }];
  });
}

export interface AdjustmentQueueResult {
  retractions: number;
  restatements: number;
  /** Logged without a call: the platform has no such mechanism. */
  unsupported: number;
}

/**
 * Called by the order paths that cancel or refund (status recompute, platform import, refunds, returns)
 * and by the safety re-check: for every platform that received the order's purchase, queue the
 * retraction or restatement it now needs (`decideConversionAdjustment`). Idempotent: one row per
 * (order, platform, kind), a retraction is final, a restatement is re-armed only when its value changes.
 */
export async function queueConversionAdjustments(ctx: ServiceContext, orderIds: string[]): Promise<AdjustmentQueueResult> {
  const out: AdjustmentQueueResult = { retractions: 0, restatements: 0, unsupported: 0 };
  if (!orderIds.length) return out;
  const rows = await ctx.tx.select({ id: schema.conversionEvents.id, orderId: schema.conversionEvents.orderId, provider: schema.conversionEvents.provider, kind: schema.conversionEvents.kind, eventId: schema.conversionEvents.eventId, status: schema.conversionEvents.status, valueMinor: schema.conversionEvents.valueMinor, payload: schema.conversionEvents.payload }).from(schema.conversionEvents).where(and(eq(schema.conversionEvents.tenantId, ctx.tenantId), inArray(schema.conversionEvents.orderId, [...new Set(orderIds)])));
  const sentPurchases = rows.filter((r) => r.kind === "purchase" && r.status === "sent");
  if (!sentPurchases.length) return out;
  const now = ctx.now ?? new Date();
  const facts = await orderFacts(ctx, [...new Set(sentPurchases.map((r) => r.orderId))]);
  for (const p of sentPurchases) {
    const f = facts.get(p.orderId);
    if (!f) continue;
    const provider = p.provider as ConversionProvider;
    const mine = rows.filter((r) => r.orderId === p.orderId && r.provider === p.provider);
    const restatement = mine.find((r) => r.kind === "restatement");
    const decision = decideConversionAdjustment({
      purchase: { status: p.status, valueMinor: (p.payload as { valueMinor?: number } | null)?.valueMinor ?? null },
      order: f,
      retracted: mine.some((r) => r.kind === "retraction"),
      restatedValueMinor: restatement?.valueMinor ?? null,
      support: CONVERSION_ADJUSTMENT_SUPPORT[provider] ?? { retraction: false, restatement: false },
    });
    if (decision.kind === "none") continue;
    const kind: ConversionKind = decision.kind;
    const status = decision.send ? "pending" : "skipped";
    const values = { status, reason: decision.reason, valueMinor: decision.kind === "restatement" ? decision.valueMinor : null, attempts: 0, nextAttemptAt: decision.send ? now : null, lastError: null, sentAt: null, payload: null };
    await ctx.tx.insert(schema.conversionEvents).values({ tenantId: ctx.tenantId, provider, orderId: p.orderId, eventId: adjustmentEventId(p.eventId, decision.kind), kind, ...values }).onConflictDoUpdate({ target: [schema.conversionEvents.tenantId, schema.conversionEvents.provider, schema.conversionEvents.eventId], set: values });
    // a retraction makes a restatement still waiting pointless
    if (decision.kind === "retraction" && restatement && (restatement.status === "pending" || restatement.status === "failed")) await ctx.tx.update(schema.conversionEvents).set({ status: "skipped", reason: "superseded", nextAttemptAt: null }).where(eq(schema.conversionEvents.id, restatement.id));
    if (!decision.send) out.unsupported++;
    else if (decision.kind === "retraction") out.retractions++;
    else out.restatements++;
  }
  return out;
}

/**
 * Safety net on the conversions tick: purchases sent in the last `days` whose order is now cancelled,
 * returned or refunded (in part or in full) are passed through `queueConversionAdjustments`, in case
 * an order path missed the hook. Nothing is queued twice.
 */
export async function recheckConversionAdjustments(ctx: ServiceContext, opts: { days?: number } = {}): Promise<AdjustmentQueueResult> {
  const since = new Date((ctx.now ?? new Date()).getTime() - (opts.days ?? 90) * 864e5);
  const rows = await ctx.tx.execute<{ order_id: string }>(sql`
    select distinct ce.order_id from conversion_events ce join orders o on o.id = ce.order_id
    where ce.tenant_id = ${ctx.tenantId} and ce.kind = 'purchase' and ce.status = 'sent' and ce.sent_at >= ${since}
      and (o.cancelled_at is not null or o.refunded_minor > 0 or o.status not in ${SALE} or o.payment_status in ('refunded', 'voided'))
      and not exists (select 1 from conversion_events r where r.tenant_id = ce.tenant_id and r.order_id = ce.order_id and r.provider = ce.provider and r.kind = 'retraction')
    limit 1000`);
  return queueConversionAdjustments(ctx, rows.rows.map((r) => r.order_id));
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
  /** Retractions and restatements sent (#82). */
  adjusted: number;
  /** Retractions and restatements the platform cannot take, logged only. */
  unsupported: number;
  lastSentAt: Date | null;
}

export async function conversionStats(ctx: ServiceContext, days = 7): Promise<ConversionStats[]> {
  const since = new Date((ctx.now ?? new Date()).getTime() - days * 864e5);
  const rows = await ctx.tx.execute<{ provider: string; sent: number; failed: number; pending: number; consent: number; ident: number; adjusted: number; unsupported: number; last: string | null }>(sql`
    select provider, count(*) filter (where status = 'sent' and kind = 'purchase')::int as sent,
      count(*) filter (where status = 'sent' and kind <> 'purchase')::int as adjusted, count(*) filter (where status = 'skipped' and reason = 'unsupported')::int as unsupported, count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'skipped' and reason = 'no_consent')::int as consent, count(*) filter (where status = 'skipped' and reason = 'no_identifier')::int as ident, max(sent_at) as last
    from conversion_events where tenant_id = ${ctx.tenantId} and created_at >= ${since} group by provider`);
  return CONVERSION_PROVIDERS.map((p) => {
    const r = rows.rows.find((x) => x.provider === p);
    return { provider: p, sent: r?.sent ?? 0, failed: r?.failed ?? 0, pending: r?.pending ?? 0, skippedConsent: r?.consent ?? 0, skippedIdentifier: r?.ident ?? 0, adjusted: r?.adjusted ?? 0, unsupported: r?.unsupported ?? 0, lastSentAt: r?.last ? new Date(r.last) : null };
  });
}

/** The delivery log, newest first; `adjustments` keeps retractions and restatements only (#82). */
export async function conversionLog(ctx: ServiceContext, limit = 30, opts: { kinds?: "adjustments" } = {}) {
  return ctx.tx
    .select({ id: schema.conversionEvents.id, provider: schema.conversionEvents.provider, eventId: schema.conversionEvents.eventId, kind: schema.conversionEvents.kind, valueMinor: schema.conversionEvents.valueMinor, currency: schema.orders.currency, status: schema.conversionEvents.status, reason: schema.conversionEvents.reason, attempts: schema.conversionEvents.attempts, lastError: schema.conversionEvents.lastError, sentAt: schema.conversionEvents.sentAt, createdAt: schema.conversionEvents.createdAt, orderId: schema.conversionEvents.orderId, orderName: schema.orders.name })
    .from(schema.conversionEvents)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.conversionEvents.orderId))
    .where(and(eq(schema.conversionEvents.tenantId, ctx.tenantId), opts.kinds === "adjustments" ? inArray(schema.conversionEvents.kind, ["retraction", "restatement"]) : undefined))
    .orderBy(desc(schema.conversionEvents.createdAt))
    .limit(limit);
}
