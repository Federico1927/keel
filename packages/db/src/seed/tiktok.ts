import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { isAdPlatformInPlan } from "@hullwise/config";
import { ADS_UTM_TEMPLATES, SALE_STATUSES, ZERO_METRICS, rollupMetricRows, splitExact, type MetricRow } from "@hullwise/core";
import { createRng } from "@hullwise/integrations/rng";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const RETENTION_DAYS = 90;
/** Same advertiser id the TikTok simulator reports (`MOCK_ACCOUNT_IDS.tiktok`). */
const ADVERTISER_ID = "7100000000000000001";
const DOMAIN = "https://northwind-apparel.example";

/**
 * Ad copy: one sentence per ad with no content word shared with another ad or with the Meta/Google copy,
 * so TikTok adds rows to the Words analysis without moving the phrases the other platforms' story is built on.
 */
const BODIES = [
  "Guarda come cade addosso, poi decidi.",
  "Tre abbinamenti per un weekend senza pensieri.",
  "Dal divano all'aperitivo in dieci secondi.",
  "Indossato dalle nostre creator, misure vere.",
  "Il preferito della community questo mese.",
  "Ordinato lunedì, arrivato martedì.",
  "Unboxing onesto: pregi e difetti.",
  "Tinte che reggono cento lavaggi.",
  "Rispondiamo ai vostri commenti in diretta.",
  "Tendenza vista su migliaia di profili.",
  "Abbinalo alle sneakers bianche.",
  "Ultimi pezzi del drop di settembre.",
  "Video reale, nessun filtro.",
  "Perfetto anche per l'ufficio.",
  "Calcola la tua misura in un minuto.",
  "Pronto per il concerto di sabato.",
  "Scelto da chi viaggia leggero.",
  "Prima volta? Usa il codice benvenuto.",
  "Sfida accettata: sette giorni, sette stili.",
  "Dietro le quinte del nostro laboratorio.",
  "Recensione sincera dopo un mese.",
  "Ecco perché lo rifaremmo uguale.",
] as const;
const HOOKS = ["Try-on haul", "Outfit check", "POV", "Unboxing", "Get ready with me", "Duet"] as const;
const ANGLES = ["Social proof", "Novelty", "Price", "Comfort", "Limited stock"] as const;

interface CampaignPlan {
  name: string;
  status: "active" | "paused" | "archived";
  startDaysAgo: number;
  endDaysAgo: number | null;
  /** Share of the TikTok orders it wins on the days it runs. */
  weight: number;
  /** Lifetime spend as a multiple of the approximate margin of its orders: below 1 earns, above 1 loses. */
  spendOverMargin: number;
  /** Floor of the daily spend (minor units), so a campaign without orders still spends. */
  minDailyMinor: number;
  productIdx: number | null;
}

/**
 * TikTok Ads for the demo stores whose plan includes it (Northwind, Growth; Harbor on Starter shows the
 * plan-locked card): an advertiser account connected in mock mode with six campaigns over the last
 * months — a clear winner, a clear loser, a catalog and a retargeting campaign, a paused launch and an
 * archived test — two ad groups each, video ads with copy and the UTM template, daily metrics where ads
 * add up to ad groups and ad groups to the campaign, and the orders TikTok brought (ttclid, utm_* on
 * the order) taken from orders that had no paid attribution, so Meta and Google keep their numbers.
 * Written after the main dataset with its own RNG.
 */
export async function seedTiktok(db: Db, planKey: string, tenantId: string, now: Date): Promise<void> {
  if (!isAdPlatformInPlan("tiktok", planKey)) return;
  const rng = createRng(410041);
  const T = schema;
  const products = await db.select({ id: T.products.id, title: T.products.title, handle: T.products.handle }).from(T.products).where(and(eq(T.products.tenantId, tenantId), eq(T.products.status, "active"))).orderBy(asc(T.products.title)).limit(40);
  if (products.length < 3) return;
  const pick = [products[1 % products.length]!, products[Math.floor(products.length / 2)]!, products[products.length - 2]!];
  const plans: CampaignPlan[] = [
    { name: `Spark Ads – ${pick[0]!.title}`, status: "active", startDaysAgo: 170, endDaysAgo: null, weight: 4, spendOverMargin: 0.35, minDailyMinor: 700, productIdx: 0 },
    { name: `UGC try-on – ${pick[1]!.title}`, status: "active", startDaysAgo: 120, endDaysAgo: null, weight: 0.5, spendOverMargin: 2.8, minDailyMinor: 2600, productIdx: 1 },
    { name: "Smart+ – Catalogo", status: "active", startDaysAgo: 200, endDaysAgo: null, weight: 2.5, spendOverMargin: 0.8, minDailyMinor: 500, productIdx: null },
    { name: "Retargeting 14g – Visitatori", status: "active", startDaysAgo: 150, endDaysAgo: null, weight: 2, spendOverMargin: 0.55, minDailyMinor: 400, productIdx: null },
    { name: `Lancio autunno – ${pick[2]!.title}`, status: "paused", startDaysAgo: 75, endDaysAgo: 9, weight: 1, spendOverMargin: 1.3, minDailyMinor: 1200, productIdx: 2 },
    { name: "Test creatività – estate", status: "archived", startDaysAgo: 230, endDaysAgo: 140, weight: 0.8, spendOverMargin: 1.7, minDailyMinor: 900, productIdx: null },
  ];
  const today = new Date(`${iso(now)}T00:00:00Z`);

  /* ---------- structure: campaigns, ad groups, ads, videos ---------- */
  interface Ad { id: string; ext: string; adSetId: string; adSetExt: string; weight: number; body: string }
  interface Camp extends CampaignPlan { id: string; ext: string; start: Date; end: Date; adSets: { id: string; ext: string; name: string }[]; ads: Ad[] }
  let bodyIdx = 0;
  const camps: Camp[] = plans.map((p, i) => {
    const id = rng.uuid();
    const ext = String(1780000000000100 + i);
    const start = new Date(today.getTime() - p.startDaysAgo * DAY);
    const end = p.endDaysAgo === null ? today : new Date(today.getTime() - p.endDaysAgo * DAY);
    const adSets = (p.status === "archived" ? ["Broad 18-34"] : ["Broad 18-34", "Interessi – moda"]).map((name, g) => ({ id: rng.uuid(), ext: String(1780000000001000 + i * 10 + g), name }));
    const ads: Ad[] = [];
    adSets.forEach((s, g) => {
      for (let a = 0; a < 2; a++) ads.push({ id: rng.uuid(), ext: String(1780000000002000 + i * 100 + g * 10 + a), adSetId: s.id, adSetExt: s.ext, weight: (i === 0 && g === 0 && a === 0 ? 2.2 : 0.5) + rng.next(), body: BODIES[bodyIdx++ % BODIES.length]! });
    });
    return { ...p, id, ext, start, end, adSets, ads };
  });
  const entityStatus = (c: Camp) => (c.status === "archived" ? "archived" : c.status === "paused" ? "paused" : "active");
  await db.insert(T.campaigns).values(camps.map((c) => ({ id: c.id, tenantId, platform: "tiktok", externalId: c.ext, accountExternalId: ADVERTISER_ID, name: c.name, status: c.status, objective: c.productIdx === null && c.name.startsWith("Smart+") ? "PRODUCT_SALES" : "WEB_CONVERSIONS", dailyBudgetMinor: null as number | null, currency: "EUR", platformCreatedAt: c.start, syncedAt: now })));
  const links = camps.filter((c) => c.productIdx !== null).map((c) => ({ tenantId, campaignId: c.id, productId: pick[c.productIdx!]!.id, isPrimary: true, source: "manual" }));
  if (links.length) await db.insert(T.campaignProductLinks).values(links);
  await db.insert(T.adSets).values(camps.flatMap((c) => c.adSets.map((s) => ({ id: s.id, tenantId, campaignId: c.id, platform: "tiktok", externalId: s.ext, name: s.name, status: entityStatus(c), optimizationGoal: "CONVERT", dailyBudgetMinor: null, syncedAt: now }))));
  const slugOf = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await db.insert(T.adCreatives).values(camps.flatMap((c) => c.ads.map((a, k) => {
    const hook = HOOKS[(camps.indexOf(c) + k) % HOOKS.length]!;
    const angle = ANGLES[(camps.indexOf(c) * 2 + k) % ANGLES.length]!;
    const product = c.productIdx === null ? null : pick[c.productIdx]!;
    const landing = product ? `${DOMAIN}/products/${product.handle ?? slugOf(product.title)}` : `${DOMAIN}/collections/nuovi-arrivi`;
    return { id: a.id, tenantId, campaignId: c.id, platform: "tiktok", externalId: a.ext, adsetExternalId: a.adSetExt, adsetName: c.adSets.find((s) => s.id === a.adSetId)!.name, adSetId: a.adSetId, name: `VIDEO | ${hook} | ${angle}`, format: "video", hook: hook.toLowerCase(), angle: angle.toLowerCase(), headline: null, body: a.body, thumbnailUrl: null, status: entityStatus(c), tags: [], finalUrl: `${landing}?${ADS_UTM_TEMPLATES.tiktok}`, urlTags: ADS_UTM_TEMPLATES.tiktok, syncedAt: now };
  })));
  await db.insert(T.adAssets).values(camps.flatMap((c) => c.ads.map((a) => ({ tenantId, campaignId: c.id, adSetId: a.adSetId, creativeId: a.id, platform: "tiktok", externalId: `${a.ext}|video|v10033g5${a.ext.slice(-6)}`, assetExternalId: `v10033g5${a.ext.slice(-6)}`, type: "video", fieldType: "video", textContent: null, url: null, performanceLabel: null, syncedAt: now }))));

  /* ---------- orders TikTok brought: taken from orders without paid attribution ---------- */
  const first = new Date(Math.min(...camps.map((c) => c.start.getTime())));
  const candidates = await db
    .select({ id: T.orderAttribution.id, orderId: T.orderAttribution.orderId, placedAt: T.orders.placedAt })
    .from(T.orderAttribution)
    .innerJoin(T.orders, eq(T.orders.id, T.orderAttribution.orderId))
    .where(and(eq(T.orderAttribution.tenantId, tenantId), isNull(T.orderAttribution.campaignId), inArray(T.orderAttribution.channel, ["direct", "social", "unknown"]), sql`${T.orders.placedAt} >= ${first}`, sql`${T.orders.placedAt} <= ${now}`))
    .orderBy(T.orders.placedAt, T.orders.id);
  const assigned: { attributionId: string; orderId: string; placedAt: Date; camp: Camp; ad: Ad; ttclid: string }[] = [];
  for (const o of candidates) {
    const day = new Date(`${iso(o.placedAt)}T00:00:00Z`);
    const running = camps.filter((c) => day >= c.start && day <= c.end);
    if (!running.length || !rng.chance(0.3)) continue;
    const camp = rng.weighted(running.map((c) => [c, c.weight] as const));
    const ad = rng.weighted(camp.ads.map((a) => [a, a.weight] as const));
    assigned.push({ attributionId: o.id, orderId: o.orderId, placedAt: o.placedAt, camp, ad, ttclid: `E.C.P.${o.orderId.replace(/-/g, "").slice(0, 20)}` });
  }
  // approximate margin of each order still counted as a sale (the same rough P/L the ads seed uses)
  const margin = new Map<string, number>();
  const ids = assigned.map((a) => a.orderId);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.execute<{ id: string; v: number; status: string }>(sql`select o.id, o.status, ((o.total_minor - o.refunded_minor) * 0.8 - coalesce((select sum(l.current_quantity * coalesce(l.unit_cost_minor, 0)) from order_lines l where l.order_id = o.id), 0) - 900)::int as v from orders o where o.id in (${sql.join(chunk.map((x) => sql`${x}::uuid`), sql`, `)})`);
    for (const r of rows.rows) if ((SALE_STATUSES as readonly string[]).includes(r.status)) margin.set(r.id, Number(r.v));
  }
  if (assigned.length) {
    for (let i = 0; i < assigned.length; i += 500) {
      const chunk = assigned.slice(i, i + 500);
      await db.execute(sql`update order_attribution oa set campaign_id = v.c, utm_source = 'tiktok', utm_medium = 'paid_social', utm_campaign = v.ce, utm_content = v.ad, utm_term = v.ag, click_ids = jsonb_build_object('ttclid', v.tt), channel = 'paid_social' from (values ${sql.join(chunk.map((a) => sql`(${a.attributionId}::uuid, ${a.camp.id}::uuid, ${a.camp.ext}::text, ${a.ad.ext}::text, ${a.ad.adSetExt}::text, ${a.ttclid}::text)`), sql`, `)}) as v(id, c, ce, ad, ag, tt) where oa.id = v.id`);
      await db.execute(sql`update orders o set landing_site = split_part(coalesce(o.landing_site, '/'), '?', 1) || '?utm_source=tiktok&utm_medium=paid_social&utm_campaign=' || v.ce || '&utm_content=' || v.ad || '&utm_term=' || v.ag || '&ttclid=' || v.tt from (values ${sql.join(chunk.map((a) => sql`(${a.orderId}::uuid, ${a.camp.ext}::text, ${a.ad.ext}::text, ${a.ad.adSetExt}::text, ${a.ttclid}::text)`), sql`, `)}) as v(id, ce, ad, ag, tt) where o.id = v.id`);
      await db.execute(sql`update touchpoints t set channel = 'paid_social', source = 'tiktok', medium = 'paid_social', utm_campaign = v.ce, utm_content = v.ad, campaign_id = v.c, creative_id = v.cr, click_id = v.tt, paid = true from (values ${sql.join(chunk.map((a) => sql`(${a.orderId}::uuid, ${a.camp.id}::uuid, ${a.camp.ext}::text, ${a.ad.id}::uuid, ${a.ad.ext}::text, ${a.ttclid}::text)`), sql`, `)}) as v(id, c, ce, cr, ad, tt) where t.tenant_id = ${tenantId} and t.order_id = v.id and t.origin = 'order_landing'`);
    }
  }

  /* ---------- daily metrics: campaign = ad groups = ads, every day ---------- */
  // spend floors follow the store's volume (the test seed is a few percent of the demo)
  const volume = Math.min(1, Math.max(0.02, candidates.length / 2000));
  const campaignRows: (typeof T.adMetricsDaily.$inferInsert)[] = [];
  const adRows: (typeof T.adCreativeMetricsDaily.$inferInsert)[] = [];
  const setRows: MetricRow[] = [];
  const campaignOfSet = new Map<string, string>();
  for (const c of camps) {
    const days: string[] = [];
    for (let d = new Date(c.start); d <= c.end; d = new Date(d.getTime() + DAY)) days.push(iso(d));
    const mine = assigned.filter((a) => a.camp === c);
    const lifetimeMargin = mine.reduce((s, a) => s + Math.max(0, margin.get(a.orderId) ?? 0), 0);
    const byMargin = Math.round(lifetimeMargin * c.spendOverMargin);
    const floor = Math.round(c.minDailyMinor * volume) * days.length;
    // a campaign meant to win never gets a spend floor that eats its margin (small stores, the test seed)
    const total = c.spendOverMargin < 1 && lifetimeMargin > 0 ? Math.min(Math.max(byMargin, floor), Math.round(lifetimeMargin * 0.5)) : Math.max(byMargin, floor);
    const ordersByDay = new Map<string, number>();
    const marginByDay = new Map<string, number>();
    for (const a of mine) {
      ordersByDay.set(iso(a.placedAt), (ordersByDay.get(iso(a.placedAt)) ?? 0) + 1);
      marginByDay.set(iso(a.placedAt), (marginByDay.get(iso(a.placedAt)) ?? 0) + Math.max(0, margin.get(a.orderId) ?? 0));
    }
    // spend follows the days that sold (plus a base), so a winner earns and a loser loses over any window
    const perOrder = mine.length ? lifetimeMargin / mine.length : 1;
    const spendByDay = splitExact(total, days.map((d) => 0.5 + rng.next() * 0.4 + 3 * ((marginByDay.get(d) ?? 0) / Math.max(1, perOrder))));
    for (const s of c.adSets) campaignOfSet.set(s.id, c.id);
    days.forEach((date, k) => {
      const spend = spendByDay[k]!;
      const impressions = Math.round(spend * 2.2 * (0.85 + rng.next() * 0.3));
      const clicks = Math.round(impressions * 0.011 * (0.8 + rng.next() * 0.4));
      // the platform claims more than the store saw (view-through, modelled conversions)
      const purchases = Math.round((ordersByDay.get(date) ?? 0) * 1.35 + (rng.chance(0.3) ? 1 : 0));
      const value = Math.round(purchases * 7600 * (0.9 + rng.next() * 0.2));
      campaignRows.push({ tenantId, campaignId: c.id, date, spendMinor: spend, impressions, clicks, viewContent: Math.round(clicks * 0.5), purchases, purchaseValueMinor: value });
      const w = c.ads.map((a) => a.weight);
      const sp = splitExact(spend, w);
      const im = splitExact(impressions, w);
      const cl = splitExact(clicks, w);
      const pu = splitExact(purchases, w);
      const va = splitExact(value, w);
      const perSet = new Map<string, MetricRow>();
      c.ads.forEach((a, j) => {
        const reach = Math.round(im[j]! / 1.4);
        const views = Math.round(im[j]! * 0.33);
        adRows.push({ tenantId, creativeId: a.id, date, spendMinor: sp[j]!, impressions: im[j]!, reach, clicks: cl[j]!, purchases: pu[j]!, purchaseValueMinor: va[j]!, videoViews3s: views });
        const cur = perSet.get(a.adSetId) ?? { ...ZERO_METRICS, entityType: "ad_set", entityId: a.adSetId, date, grain: "day" as const };
        perSet.set(a.adSetId, { ...cur, spendMinor: cur.spendMinor + sp[j]!, impressions: cur.impressions + im[j]!, clicks: cur.clicks + cl[j]!, reach: cur.reach + reach, conversions: cur.conversions + pu[j]!, conversionValueMinor: cur.conversionValueMinor + va[j]!, videoViews3s: cur.videoViews3s + views, videoCompletions: cur.videoCompletions + Math.round(views * 0.12) });
      });
      setRows.push(...perSet.values());
    });
    await db.update(T.campaigns).set({ dailyBudgetMinor: c.status === "archived" ? null : Math.round(total / Math.max(1, days.length) / 100) * 100 }).where(eq(T.campaigns.id, c.id));
  }
  const chunked = async <R>(rows: R[], fn: (c: R[]) => Promise<unknown>, size = 1000) => {
    for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
  };
  await chunked(campaignRows, (c) => db.insert(T.adMetricsDaily).values(c));
  await chunked(adRows, (c) => db.insert(T.adCreativeMetricsDaily).values(c));
  // ad groups: daily rows inside the retention window, monthly before (the shape the retention job leaves)
  const rolled = rollupMetricRows(setRows, iso(new Date(today.getTime() - RETENTION_DAYS * DAY)));
  const entityRows = [...rolled.keep, ...rolled.months].map((m) => ({ tenantId, entityType: m.entityType, entityId: m.entityId, campaignId: campaignOfSet.get(m.entityId)!, date: m.date, grain: m.grain, spendMinor: m.spendMinor, impressions: m.impressions, clicks: m.clicks, reach: m.reach, conversions: m.conversions, conversionValueMinor: m.conversionValueMinor, videoViews3s: m.videoViews3s, videoCompletions: m.videoCompletions }));
  await chunked(entityRows, (c) => db.insert(T.adEntityMetricsDaily).values(c));

  /* ---------- the connection: mock mode, healthy, with its sync history ---------- */
  const hourAgo = new Date(now.getTime() - 36e5);
  await db.insert(T.integrations).values({ tenantId, provider: "tiktok", status: "connected", mode: "mock", externalAccountId: ADVERTISER_ID, externalAccountName: "Northwind Apparel – TikTok", credentialsEncrypted: null, config: { advertiserIds: [ADVERTISER_ID], installedVia: "mock" }, lastSyncAt: hourAgo, lastSuccessAt: hourAgo, lastError: null }).onConflictDoNothing();
  await db.insert(T.integrationHealth).values([
    { tenantId, source: "tiktok", status: "ok", lastSuccessAt: hourAgo, lastAttemptAt: hourAgo, lastMetricDate: iso(new Date(now.getTime() - DAY)), consecutiveFailures: 0, rowsWrittenLast: camps.filter((c) => c.status === "active").length * 4, freshnessMinutes: 120, lastError: null, meta: {} },
    { tenantId, source: "tiktok:entities", status: "ok", lastSuccessAt: new Date(now.getTime() - 26 * 36e5), lastAttemptAt: new Date(now.getTime() - 26 * 36e5), lastMetricDate: iso(now), rowsWrittenLast: entityRows.length, freshnessMinutes: 240, lastError: null, meta: {} },
  ]).onConflictDoNothing();
  await db.insert(T.syncRuns).values([
    { tenantId, provider: "tiktok", objectType: "metrics", kind: "delta", status: "success", cursor: { since: iso(new Date(now.getTime() - 3 * DAY)), until: iso(now) }, rowsWritten: campaignRows.filter((r) => r.date >= iso(new Date(now.getTime() - 3 * DAY))).length, rowsScanned: 0, startedAt: hourAgo, finishedAt: new Date(hourAgo.getTime() + 7_400), durationMs: 7_400 },
    { tenantId, provider: "tiktok", objectType: "ads_entities", kind: "backfill", status: "success", cursor: { since: iso(new Date(now.getTime() - 89 * DAY)), until: iso(now), phase: "metrics", level: 2, window: 0, counts: {} }, rowsWritten: entityRows.length, startedAt: new Date(now.getTime() - 26 * 36e5), finishedAt: new Date(now.getTime() - 26 * 36e5 + 64_000), durationMs: 64_000 },
  ]);
}
