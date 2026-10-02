import { and, eq, inArray, lt, schema, sql } from "@hullwise/db";
import { OTHER_SEARCH_TERM, ZERO_METRICS, groupRareTerms, rollupMetricRows, type MetricRow } from "@hullwise/core";
import type { ServiceContext } from "../context";

export interface AdsRollupResult {
  /** Daily rows folded into months. */
  rolled: number;
  /** Monthly search-term rows moved into "(other)". */
  grouped: number;
  /** Search terms left without any metric row, deleted. */
  orphans: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const M = schema.adEntityMetricsDaily;
type Row = typeof M.$inferSelect;
const toMetric = (r: Row): MetricRow => ({ entityType: r.entityType, entityId: r.entityId, date: r.date, grain: r.grain === "month" ? "month" : "day", spendMinor: r.spendMinor, impressions: r.impressions, clicks: r.clicks, reach: r.reach, conversions: r.conversions, conversionValueMinor: r.conversionValueMinor, videoViews3s: r.videoViews3s, videoCompletions: r.videoCompletions });
const values = (m: MetricRow) => ({ spendMinor: m.spendMinor, impressions: m.impressions, clicks: m.clicks, reach: m.reach, conversions: m.conversions, conversionValueMinor: m.conversionValueMinor, videoViews3s: m.videoViews3s, videoCompletions: m.videoCompletions });

/**
 * Volume control (daily, with the retention tick): daily rows of ad sets, assets, keywords and search
 * terms older than the tenant's retention become monthly rows; once a month is entirely past the
 * cutoff, its search terms under the minimum impressions move to the "(other)" term of their ad group.
 * Totals never change: spend and conversions move, they are not dropped.
 */
export async function rollupAdEntityMetrics(ctx: ServiceContext, opts: { retentionDays: number; minImpressions: number; now?: Date }): Promise<AdsRollupResult> {
  const now = opts.now ?? ctx.now ?? new Date();
  const cutoff = iso(new Date(now.getTime() - opts.retentionDays * 864e5));
  const t = ctx.tenantId;
  let rolled = 0;
  const months = await ctx.tx.selectDistinct({ m: sql<string>`substr(${M.date}, 1, 7)` }).from(M).where(and(eq(M.tenantId, t), eq(M.grain, "day"), lt(M.date, cutoff)));
  for (const { m } of months) {
    const rows = await ctx.tx.select().from(M).where(and(eq(M.tenantId, t), eq(M.grain, "day"), lt(M.date, cutoff), sql`${M.date} like ${`${m}-%`}`));
    if (!rows.length) continue;
    const campaignOf = new Map(rows.map((r) => [r.entityId, r.campaignId]));
    const out = rollupMetricRows(rows.map(toMetric), cutoff);
    rolled += out.rolled;
    for (let i = 0; i < out.months.length; i += 400) {
      const chunk = out.months.slice(i, i + 400).map((r) => ({ tenantId: t, entityType: r.entityType, entityId: r.entityId, campaignId: campaignOf.get(r.entityId)!, date: r.date, grain: "month", ...values(r) }));
      await ctx.tx.insert(M).values(chunk).onConflictDoUpdate({ target: [M.entityType, M.entityId, M.grain, M.date], set: { spendMinor: sql`${M.spendMinor} + excluded.spend_minor`, impressions: sql`${M.impressions} + excluded.impressions`, clicks: sql`${M.clicks} + excluded.clicks`, reach: sql`${M.reach} + excluded.reach`, conversions: sql`${M.conversions} + excluded.conversions`, conversionValueMinor: sql`${M.conversionValueMinor} + excluded.conversion_value_minor`, videoViews3s: sql`${M.videoViews3s} + excluded.video_views_3s`, videoCompletions: sql`${M.videoCompletions} + excluded.video_completions` } });
    }
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 1000) await ctx.tx.delete(M).where(and(eq(M.tenantId, t), inArray(M.id, ids.slice(i, i + 1000))));
  }
  const grouped = await groupClosedMonths(ctx, `${cutoff.slice(0, 7)}-01`, opts.minImpressions);
  const orphans = await ctx.tx
    .delete(schema.adSearchTerms)
    .where(and(eq(schema.adSearchTerms.tenantId, t), eq(schema.adSearchTerms.isOther, false), eq(schema.adSearchTerms.status, "none"), sql`not exists (select 1 from ad_entity_metrics_daily m where m.entity_type = 'search_term' and m.entity_id = ${schema.adSearchTerms.id})`))
    .returning({ id: schema.adSearchTerms.id });
  return { rolled, grouped, orphans: orphans.length };
}

/** Rare search terms of months entirely before `firstOpenMonth` move into "(other)" of their ad group (or campaign). */
async function groupClosedMonths(ctx: ServiceContext, firstOpenMonth: string, minImpressions: number): Promise<number> {
  if (minImpressions <= 0) return 0;
  const t = ctx.tenantId;
  const T = schema.adSearchTerms;
  const rare = await ctx.tx
    .select({ row: M, termId: T.id, campaignId: T.campaignId, adSetId: T.adSetId, platform: T.platform, adSetExt: schema.adSets.externalId, campaignExt: schema.campaigns.externalId })
    .from(M)
    .innerJoin(T, eq(T.id, M.entityId))
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, T.campaignId))
    .leftJoin(schema.adSets, eq(schema.adSets.id, T.adSetId))
    .where(and(eq(M.tenantId, t), eq(M.entityType, "search_term"), eq(M.grain, "month"), lt(M.date, firstOpenMonth), lt(M.impressions, minImpressions), eq(T.isOther, false)));
  if (!rare.length) return 0;
  // one "(other)" term per ad group (or campaign), created on first use
  const otherKey = (r: (typeof rare)[number]) => `${r.adSetExt ?? `c${r.campaignExt}`}|${OTHER_SEARCH_TERM}`;
  const wanted = new Map(rare.map((r) => [otherKey(r), r]));
  await ctx.tx.insert(T).values([...wanted.entries()].map(([key, r]) => ({ tenantId: t, campaignId: r.campaignId, adSetId: r.adSetId, platform: r.platform, externalId: key, text: OTHER_SEARCH_TERM, isOther: true }))).onConflictDoNothing();
  const others = await ctx.tx.select({ id: T.id, ext: T.externalId }).from(T).where(and(eq(T.tenantId, t), inArray(T.externalId, [...wanted.keys()])));
  const otherIdByKey = new Map(others.map((o) => [o.ext, o.id]));
  const otherOfTerm = new Map(rare.map((r) => [r.termId, otherIdByKey.get(otherKey(r)) ?? null]));
  const otherIds = [...new Set([...otherOfTerm.values()].filter((x): x is string => Boolean(x)))];
  const existing = otherIds.length ? await ctx.tx.select().from(M).where(and(eq(M.tenantId, t), eq(M.entityType, "search_term"), eq(M.grain, "month"), inArray(M.entityId, otherIds))) : [];
  const months = new Set(rare.map((r) => r.row.date));
  const merged = groupRareTerms([...rare.map((r) => toMetric(r.row)), ...existing.filter((e) => months.has(e.date)).map(toMetric)], minImpressions, (id) => otherOfTerm.get(id) ?? (otherIds.includes(id) ? id : null));
  const campaignOf = new Map([...rare.map((r) => [r.termId, r.campaignId] as const), ...rare.map((r) => [otherOfTerm.get(r.termId) ?? "", r.campaignId] as const)]);
  const otherRows = merged.filter((r) => otherIds.includes(r.entityId));
  for (const r of otherRows) await ctx.tx.insert(M).values({ tenantId: t, entityType: "search_term", entityId: r.entityId, campaignId: campaignOf.get(r.entityId)!, date: r.date, grain: "month", ...values({ ...ZERO_METRICS, ...r }) }).onConflictDoUpdate({ target: [M.entityType, M.entityId, M.grain, M.date], set: values(r) });
  const moved = rare.filter((r) => otherOfTerm.get(r.termId)).map((r) => r.row.id);
  for (let i = 0; i < moved.length; i += 1000) await ctx.tx.delete(M).where(and(eq(M.tenantId, t), inArray(M.id, moved.slice(i, i + 1000))));
  return moved.length;
}
