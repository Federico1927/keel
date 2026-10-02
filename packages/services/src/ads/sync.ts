import { and, desc, eq, inArray, schema, sql, type SQL } from "@keel/db";
import { OTHER_SEARCH_TERM, isNoiseTerm, normalizeSearchText, splitDateWindows, type AdEntityLevel } from "@keel/core";
import { IntegrationError, NO_ADS_CAPABILITIES, type AdsPlatform, type NormalizedEntityMetric } from "@keel/integrations";
import type { ServiceContext } from "../context";
import { recordHealth } from "../sync";

/**
 * Ads below the campaign (issue #40): ad sets, ads, assets, keywords and search terms with daily
 * metrics, pulled in resumable windows. The cursor (phase, level, window) is saved in `sync_runs`
 * after every window; the run pauses at its time budget or on a rate limit and the next call resumes.
 */

const OBJECT_TYPE = "ads_entities";
const CHUNK = 400;

interface EntityCursor {
  since: string;
  until: string;
  phase: "structure" | "metrics";
  level: number;
  window: number;
  counts: Record<string, number>;
}

export interface AdsEntitySyncResult {
  runId: string;
  finished: boolean;
  rateLimited: boolean;
  retryAfterMs: number | null;
  rows: number;
  counts: Record<string, number>;
  error: string | null;
}

/** Levels a platform can fill, in sync order (parents first). */
export function entityLevelsFor(platform: Pick<AdsPlatform, "capabilities" | "fetchEntityMetrics">): AdEntityLevel[] {
  if (!platform.fetchEntityMetrics) return [];
  const c = platform.capabilities ?? NO_ADS_CAPABILITIES;
  return ["ad_set", "ad", ...(c.supportsAssetBreakdown ? ["asset" as const] : []), ...(c.supportsKeywords ? ["keyword" as const] : []), ...(c.supportsSearchTerms ? ["search_term" as const] : [])];
}

const excluded = (col: { name: string }) => sql.raw(`excluded."${col.name}"`);
function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

interface Lookups {
  campaign: Map<string, string>;
  adSet: Map<string, { id: string; campaignId: string }>;
  ad: Map<string, { id: string; campaignId: string; adSetId: string | null }>;
  asset: Map<string, string>;
  keyword: Map<string, { id: string; text: string; adSetId: string | null }>;
}

async function loadLookups(ctx: ServiceContext, provider: string): Promise<Lookups> {
  const t = ctx.tenantId;
  const campaigns = await ctx.tx.select({ id: schema.campaigns.id, ext: schema.campaigns.externalId }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, t), eq(schema.campaigns.platform, provider)));
  const sets = await ctx.tx.select({ id: schema.adSets.id, ext: schema.adSets.externalId, campaignId: schema.adSets.campaignId }).from(schema.adSets).where(and(eq(schema.adSets.tenantId, t), eq(schema.adSets.platform, provider)));
  const ads = await ctx.tx.select({ id: schema.adCreatives.id, ext: schema.adCreatives.externalId, campaignId: schema.adCreatives.campaignId, adSetId: schema.adCreatives.adSetId }).from(schema.adCreatives).where(and(eq(schema.adCreatives.tenantId, t), eq(schema.adCreatives.platform, provider)));
  const assets = await ctx.tx.select({ id: schema.adAssets.id, ext: schema.adAssets.externalId }).from(schema.adAssets).where(and(eq(schema.adAssets.tenantId, t), eq(schema.adAssets.platform, provider)));
  const kws = await ctx.tx.select({ id: schema.adKeywords.id, ext: schema.adKeywords.externalId, text: schema.adKeywords.text, adSetId: schema.adKeywords.adSetId }).from(schema.adKeywords).where(and(eq(schema.adKeywords.tenantId, t), eq(schema.adKeywords.platform, provider)));
  return {
    campaign: new Map(campaigns.map((c) => [c.ext, c.id])),
    adSet: new Map(sets.map((s) => [s.ext, { id: s.id, campaignId: s.campaignId }])),
    ad: new Map(ads.map((a) => [a.ext, { id: a.id, campaignId: a.campaignId, adSetId: a.adSetId }])),
    asset: new Map(assets.map((a) => [a.ext, a.id])),
    keyword: new Map(kws.map((k) => [k.ext, { id: k.id, text: normalizeSearchText(k.text), adSetId: k.adSetId }])),
  };
}

/** Upserts ad sets, ads (into `ad_creatives`), assets and keywords; entities of unknown campaigns are skipped (the campaign sync runs first). */
export async function importAdsStructure(ctx: ServiceContext, platform: AdsPlatform): Promise<Record<string, number>> {
  const provider = platform.provider;
  const now = ctx.now ?? new Date();
  let lk = await loadLookups(ctx, provider);
  const counts = { adSets: 0, ads: 0, assets: 0, keywords: 0 };
  const sets = (await platform.fetchAdSets?.()) ?? [];
  const setRows = sets.filter((s) => lk.campaign.has(s.campaignExternalId)).map((s) => ({ tenantId: ctx.tenantId, campaignId: lk.campaign.get(s.campaignExternalId)!, platform: provider, externalId: s.externalId, name: s.name, status: s.status, optimizationGoal: s.optimizationGoal, dailyBudgetMinor: s.dailyBudgetMinor, syncedAt: now, updatedAt: now }));
  const T = schema.adSets;
  for (const c of chunks(setRows)) await ctx.tx.insert(T).values(c).onConflictDoUpdate({ target: [T.tenantId, T.platform, T.externalId], set: { campaignId: excluded(T.campaignId), name: excluded(T.name), status: excluded(T.status), optimizationGoal: excluded(T.optimizationGoal), dailyBudgetMinor: excluded(T.dailyBudgetMinor), syncedAt: excluded(T.syncedAt), updatedAt: excluded(T.updatedAt) } });
  counts.adSets = setRows.length;
  lk = await loadLookups(ctx, provider);
  const setName = new Map(sets.map((s) => [s.externalId, s.name]));
  const ads = (await platform.fetchAds?.()) ?? [];
  const A = schema.adCreatives;
  const adRows = ads.filter((a) => lk.campaign.has(a.campaignExternalId)).map((a) => ({ tenantId: ctx.tenantId, campaignId: lk.campaign.get(a.campaignExternalId)!, platform: provider, externalId: a.externalId, adsetExternalId: a.adSetExternalId, adsetName: a.adSetExternalId ? (setName.get(a.adSetExternalId) ?? null) : null, adSetId: a.adSetExternalId ? (lk.adSet.get(a.adSetExternalId)?.id ?? null) : null, name: a.name, format: a.format, headline: a.headline, body: a.body, thumbnailUrl: a.thumbnailUrl, status: a.status, finalUrl: a.finalUrl, urlTags: a.urlTags, syncedAt: now, updatedAt: now }));
  // hook / angle / tags are Keel's own grouping and are never overwritten
  for (const c of chunks(adRows)) await ctx.tx.insert(A).values(c).onConflictDoUpdate({ target: [A.tenantId, A.platform, A.externalId], set: { campaignId: excluded(A.campaignId), adsetExternalId: excluded(A.adsetExternalId), adsetName: excluded(A.adsetName), adSetId: excluded(A.adSetId), name: excluded(A.name), format: excluded(A.format), headline: excluded(A.headline), body: excluded(A.body), thumbnailUrl: excluded(A.thumbnailUrl), status: excluded(A.status), finalUrl: excluded(A.finalUrl), urlTags: excluded(A.urlTags), syncedAt: excluded(A.syncedAt), updatedAt: excluded(A.updatedAt) } });
  counts.ads = adRows.length;
  lk = await loadLookups(ctx, provider);
  const assets = (await platform.fetchAssets?.()) ?? [];
  const S = schema.adAssets;
  const assetRows = assets.filter((a) => lk.campaign.has(a.campaignExternalId)).map((a) => ({ tenantId: ctx.tenantId, campaignId: lk.campaign.get(a.campaignExternalId)!, adSetId: a.adSetExternalId ? (lk.adSet.get(a.adSetExternalId)?.id ?? null) : null, creativeId: a.adExternalId ? (lk.ad.get(a.adExternalId)?.id ?? null) : null, platform: provider, externalId: `${a.adExternalId ?? ""}|${a.fieldType}|${a.assetExternalId}`, assetExternalId: a.assetExternalId, type: a.type, fieldType: a.fieldType, textContent: a.text, url: a.url, performanceLabel: a.performanceLabel, syncedAt: now, updatedAt: now }));
  for (const c of chunks(assetRows)) await ctx.tx.insert(S).values(c).onConflictDoUpdate({ target: [S.tenantId, S.platform, S.externalId], set: { creativeId: excluded(S.creativeId), adSetId: excluded(S.adSetId), textContent: excluded(S.textContent), url: excluded(S.url), performanceLabel: excluded(S.performanceLabel), syncedAt: excluded(S.syncedAt), updatedAt: excluded(S.updatedAt) } });
  counts.assets = assetRows.length;
  const keywords = (await platform.fetchKeywords?.()) ?? [];
  const K = schema.adKeywords;
  const kwRows = keywords.filter((k) => lk.campaign.has(k.campaignExternalId)).map((k) => ({ tenantId: ctx.tenantId, campaignId: lk.campaign.get(k.campaignExternalId)!, adSetId: k.adSetExternalId ? (lk.adSet.get(k.adSetExternalId)?.id ?? null) : null, platform: provider, externalId: k.externalId, text: k.text, matchType: k.matchType, qualityScore: k.qualityScore, status: k.status, negative: k.negative, syncedAt: now, updatedAt: now }));
  for (const c of chunks(kwRows)) await ctx.tx.insert(K).values(c).onConflictDoUpdate({ target: [K.tenantId, K.platform, K.externalId], set: { adSetId: excluded(K.adSetId), text: excluded(K.text), matchType: excluded(K.matchType), qualityScore: excluded(K.qualityScore), status: excluded(K.status), negative: excluded(K.negative), syncedAt: excluded(K.syncedAt), updatedAt: excluded(K.updatedAt) } });
  counts.keywords = kwRows.length;
  return counts;
}

type MetricValues = { spendMinor: number; impressions: number; clicks: number; reach: number; conversions: number; conversionValueMinor: number; videoViews3s: number; videoCompletions: number };
const metricOf = (m: NormalizedEntityMetric): MetricValues => ({ spendMinor: m.spendMinor, impressions: m.impressions, clicks: m.clicks, reach: m.reach, conversions: m.conversions, conversionValueMinor: m.conversionValueMinor, videoViews3s: m.videoViews3s, videoCompletions: m.videoCompletions });
const add = (a: MetricValues, b: MetricValues): MetricValues => ({ spendMinor: a.spendMinor + b.spendMinor, impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, reach: a.reach + b.reach, conversions: a.conversions + b.conversions, conversionValueMinor: a.conversionValueMinor + b.conversionValueMinor, videoViews3s: a.videoViews3s + b.videoViews3s, videoCompletions: a.videoCompletions + b.videoCompletions });

/** Ensures one search-term row per (ad group or campaign, normalized text); the "(other)" bucket collects noise. Returns key → id. */
async function ensureSearchTerms(ctx: ServiceContext, provider: string, lk: Lookups, rows: NormalizedEntityMetric[], minImpressions: number): Promise<{ keyOf: (m: NormalizedEntityMetric) => string | null; ids: Map<string, string> }> {
  const now = ctx.now ?? new Date();
  const keyOf = (m: NormalizedEntityMetric) => {
    if (!lk.campaign.has(m.campaignExternalId)) return null;
    const scope = m.adSetExternalId ?? `c${m.campaignExternalId}`;
    return `${scope}|${isNoiseTerm(m, minImpressions) ? OTHER_SEARCH_TERM : normalizeSearchText(m.entityExternalId)}`;
  };
  const wanted = new Map<string, NormalizedEntityMetric>();
  for (const m of rows) {
    const k = keyOf(m);
    if (k && !wanted.has(k)) wanted.set(k, m);
  }
  const T = schema.adSearchTerms;
  const values = [...wanted.entries()].map(([key, m]) => {
    const text = key.slice(key.indexOf("|") + 1);
    const isOther = text === OTHER_SEARCH_TERM;
    const adSet = m.adSetExternalId ? lk.adSet.get(m.adSetExternalId) : undefined;
    const kwByExt = m.keywordExternalId ? (lk.keyword.get(m.keywordExternalId) ?? lk.keyword.get(`${m.adSetExternalId}~${m.keywordExternalId}`)) : undefined;
    const kwByText = !kwByExt && m.keywordText ? [...lk.keyword.values()].find((k) => k.text === normalizeSearchText(m.keywordText) && (!adSet || k.adSetId === adSet.id)) : undefined;
    return { tenantId: ctx.tenantId, campaignId: lk.campaign.get(m.campaignExternalId)!, adSetId: adSet?.id ?? null, keywordId: isOther ? null : ((kwByExt ?? kwByText)?.id ?? null), platform: provider, externalId: key, text, matchType: isOther ? null : (m.matchType ?? null), status: isOther ? "none" : (m.termStatus ?? "none"), isOther, updatedAt: now };
  });
  for (const c of chunks(values)) await ctx.tx.insert(T).values(c).onConflictDoUpdate({ target: [T.tenantId, T.platform, T.externalId], set: { keywordId: sql`coalesce(${excluded(T.keywordId)}, ${T.keywordId})`, matchType: sql`coalesce(${excluded(T.matchType)}, ${T.matchType})`, status: sql`case when ${T.status} = 'excluded' then ${T.status} else ${excluded(T.status)} end`, updatedAt: excluded(T.updatedAt) } });
  const ids = new Map<string, string>();
  for (const c of chunks([...wanted.keys()], 1000)) {
    const found = await ctx.tx.select({ id: T.id, ext: T.externalId }).from(T).where(and(eq(T.tenantId, ctx.tenantId), eq(T.platform, provider), inArray(T.externalId, c)));
    for (const f of found) ids.set(f.ext, f.id);
  }
  return { keyOf, ids };
}

/** Writes one level's rows: ads into `ad_creative_metrics_daily`, the others into `ad_entity_metrics_daily` (restated days overwrite). */
export async function writeEntityMetrics(ctx: ServiceContext, provider: string, level: AdEntityLevel, rows: NormalizedEntityMetric[], opts: { minImpressions: number }): Promise<number> {
  if (!rows.length) return 0;
  const lk = await loadLookups(ctx, provider);
  if (level === "ad") {
    const agg = new Map<string, { creativeId: string; date: string; m: MetricValues }>();
    for (const r of rows) {
      const ad = lk.ad.get(r.entityExternalId);
      if (!ad) continue;
      const k = `${ad.id}|${r.date}`;
      const cur = agg.get(k);
      agg.set(k, { creativeId: ad.id, date: r.date, m: cur ? add(cur.m, metricOf(r)) : metricOf(r) });
    }
    const M = schema.adCreativeMetricsDaily;
    const values = [...agg.values()].map((v) => ({ tenantId: ctx.tenantId, creativeId: v.creativeId, date: v.date, spendMinor: v.m.spendMinor, impressions: v.m.impressions, reach: v.m.reach, clicks: v.m.clicks, purchases: Math.round(v.m.conversions), purchaseValueMinor: v.m.conversionValueMinor, videoViews3s: v.m.videoViews3s }));
    for (const c of chunks(values)) await ctx.tx.insert(M).values(c).onConflictDoUpdate({ target: [M.creativeId, M.date], set: { spendMinor: excluded(M.spendMinor), impressions: excluded(M.impressions), reach: excluded(M.reach), clicks: excluded(M.clicks), purchases: excluded(M.purchases), purchaseValueMinor: excluded(M.purchaseValueMinor), videoViews3s: excluded(M.videoViews3s) } });
    return values.length;
  }
  let resolve: (r: NormalizedEntityMetric) => { id: string; campaignId: string } | null;
  if (level === "ad_set") resolve = (r) => lk.adSet.get(r.entityExternalId) ?? null;
  else if (level === "keyword") resolve = (r) => {
    const k = lk.keyword.get(r.entityExternalId);
    const c = lk.campaign.get(r.campaignExternalId);
    return k && c ? { id: k.id, campaignId: c } : null;
  };
  else if (level === "asset") {
    // assets the structure phase did not list (Meta reports some only in breakdowns) are created from the metric row
    const missing = rows.filter((r) => lk.campaign.has(r.campaignExternalId) && !lk.asset.has(`${r.adExternalId ?? ""}|${r.fieldType ?? "other"}|${r.entityExternalId}`));
    if (missing.length) {
      const S = schema.adAssets;
      const seen = new Set<string>();
      const values = missing.filter((r) => { const k = `${r.adExternalId ?? ""}|${r.fieldType ?? "other"}|${r.entityExternalId}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((r) => ({ tenantId: ctx.tenantId, campaignId: lk.campaign.get(r.campaignExternalId)!, adSetId: r.adSetExternalId ? (lk.adSet.get(r.adSetExternalId)?.id ?? null) : null, creativeId: r.adExternalId ? (lk.ad.get(r.adExternalId)?.id ?? null) : null, platform: provider, externalId: `${r.adExternalId ?? ""}|${r.fieldType ?? "other"}|${r.entityExternalId}`, assetExternalId: r.entityExternalId, type: r.fieldType === "image" || r.fieldType === "video" ? r.fieldType : "text", fieldType: r.fieldType ?? "other" }));
      for (const c of chunks(values)) await ctx.tx.insert(S).values(c).onConflictDoNothing();
      for (const a of await ctx.tx.select({ id: S.id, ext: S.externalId }).from(S).where(and(eq(S.tenantId, ctx.tenantId), eq(S.platform, provider)))) lk.asset.set(a.ext, a.id);
    }
    resolve = (r) => {
      const id = lk.asset.get(`${r.adExternalId ?? ""}|${r.fieldType ?? "other"}|${r.entityExternalId}`);
      const c = lk.campaign.get(r.campaignExternalId);
      return id && c ? { id, campaignId: c } : null;
    };
  } else {
    const terms = await ensureSearchTerms(ctx, provider, lk, rows, opts.minImpressions);
    resolve = (r) => {
      const k = terms.keyOf(r);
      const id = k ? terms.ids.get(k) : undefined;
      return id ? { id, campaignId: lk.campaign.get(r.campaignExternalId)! } : null;
    };
  }
  const agg = new Map<string, { entityId: string; campaignId: string; date: string; m: MetricValues }>();
  for (const r of rows) {
    const e = resolve(r);
    if (!e) continue;
    const k = `${e.id}|${r.date}`;
    const cur = agg.get(k);
    agg.set(k, { entityId: e.id, campaignId: e.campaignId, date: r.date, m: cur ? add(cur.m, metricOf(r)) : metricOf(r) });
  }
  const M = schema.adEntityMetricsDaily;
  const values = [...agg.values()].map((v) => ({ tenantId: ctx.tenantId, entityType: level, entityId: v.entityId, campaignId: v.campaignId, date: v.date, grain: "day", ...v.m }));
  for (const c of chunks(values)) await ctx.tx.insert(M).values(c).onConflictDoUpdate({ target: [M.entityType, M.entityId, M.grain, M.date], set: { spendMinor: excluded(M.spendMinor), impressions: excluded(M.impressions), clicks: excluded(M.clicks), reach: excluded(M.reach), conversions: excluded(M.conversions), conversionValueMinor: excluded(M.conversionValueMinor), videoViews3s: excluded(M.videoViews3s), videoCompletions: excluded(M.videoCompletions) } });
  return values.length;
}

/**
 * Structure first, then each level over 7-day windows (oldest first). Resumes a paused run of the
 * same provider and kind; a rate limit pauses the run with the platform's wait, a budget overrun
 * pauses it silently, any other error fails it.
 */
export async function runAdsEntitySync(ctx: ServiceContext, platform: AdsPlatform, opts: { since: string; until: string; kind?: "delta" | "backfill"; budgetMs?: number; windowDays?: number; minImpressions?: number }): Promise<AdsEntitySyncResult> {
  const provider = platform.provider;
  const kind = opts.kind ?? "delta";
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 25_000;
  const now = ctx.now ?? new Date();
  const levels = entityLevelsFor(platform);
  const runWhere: SQL[] = [eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, provider), eq(schema.syncRuns.objectType, OBJECT_TYPE), eq(schema.syncRuns.kind, kind), eq(schema.syncRuns.status, "paused")];
  const [paused] = await ctx.tx.select().from(schema.syncRuns).where(and(...runWhere)).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  let cursor: EntityCursor;
  let runId: string;
  let rows = 0;
  const baseDuration = paused?.durationMs ?? 0;
  if (paused) {
    cursor = paused.cursor as unknown as EntityCursor;
    runId = paused.id;
    rows = paused.rowsWritten;
    await ctx.tx.update(schema.syncRuns).set({ status: "running", error: null }).where(eq(schema.syncRuns.id, runId));
  } else {
    cursor = { since: opts.since, until: opts.until, phase: "structure", level: 0, window: 0, counts: {} };
    const [row] = await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider, objectType: OBJECT_TYPE, kind, status: "running", cursor, startedAt: now }).returning({ id: schema.syncRuns.id });
    runId = row!.id;
  }
  const windows = splitDateWindows(cursor.since, cursor.until, opts.windowDays ?? 7);
  const save = (status: "running" | "paused" | "success" | "error", error: string | null = null) => ctx.tx.update(schema.syncRuns).set({ status, cursor, rowsWritten: rows, error, summary: { ...cursor.counts }, durationMs: baseDuration + Date.now() - started, ...(status === "success" || status === "error" ? { finishedAt: new Date() } : {}) }).where(eq(schema.syncRuns.id, runId));
  const result = (finished: boolean, error: string | null, rateLimited = false, retryAfterMs: number | null = null): AdsEntitySyncResult => ({ runId, finished, rateLimited, retryAfterMs, rows, counts: { ...cursor.counts }, error });
  try {
    if (cursor.phase === "structure") {
      const c = await importAdsStructure(ctx, platform);
      for (const [k, v] of Object.entries(c)) cursor.counts[k] = (cursor.counts[k] ?? 0) + v;
      rows += Object.values(c).reduce((a, b) => a + b, 0);
      cursor.phase = "metrics";
      await save("running");
    }
    while (cursor.level < levels.length) {
      const level = levels[cursor.level]!;
      while (cursor.window < windows.length) {
        const w = windows[cursor.window]!;
        const fetched = await platform.fetchEntityMetrics!(level, w);
        const n = await writeEntityMetrics(ctx, provider, level, fetched, { minImpressions: opts.minImpressions ?? 10 });
        rows += n;
        cursor.counts[level] = (cursor.counts[level] ?? 0) + n;
        cursor.window++;
        await save("running");
        if (Date.now() - started > budgetMs && (cursor.window < windows.length || cursor.level < levels.length - 1)) {
          await save("paused");
          return result(false, null);
        }
      }
      cursor.level++;
      cursor.window = 0;
    }
    await save("success");
    await recordHealth(ctx, `${provider}:entities`, true, { rowsWritten: rows, lastMetricDate: cursor.until, freshnessMinutes: provider === "google" ? 720 : 240, touchIntegration: false });
    return result(true, null);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (e instanceof IntegrationError && e.code === "rate_limited") {
      // the cursor still points at the window that failed: the next run starts there
      await save("paused", error);
      await recordHealth(ctx, `${provider}:entities`, false, { error, touchIntegration: false });
      return result(false, null, true, e.retryAfterMs ?? 60_000);
    }
    await save("error", error);
    await recordHealth(ctx, `${provider}:entities`, false, { error, touchIntegration: false });
    return result(false, error);
  }
}
