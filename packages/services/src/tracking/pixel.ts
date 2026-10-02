import { createHash, randomBytes } from "node:crypto";
import { adminDb, and, eq, schema, sql } from "@hullwise/db";
import { matchCampaign, pixelEventTime, sessionTouch, type CampaignRef, type PixelEvent } from "@hullwise/core";
import type { ServiceContext } from "../context";
import { hashIp } from "../returns/portal";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const RATE_WINDOW_S = 10 * 60;
const RATE_MAX_EVENTS = 1500;

export class PixelError extends Error {
  constructor(public readonly code: "unknown_key" | "disabled" | "origin" | "rate_limited") {
    super(code);
  }
}

/** The store's pixel row, created with a fresh public key on first use. */
export async function ensurePixelSettings(ctx: ServiceContext) {
  const [row] = await ctx.tx.select().from(schema.pixelSettings).where(eq(schema.pixelSettings.tenantId, ctx.tenantId)).limit(1);
  if (row) return row;
  const [created] = await ctx.tx.insert(schema.pixelSettings).values({ tenantId: ctx.tenantId, publicKey: `px_${randomBytes(15).toString("base64url")}` }).returning();
  return created!;
}

export async function savePixelSettings(ctx: ServiceContext, input: { enabled: boolean; allowedOrigins: string[]; lookbackDays: number }): Promise<void> {
  await ensurePixelSettings(ctx);
  const origins = input.allowedOrigins.map((o) => o.trim().replace(/\/+$/, "")).filter((o) => /^https?:\/\/[^\s/]+$/.test(o)).slice(0, 20);
  await ctx.tx.update(schema.pixelSettings).set({ enabled: input.enabled, allowedOrigins: origins, lookbackDays: Math.min(90, Math.max(1, Math.round(input.lookbackDays))), updatedAt: new Date() }).where(eq(schema.pixelSettings.tenantId, ctx.tenantId));
}

/** Cross-tenant lookup of a public key (the only query outside withTenant, like webhook shop resolution). */
export async function pixelTenantForKey(key: string): Promise<{ tenantId: string; enabled: boolean; allowedOrigins: string[] } | null> {
  if (!/^px_[A-Za-z0-9_-]{10,40}$/.test(key)) return null;
  const [row] = await adminDb().select({ tenantId: schema.pixelSettings.tenantId, enabled: schema.pixelSettings.enabled, allowedOrigins: schema.pixelSettings.allowedOrigins }).from(schema.pixelSettings).where(eq(schema.pixelSettings.publicKey, key)).limit(1);
  return row ?? null;
}

export function originAllowed(allowed: readonly string[], origin: string | null): boolean {
  if (!allowed.length) return true;
  return !!origin && allowed.includes(origin.replace(/\/+$/, ""));
}

/** Fixed window counting events (not requests) per hashed IP. */
async function rateLimit(ctx: ServiceContext, key: string, events: number, now: Date): Promise<boolean> {
  const [row] = await ctx.tx.select().from(schema.publicRateLimits).where(and(eq(schema.publicRateLimits.tenantId, ctx.tenantId), eq(schema.publicRateLimits.key, key))).limit(1);
  const fresh = !row || now.getTime() - row.windowStart.getTime() >= RATE_WINDOW_S * 1000;
  const windowStart = fresh ? now : row!.windowStart;
  const count = (fresh ? 0 : row!.count) + events;
  await ctx.tx.insert(schema.publicRateLimits).values({ tenantId: ctx.tenantId, key, windowStart, count }).onConflictDoUpdate({ target: [schema.publicRateLimits.tenantId, schema.publicRateLimits.key], set: { windowStart, count } });
  return count <= RATE_MAX_EVENTS;
}

export interface IngestResult {
  accepted: number;
  sessions: number;
  identities: number;
  stitched: number;
}

/**
 * Stores a batch from the browser: raw events, one touchpoint per new session (its landing page
 * and referrer decide the channel), identities from checkouts and identify calls (email kept
 * only as a hash), then stitches sessions to orders when a checkout completed.
 */
export async function ingestPixelBatch(ctx: ServiceContext, events: PixelEvent[], meta: { ip: string | null; userAgent: string | null }): Promise<IngestResult> {
  const now = ctx.now ?? new Date();
  const ipHash = hashIp(meta.ip);
  if (!(await rateLimit(ctx, `px:ip:${ipHash}`, events.length, now))) throw new PixelError("rate_limited");
  const ua = meta.userAgent?.slice(0, 400) ?? null;
  const rows = events.map((e) => {
    const checkout = e.event === "checkout_completed" || e.event === "checkout_started";
    const props = { ...e.props, email: undefined } as Record<string, unknown>;
    return { tenantId: ctx.tenantId, anonymousId: e.anonymousId, sessionId: e.sessionId, event: e.event, url: e.url?.slice(0, 2000) ?? null, referrer: e.referrer?.slice(0, 2000) ?? null, props, ipHash, clientIp: checkout ? meta.ip : null, userAgent: checkout ? ua : null, occurredAt: pixelEventTime(e.ts, now), receivedAt: now };
  });
  await ctx.tx.insert(schema.pixelEvents).values(rows);

  // sessions seen for the first time get their touchpoint
  const sessionIds = [...new Set(events.map((e) => e.sessionId))];
  const known = new Set((await ctx.tx.execute<{ session_id: string }>(sql`select session_id from touchpoints where tenant_id = ${ctx.tenantId} and origin = 'pixel' and session_id = any(${sql.param(sessionIds)}::text[])`)).rows.map((r) => r.session_id));
  let campaigns: CampaignRef[] | null = null;
  let sessions = 0;
  for (const sid of sessionIds) {
    if (known.has(sid)) continue;
    const idx = events.findIndex((e) => e.sessionId === sid);
    const first = events[idx]!;
    const touch = sessionTouch(first.url, first.referrer);
    let campaignId: string | null = null;
    if (touch.attribution.utmCampaign || touch.attribution.utmId || touch.clickId) {
      campaigns ??= (await ctx.tx.select({ id: schema.campaigns.id, externalId: schema.campaigns.externalId, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, ctx.tenantId))) as CampaignRef[];
      campaignId = matchCampaign(touch.attribution, campaigns)?.id ?? null;
    }
    await ctx.tx.insert(schema.touchpoints).values({ tenantId: ctx.tenantId, anonymousId: first.anonymousId, sessionId: sid, occurredAt: rows[idx]!.occurredAt, channel: touch.channel, source: touch.attribution.utmSource, medium: touch.attribution.utmMedium, utmCampaign: touch.attribution.utmCampaign, utmContent: touch.attribution.utmContent, campaignId, clickId: touch.clickId, paid: touch.paid, landingUrl: touch.landingUrl, origin: "pixel" });
    sessions++;
  }

  // identities
  const ids = events
    .filter((e) => e.event === "checkout_completed" || e.event === "identify")
    .map((e) => {
      const email = e.props.email?.trim().toLowerCase() ?? "";
      return { tenantId: ctx.tenantId, anonymousId: e.anonymousId, orderExternalId: e.props.orderId ?? null, checkoutToken: e.props.checkoutToken ?? null, emailSha256: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? sha256(email) : null, linkedAt: now };
    })
    .filter((i) => i.orderExternalId || i.checkoutToken || i.emailSha256);
  if (ids.length) await ctx.tx.insert(schema.pixelIdentities).values(ids);
  const stitched = events.some((e) => e.event === "checkout_completed") ? await stitchPixelSessions(ctx, { orderSinceHours: 72 }) : 0;
  return { accepted: events.length, sessions, identities: ids.length, stitched };
}

/**
 * Assigns pixel sessions to the order they led to: the browser is linked to an order by its
 * checkout (order id) or to a customer by a hashed email seen on any device; each session goes to
 * the customer's first order placed after it, within the pixel's lookback. Idempotent: only
 * sessions without an order are touched.
 */
export async function stitchPixelSessions(ctx: ServiceContext, opts: { orderSinceHours?: number } = {}): Promise<number> {
  const now = ctx.now ?? new Date();
  const t = ctx.tenantId;
  const since = new Date(now.getTime() - (opts.orderSinceHours ?? 48) * 3600_000);
  const [settings] = await ctx.tx.select({ lookbackDays: schema.pixelSettings.lookbackDays }).from(schema.pixelSettings).where(eq(schema.pixelSettings.tenantId, t)).limit(1);
  const lookback = settings?.lookbackDays ?? 30;
  // identities learn their customer from the orders they match
  await ctx.tx.execute(sql`
    update pixel_identities i set customer_id = o.customer_id
    from orders o
    where i.tenant_id = ${t} and o.tenant_id = ${t} and i.customer_id is null and o.customer_id is not null
      and (i.order_external_id = o.external_id or i.email_sha256 = encode(sha256(convert_to(o.email_normalized, 'UTF8')), 'hex'))`);
  const res = await ctx.tx.execute(sql`
    with recent as (
      select o.id, o.customer_id, o.external_id, o.placed_at, encode(sha256(convert_to(coalesce(o.email_normalized, ''), 'UTF8')), 'hex') as eh
      from orders o where o.tenant_id = ${t} and o.placed_at >= ${since}
    ),
    browsers as (
      select distinct r.id as order_id, r.customer_id, r.placed_at, i.anonymous_id
      from recent r join pixel_identities i on i.tenant_id = ${t}
        and (i.order_external_id = r.external_id or i.email_sha256 = r.eh or (i.customer_id is not null and i.customer_id = r.customer_id))
    ),
    pick as (
      select distinct on (tp.id) tp.id as touch_id, b.order_id, b.customer_id
      from touchpoints tp join browsers b on b.anonymous_id = tp.anonymous_id
      where tp.tenant_id = ${t} and tp.origin = 'pixel' and tp.order_id is null
        and tp.occurred_at <= b.placed_at and tp.occurred_at > b.placed_at - make_interval(days => ${lookback})
      order by tp.id, b.placed_at
    )
    update touchpoints tp set order_id = p.order_id, customer_id = coalesce(tp.customer_id, p.customer_id)
    from pick p where tp.id = p.touch_id`);
  return Number((res as unknown as { rowCount?: number }).rowCount ?? 0);
}

export interface PixelOverview {
  settings: { publicKey: string; enabled: boolean; allowedOrigins: string[]; lookbackDays: number };
  events: number;
  sessions: number;
  visitors: number;
  identifiedVisitors: number;
  orders: number;
  ordersWithPixel: number;
  lastEventAt: Date | null;
  byChannel: { channel: string; sessions: number }[];
}

/** Health of the pixel over the last `days`: is it collecting, and how many orders it explains. */
export async function pixelOverview(ctx: ServiceContext, days = 7): Promise<PixelOverview> {
  const now = ctx.now ?? new Date();
  const since = new Date(now.getTime() - days * 864e5);
  const s = await ensurePixelSettings(ctx);
  const t = ctx.tenantId;
  const [ev] = (await ctx.tx.execute<{ events: number; sessions: number; visitors: number; last: string | null }>(sql`select count(*)::int as events, count(distinct session_id)::int as sessions, count(distinct anonymous_id)::int as visitors, max(occurred_at) as last from pixel_events where tenant_id = ${t} and occurred_at >= ${since}`)).rows;
  const [idn] = (await ctx.tx.execute<{ n: number }>(sql`select count(distinct anonymous_id)::int as n from pixel_identities where tenant_id = ${t} and linked_at >= ${since}`)).rows;
  const [ord] = (await ctx.tx.execute<{ orders: number; with_pixel: number }>(sql`select count(*)::int as orders, count(*) filter (where exists (select 1 from touchpoints tp where tp.tenant_id = ${t} and tp.order_id = o.id and tp.origin = 'pixel'))::int as with_pixel from orders o where o.tenant_id = ${t} and o.placed_at >= ${since}`)).rows;
  const ch = await ctx.tx.execute<{ channel: string; sessions: number }>(sql`select channel, count(*)::int as sessions from touchpoints where tenant_id = ${t} and origin = 'pixel' and occurred_at >= ${since} group by 1 order by 2 desc`);
  return {
    settings: { publicKey: s.publicKey, enabled: s.enabled, allowedOrigins: s.allowedOrigins, lookbackDays: s.lookbackDays },
    events: ev?.events ?? 0,
    sessions: ev?.sessions ?? 0,
    visitors: ev?.visitors ?? 0,
    identifiedVisitors: idn?.n ?? 0,
    orders: ord?.orders ?? 0,
    ordersWithPixel: ord?.with_pixel ?? 0,
    lastEventAt: ev?.last ? new Date(ev.last) : null,
    byChannel: ch.rows.map((r) => ({ channel: r.channel, sessions: Number(r.sessions) })),
  };
}
