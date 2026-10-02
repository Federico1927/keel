import { and, desc, eq, gte, lte, schema, sql, type SQL } from "@hullwise/db";
import { ONLINE_SOURCE_CHANNELS, aggregateTrafficRows, channelOfGa4Group, conversionRateRows, matchTrafficCampaign, splitDateWindows, type CampaignRef, type ConversionRateRow, type Period } from "@hullwise/core";
import { IntegrationError, type AnalyticsPlatform } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { recordHealth } from "../sync";

/**
 * Web traffic from GA4 (#86): resumable backfill, daily sync and nightly re-sync into
 * `analytics_traffic_daily`, and the reads behind conversion rates by channel, landing page and campaign.
 */

export const TRAFFIC_OBJECT_TYPE = "traffic";
export const TRAFFIC_SYNC_KINDS = ["backfill", "daily", "reconcile"] as const;
export type TrafficSyncKind = (typeof TRAFFIC_SYNC_KINDS)[number];
/** 12 months of history on connection; the nightly pass re-reads 3 days because GA4 settles late. */
export const TRAFFIC_BACKFILL_DAYS = 365;
export const TRAFFIC_RECONCILE_DAYS = 3;
const DAY = 864e5;

/**
 * SQL twin of `normalizeLandingPath` (core): the landing path of an order's landing site or a pixel
 * session's landing URL, so orders, pixel sessions and GA4 rows group by the same key.
 */
export function landingPathSql(col: SQL): SQL {
  const p = sql`regexp_replace(regexp_replace(lower(split_part(split_part(regexp_replace(trim(${col}), '^[a-z][a-z0-9+.-]*://[^/?#]*', '', 'i'), '?', 1), '#', 1)), '/{2,}', '/', 'g'), '/+$', '')`;
  return sql`(case when ${col} is null or trim(${col}) = '' then '(not set)' when trim(${col}) ~ '^\\(.*\\)$' then lower(trim(${col})) else left(case when ${p} = '' then '/' when left(${p}, 1) = '/' then ${p} else '/' || ${p} end, 500) end)`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Calendar day of an instant in the tenant's zone (GA4 reports days in the property's zone). */
export function localDay(at: Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f.format(at);
}
/** The GA4 days a period covers (`to` exclusive). */
export function periodDays(period: Period, timeZone: string): { since: string; until: string } {
  return { since: localDay(period.from, timeZone), until: localDay(new Date(Math.max(period.from.getTime(), period.to.getTime() - 1)), timeZone) };
}

interface TrafficCursor {
  since: string;
  until: string;
  window: number;
  propertyId: string;
  counts: { rows: number; sessions: number };
}

export interface TrafficSyncResult {
  runId: string;
  finished: boolean;
  rateLimited: boolean;
  retryAfterMs: number | null;
  rows: number;
  error: string | null;
}

/** The window a sync kind reads: 12 months, since the last metric day (at least yesterday), or the last 3 days. */
export async function trafficSyncWindow(ctx: ServiceContext, kind: TrafficSyncKind, timeZone: string): Promise<{ since: string; until: string }> {
  const now = ctx.now ?? new Date();
  const until = localDay(now, timeZone);
  if (kind === "backfill") return { since: localDay(new Date(now.getTime() - (TRAFFIC_BACKFILL_DAYS - 1) * DAY), timeZone), until };
  if (kind === "reconcile") return { since: localDay(new Date(now.getTime() - (TRAFFIC_RECONCILE_DAYS - 1) * DAY), timeZone), until };
  const [h] = await ctx.tx.select({ last: schema.integrationHealth.lastMetricDate }).from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenantId), eq(schema.integrationHealth.source, "ga4"))).limit(1);
  const yesterday = localDay(new Date(now.getTime() - DAY), timeZone);
  const floor = localDay(new Date(now.getTime() - 30 * DAY), timeZone);
  const last = h?.last ?? null;
  return { since: last && last < yesterday ? (last < floor ? floor : last) : yesterday, until };
}

/** Replaces the property's days of one window with what GA4 returned: re-runs and late restatements leave no duplicates. */
export async function writeTrafficWindow(ctx: ServiceContext, propertyId: string, window: { since: string; until: string }, rows: Awaited<ReturnType<AnalyticsPlatform["fetchDailyTraffic"]>>): Promise<{ rows: number; sessions: number }> {
  const T = schema.analyticsTrafficDaily;
  const now = ctx.now ?? new Date();
  const inWindow = rows.filter((r) => r.date >= window.since && r.date <= window.until);
  const values = aggregateTrafficRows(inWindow).map((r) => ({ tenantId: ctx.tenantId, provider: "ga4", propertyId, ...r, channel: channelOfGa4Group(r.channelGroup), syncedAt: now, updatedAt: now }));
  await ctx.tx.delete(T).where(and(eq(T.tenantId, ctx.tenantId), eq(T.provider, "ga4"), eq(T.propertyId, propertyId), gte(T.date, window.since), lte(T.date, window.until)));
  for (let i = 0; i < values.length; i += 1000) await ctx.tx.insert(T).values(values.slice(i, i + 1000));
  return { rows: values.length, sessions: values.reduce((s, v) => s + v.sessions, 0) };
}

/**
 * One GA4 pull, resumable: the window is split in 7-day slices (oldest first) and the cursor saved in
 * `sync_runs` after each; the run pauses at its time budget or on a quota error (same slice next time,
 * after the wait) and the next call of the same kind resumes it. Any other error fails the run.
 */
export async function runTrafficSync(ctx: ServiceContext, platform: AnalyticsPlatform, opts: { propertyId: string; kind: TrafficSyncKind; timeZone: string; budgetMs?: number; windowDays?: number }): Promise<TrafficSyncResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 20_000;
  const now = ctx.now ?? new Date();
  const S = schema.syncRuns;
  const [paused] = await ctx.tx.select().from(S).where(and(eq(S.tenantId, ctx.tenantId), eq(S.provider, "ga4"), eq(S.objectType, TRAFFIC_OBJECT_TYPE), eq(S.kind, opts.kind), eq(S.status, "paused"), sql`${S.cursor}->>'propertyId' = ${opts.propertyId}`)).orderBy(desc(S.startedAt)).limit(1);
  let cursor: TrafficCursor;
  let runId: string;
  const baseDuration = paused?.durationMs ?? 0;
  if (paused) {
    cursor = paused.cursor as unknown as TrafficCursor;
    runId = paused.id;
    await ctx.tx.update(S).set({ status: "running", error: null }).where(eq(S.id, runId));
  } else {
    const w = await trafficSyncWindow(ctx, opts.kind, opts.timeZone);
    cursor = { ...w, window: 0, propertyId: opts.propertyId, counts: { rows: 0, sessions: 0 } };
    const [row] = await ctx.tx.insert(S).values({ tenantId: ctx.tenantId, provider: "ga4", objectType: TRAFFIC_OBJECT_TYPE, kind: opts.kind, status: "running", cursor, startedAt: now }).returning({ id: S.id });
    runId = row!.id;
  }
  const windows = splitDateWindows(cursor.since, cursor.until, opts.windowDays ?? 7);
  const save = (status: "running" | "paused" | "success" | "error", error: string | null = null) => ctx.tx.update(S).set({ status, cursor, rowsWritten: cursor.counts.rows, rowsScanned: cursor.counts.rows, error, errorCount: status === "error" ? 1 : 0, summary: { ...cursor.counts }, durationMs: baseDuration + Date.now() - started, ...(status === "success" || status === "error" ? { finishedAt: new Date() } : {}) }).where(eq(S.id, runId));
  const result = (finished: boolean, error: string | null, rateLimited = false, retryAfterMs: number | null = null): TrafficSyncResult => ({ runId, finished, rateLimited, retryAfterMs, rows: cursor.counts.rows, error });
  try {
    while (cursor.window < windows.length) {
      const w = windows[cursor.window]!;
      const n = await writeTrafficWindow(ctx, opts.propertyId, w, await platform.fetchDailyTraffic(w));
      cursor.counts.rows += n.rows;
      cursor.counts.sessions += n.sessions;
      cursor.window++;
      await save("running");
      if (cursor.window < windows.length && Date.now() - started > budgetMs) {
        await save("paused");
        return result(false, null);
      }
    }
    await save("success");
    await recordHealth(ctx, "ga4", true, { rowsWritten: cursor.counts.rows, lastMetricDate: cursor.until, freshnessMinutes: 36 * 60 });
    return result(true, null);
  } catch (e) {
    const error = `${e instanceof IntegrationError ? `[${e.code}] ` : ""}${e instanceof Error ? e.message : String(e)}`;
    if (e instanceof IntegrationError && e.code === "rate_limited") {
      // the cursor still points at the slice that failed: the next run starts there
      await save("paused", error);
      await recordHealth(ctx, "ga4", false, { error });
      return result(false, null, true, e.retryAfterMs ?? 60_000);
    }
    await save("error", error);
    await recordHealth(ctx, "ga4", false, { error });
    return result(false, error);
  }
}

/* ---------- reads ---------- */

export interface TrafficState {
  connected: boolean;
  propertyId: string | null;
  propertyName: string | null;
  mode: "mock" | "live";
  lastSuccessAt: Date | null;
  lastError: string | null;
  /** First and last day with rows for the current property. */
  firstDate: string | null;
  lastDate: string | null;
}

/** Whether GA4 is connected and which property the analytics read. */
export async function trafficState(ctx: ServiceContext): Promise<TrafficState> {
  const [row] = await ctx.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, "ga4"))).limit(1);
  const connected = !!row && row.status !== "not_connected" && !!row.externalAccountId;
  let range: { first: string | null; last: string | null } = { first: null, last: null };
  if (connected) {
    const T = schema.analyticsTrafficDaily;
    const [r] = await ctx.tx.select({ first: sql<string | null>`min(${T.date})::text`, last: sql<string | null>`max(${T.date})::text` }).from(T).where(and(eq(T.tenantId, ctx.tenantId), eq(T.propertyId, row!.externalAccountId!)));
    range = { first: r?.first ?? null, last: r?.last ?? null };
  }
  return { connected, propertyId: connected ? row!.externalAccountId : null, propertyName: row?.externalAccountName ?? null, mode: row?.mode === "live" ? "live" : "mock", lastSuccessAt: row?.lastSuccessAt ?? null, lastError: row?.lastError ?? null, firstDate: range.first, lastDate: range.last };
}

/** Filters of the GA4 rows view (every number of the conversion tables links here). */
export interface TrafficFilters {
  channel?: string;
  source?: string;
  medium?: string;
  campaignName?: string;
  /** A Hullwise campaign: the rows whose source / medium / campaign match it (`matchTrafficCampaign`). */
  campaignId?: string;
  landing?: string;
}

async function campaignRefs(ctx: ServiceContext): Promise<CampaignRef[]> {
  return ctx.tx.select({ id: schema.campaigns.id, externalId: schema.campaigns.externalId, name: schema.campaigns.name, platform: schema.campaigns.platform }).from(schema.campaigns).where(eq(schema.campaigns.tenantId, ctx.tenantId));
}

function trafficWhere(ctx: ServiceContext, propertyId: string, days: { since: string; until: string }, f: TrafficFilters = {}): SQL {
  const T = schema.analyticsTrafficDaily;
  const conds: SQL[] = [eq(T.tenantId, ctx.tenantId), eq(T.provider, "ga4"), eq(T.propertyId, propertyId), gte(T.date, days.since), lte(T.date, days.until)];
  if (f.channel) conds.push(eq(T.channel, f.channel));
  if (f.source) conds.push(eq(T.source, f.source));
  if (f.medium) conds.push(eq(T.medium, f.medium));
  if (f.campaignName) conds.push(eq(T.campaignName, f.campaignName));
  if (f.landing) conds.push(eq(T.landingPath, f.landing));
  return and(...conds)!;
}

/** The (source, medium, campaign) triples of the period, each with its sessions and matched campaign. */
async function campaignTriples(ctx: ServiceContext, propertyId: string, days: { since: string; until: string }) {
  const T = schema.analyticsTrafficDaily;
  const rows = await ctx.tx.select({ source: T.source, medium: T.medium, campaignName: T.campaignName, sessions: sql<number>`sum(${T.sessions})::int`, engaged: sql<number>`sum(${T.engagedSessions})::int`, atc: sql<number>`sum(${T.addToCarts})::int` }).from(T).where(trafficWhere(ctx, propertyId, days)).groupBy(T.source, T.medium, T.campaignName);
  const refs = await campaignRefs(ctx);
  return rows.map((r) => ({ ...r, campaignId: matchTrafficCampaign(r, refs)?.id ?? null }));
}

export interface TrafficRowsPage {
  rows: { date: string; channelGroup: string; channel: string; source: string; medium: string; campaignName: string; landingPath: string; sessions: number; totalUsers: number; engagedSessions: number; addToCarts: number }[];
  total: number;
  totals: { sessions: number; engagedSessions: number; addToCarts: number };
  page: number;
  pageSize: number;
}

/** The stored GA4 rows behind a number, newest day first, biggest rows first within a day. */
export async function trafficRows(ctx: ServiceContext, tenant: { timezone: string }, period: Period, f: TrafficFilters = {}, opts: { page?: number; pageSize?: number } = {}): Promise<TrafficRowsPage> {
  const state = await trafficState(ctx);
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, opts.pageSize ?? 50));
  if (!state.connected) return { rows: [], total: 0, totals: { sessions: 0, engagedSessions: 0, addToCarts: 0 }, page, pageSize };
  const days = periodDays(period, tenant.timezone);
  const T = schema.analyticsTrafficDaily;
  let where = trafficWhere(ctx, state.propertyId!, days, f);
  if (f.campaignId) {
    const triples = (await campaignTriples(ctx, state.propertyId!, days)).filter((t) => t.campaignId === f.campaignId);
    where = triples.length ? and(where, sql`(${T.source}, ${T.medium}, ${T.campaignName}) in (${sql.join(triples.map((t) => sql`(${t.source}, ${t.medium}, ${t.campaignName})`), sql`, `)})`)! : sql`false`;
  }
  const [agg] = await ctx.tx.select({ n: sql<number>`count(*)::int`, sessions: sql<number>`coalesce(sum(${T.sessions}),0)::int`, engaged: sql<number>`coalesce(sum(${T.engagedSessions}),0)::int`, atc: sql<number>`coalesce(sum(${T.addToCarts}),0)::int` }).from(T).where(where);
  const rows = await ctx.tx.select({ date: sql<string>`${T.date}::text`, channelGroup: T.channelGroup, channel: T.channel, source: T.source, medium: T.medium, campaignName: T.campaignName, landingPath: T.landingPath, sessions: T.sessions, totalUsers: T.totalUsers, engagedSessions: T.engagedSessions, addToCarts: T.addToCarts }).from(T).where(where).orderBy(desc(T.date), desc(T.sessions), T.landingPath).limit(pageSize).offset((page - 1) * pageSize);
  return { rows, total: agg?.n ?? 0, totals: { sessions: agg?.sessions ?? 0, engagedSessions: agg?.engaged ?? 0, addToCarts: agg?.atc ?? 0 }, page, pageSize };
}

export interface ConversionReport {
  state: TrafficState;
  rows: ConversionRateRow[];
  totals: Omit<ConversionRateRow, "key">;
  /** Days of the period with first-party pixel sessions (the pixel may have started later than GA4). */
  pixelFrom: string | null;
}

const onlineOrders = (ctx: ServiceContext, period: Period) => sql`o.tenant_id = ${ctx.tenantId} and o.placed_at >= ${period.from} and o.placed_at < ${period.to} and o.source_channel in (${sql.join(ONLINE_SOURCE_CHANNELS.map((c) => sql`${c}`), sql`, `)})`;

/**
 * Conversion rate by channel or by landing page over a period: online orders (every status: an order
 * cancelled later still converted a session) ÷ GA4 sessions, next to the same orders ÷ first-party
 * pixel sessions. Orders without attribution count as `unknown`, like the orders filter.
 */
export async function conversionReport(ctx: ServiceContext, tenant: { timezone: string }, period: Period, by: "channel" | "landing", opts: { limit?: number } = {}): Promise<ConversionReport> {
  const state = await trafficState(ctx);
  if (!state.connected) return { state, rows: [], totals: { orders: 0, sessions: 0, rate: null, pixelSessions: 0, pixelRate: null, engagedSessions: 0, addToCarts: 0 }, pixelFrom: null };
  const days = periodDays(period, tenant.timezone);
  const T = schema.analyticsTrafficDaily;
  const key = by === "channel" ? T.channel : T.landingPath;
  const sessions = await ctx.tx.select({ key: sql<string>`${key}`, sessions: sql<number>`sum(${T.sessions})::int`, engagedSessions: sql<number>`sum(${T.engagedSessions})::int`, addToCarts: sql<number>`sum(${T.addToCarts})::int` }).from(T).where(trafficWhere(ctx, state.propertyId!, days)).groupBy(key);
  const orderKey = by === "channel" ? sql`coalesce(a.channel, 'unknown')` : landingPathSql(sql`o.landing_site`);
  const orders = (await ctx.tx.execute<{ key: string; orders: number }>(sql`select ${orderKey} as key, count(*)::int as orders from orders o left join order_attribution a on a.order_id = o.id where ${onlineOrders(ctx, period)} group by 1`)).rows.map((r) => ({ key: r.key, orders: Number(r.orders) }));
  const pixelKey = by === "channel" ? sql`channel` : landingPathSql(sql`landing_url`);
  const pixel = (await ctx.tx.execute<{ key: string; sessions: number }>(sql`select ${pixelKey} as key, count(distinct coalesce(session_id, id::text))::int as sessions from touchpoints where tenant_id = ${ctx.tenantId} and origin = 'pixel' and occurred_at >= ${period.from} and occurred_at < ${period.to} group by 1`)).rows.map((r) => ({ key: r.key, sessions: Number(r.sessions) }));
  const [first] = (await ctx.tx.execute<{ at: string | null }>(sql`select min(occurred_at)::text as at from touchpoints where tenant_id = ${ctx.tenantId} and origin = 'pixel' and occurred_at >= ${period.from} and occurred_at < ${period.to}`)).rows;
  // the pixel's rate divides only the orders placed since its first session in the period (coverage)
  const pixelStart = first?.at ? new Date(first.at) : null;
  const pixelOrders = pixelStart && pixelStart > period.from ? (await ctx.tx.execute<{ key: string; orders: number }>(sql`select ${orderKey} as key, count(*)::int as orders from orders o left join order_attribution a on a.order_id = o.id where ${onlineOrders(ctx, { from: pixelStart, to: period.to })} group by 1`)).rows.map((r) => ({ key: r.key, orders: Number(r.orders) })) : orders;
  const report = conversionRateRows({ orders, sessions, pixel, pixelOrders });
  // landing pages: the busiest pages by GA4 sessions; pages with orders but no sessions stay visible after them
  const rows = by === "landing" ? report.rows.filter((r) => r.sessions > 0 || r.orders > 0).slice(0, opts.limit ?? 25) : report.rows;
  return { state, rows, totals: report.totals, pixelFrom: pixelStart ? localDay(pixelStart, tenant.timezone) : null };
}

/** GA4 sessions per Hullwise campaign over a period (campaign rows: sessions next to spend and orders). */
export async function trafficByCampaign(ctx: ServiceContext, tenant: { timezone: string }, period: Period): Promise<Map<string, number> | null> {
  const state = await trafficState(ctx);
  if (!state.connected) return null;
  const out = new Map<string, number>();
  for (const t of await campaignTriples(ctx, state.propertyId!, periodDays(period, tenant.timezone))) if (t.campaignId) out.set(t.campaignId, (out.get(t.campaignId) ?? 0) + t.sessions);
  return out;
}
