import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { ADS_UTM_TEMPLATES, splitExact } from "@hullwise/core";
import { createRng } from "@hullwise/integrations/rng";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The demo Meta account every store's integration row points at (`MOCK_ACCOUNT_IDS.meta`). */
const PRIMARY = "act_demo";
/** Northwind's second Meta ad account (#82): the outlet business, connected with the same system-user token. */
export const DEMO_SECOND_META_ACCOUNT = { externalId: "act_demo_outlet", name: "Northwind Outlet" } as const;

/** One headline per ad, no word shared with another ad or with the other demo copy, so the Words analysis keeps its story. */
const HEADLINES = ["Cappotti scontati adesso", "Maglioni morbidissimi ribassati", "Occasioni imperdibili oggi", "Giacche leggere metà prezzo", "Sciarpe colorate disponibili", "Jeans comodi selezionati", "Felpe calde rimaste", "Blazer eleganti ultimi", "Chino versatili convenienti", "Gonne plissettate ridotte", "Cardigan avvolgenti quasi esauriti", "Vestiti estivi liquidazione", "Stivaletti robusti promozione", "Borse capienti svendita", "Cinture cuoio sconto", "Polo piquet outlet"] as const;

interface Plan {
  name: string;
  status: "active" | "paused";
  startDaysAgo: number;
  endDaysAgo: number | null;
  dailyMinor: number;
  /** Share of the picked orders it wins. */
  weight: number;
}

/**
 * Meta ad accounts (#82). Every store with Meta gets its integration's account as the primary row;
 * Northwind also runs a second account (its outlet) with four campaigns over the last two months:
 * a profitable clearance campaign, a weak prospecting one, a retargeting one and a paused test. They
 * spend every day and win a few orders taken from orders without paid attribution (after TikTok took
 * its own), so the other campaigns keep their numbers. Written after the main dataset, own RNG.
 */
export async function seedMetaAccounts(db: Db, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  const T = schema;
  const [integ] = await db.select().from(T.integrations).where(and(eq(T.integrations.tenantId, tenantId), eq(T.integrations.provider, "meta"))).limit(1);
  if (!integ || integ.status === "not_connected") return;
  const hourAgo = new Date(now.getTime() - 3600_000);
  await db.insert(T.adAccounts).values({ tenantId, provider: "meta", externalAccountId: integ.externalAccountId ?? PRIMARY, name: integ.externalAccountName ?? PRIMARY, isPrimary: true, status: "connected", mode: "mock", cursor: { since: iso(new Date(now.getTime() - 3 * DAY)), until: iso(now), lastMetricDate: iso(new Date(now.getTime() - DAY)) }, lastSyncAt: hourAgo, lastSuccessAt: hourAgo }).onConflictDoNothing();
  if (key !== "northwind") return;

  const rng = createRng(820082);
  const acc = DEMO_SECOND_META_ACCOUNT;
  const plans: Plan[] = [
    { name: "Outlet – Saldi fine stagione", status: "active", startDaysAgo: 58, endDaysAgo: null, dailyMinor: 2200, weight: 4 },
    { name: "Outlet – Prospecting broad", status: "active", startDaysAgo: 45, endDaysAgo: null, dailyMinor: 3800, weight: 0.6 },
    { name: "Outlet – Retargeting 7g", status: "active", startDaysAgo: 40, endDaysAgo: null, dailyMinor: 900, weight: 1.6 },
    { name: "Outlet – Test video", status: "paused", startDaysAgo: 30, endDaysAgo: 12, dailyMinor: 1500, weight: 0.4 },
  ];
  const today = new Date(`${iso(now)}T00:00:00Z`);
  const tags = ADS_UTM_TEMPLATES.meta;
  const camps = plans.map((p, i) => {
    const id = rng.uuid();
    const ext = String(120900000000 + i * 7);
    const adSets = ["Broad 25-54", "Lookalike 2%"].map((name, g) => ({ id: rng.uuid(), ext: `${ext}${g + 1}0`, name }));
    const ads = adSets.flatMap((set, g) => [0, 1].map((a) => ({ id: rng.uuid(), ext: `2386${String(500000 + i * 100 + g * 10 + a)}`, set, weight: (i === 0 && g === 0 && a === 0 ? 2 : 0.6) + rng.next(), format: a ? "video" : "carousel" })));
    return { ...p, id, ext, adSets, ads, start: new Date(today.getTime() - p.startDaysAgo * DAY), end: p.endDaysAgo === null ? today : new Date(today.getTime() - p.endDaysAgo * DAY) };
  });
  const st = (c: (typeof camps)[number]) => (c.status === "paused" ? "paused" : "active");
  await db.insert(T.adAccounts).values({ tenantId, provider: "meta", externalAccountId: acc.externalId, name: acc.name, isPrimary: false, status: "connected", mode: "mock", cursor: { since: iso(new Date(now.getTime() - 3 * DAY)), until: iso(now), lastMetricDate: iso(new Date(now.getTime() - DAY)) }, lastSyncAt: hourAgo, lastSuccessAt: hourAgo }).onConflictDoNothing();
  await db.insert(T.campaigns).values(camps.map((c) => ({ id: c.id, tenantId, platform: "meta", externalId: c.ext, accountExternalId: acc.externalId, name: c.name, status: c.status, objective: "OUTCOME_SALES", dailyBudgetMinor: c.dailyMinor, currency: "EUR", platformCreatedAt: c.start, syncedAt: now })));
  await db.insert(T.adSets).values(camps.flatMap((c) => c.adSets.map((s) => ({ id: s.id, tenantId, campaignId: c.id, platform: "meta", externalId: s.ext, accountExternalId: acc.externalId, name: s.name, status: st(c), optimizationGoal: "OFFSITE_CONVERSIONS", dailyBudgetMinor: null, syncedAt: now }))));
  await db.insert(T.adCreatives).values(camps.flatMap((c, i) => c.ads.map((a, k) => ({ id: a.id, tenantId, campaignId: c.id, platform: "meta", externalId: a.ext, accountExternalId: acc.externalId, adsetExternalId: a.set.ext, adsetName: a.set.name, adSetId: a.set.id, name: `${a.format.toUpperCase()} | Outlet | ${k % 2 ? "Price" : "Limited stock"}`, format: a.format, hook: "outlet", angle: k % 2 ? "price" : "limited stock", headline: HEADLINES[(i * 4 + k) % HEADLINES.length]!, body: null, thumbnailUrl: null, status: st(c), tags: [], finalUrl: `https://northwind-apparel.example/collections/outlet?${tags}`, urlTags: tags, syncedAt: now }))));

  // orders won: about 3% of the unattributed sale orders since the first campaign started
  const first = new Date(Math.min(...camps.map((c) => c.start.getTime())));
  const candidates = await db
    .select({ id: T.orderAttribution.id, orderId: T.orderAttribution.orderId, placedAt: T.orders.placedAt })
    .from(T.orderAttribution)
    .innerJoin(T.orders, eq(T.orders.id, T.orderAttribution.orderId))
    .where(and(eq(T.orderAttribution.tenantId, tenantId), isNull(T.orderAttribution.campaignId), inArray(T.orderAttribution.channel, ["direct", "social", "unknown"]), sql`${T.orders.placedAt} >= ${first}`, sql`${T.orders.placedAt} <= ${now}`))
    .orderBy(asc(T.orders.placedAt), asc(T.orderAttribution.id));
  const pickWeighted = <X extends { weight: number }>(xs: X[]): X => {
    let r = rng.next() * xs.reduce((s, x) => s + x.weight, 0);
    return xs.find((x) => (r -= x.weight) < 0) ?? xs[xs.length - 1]!;
  };
  const won: { attributionId: string; camp: (typeof camps)[number]; ad: (typeof camps)[number]["ads"][number]; fbclid: string }[] = [];
  for (const o of candidates) {
    if (!rng.chance(0.03)) continue;
    const live = camps.filter((c) => o.placedAt >= c.start && o.placedAt <= new Date(c.end.getTime() + DAY));
    if (!live.length) continue;
    const camp = pickWeighted(live);
    won.push({ attributionId: o.id, camp, ad: pickWeighted(camp.ads), fbclid: `IwAR${rng.int(1e8, 9e8)}` });
  }
  for (let i = 0; i < won.length; i += 500) {
    const chunk = won.slice(i, i + 500);
    await db.execute(sql`update order_attribution oa set campaign_id = v.c, ad_account_external_id = ${acc.externalId}, utm_source = 'facebook', utm_medium = 'paid', utm_campaign = v.ce, utm_content = v.ad, utm_term = v.ag, click_ids = jsonb_build_object('fbclid', v.fb), channel = 'paid_social' from (values ${sql.join(chunk.map((a) => sql`(${a.attributionId}::uuid, ${a.camp.id}::uuid, ${a.camp.ext}::text, ${a.ad.ext}::text, ${a.ad.set.ext}::text, ${a.fbclid}::text)`), sql`, `)}) as v(id, c, ce, ad, ag, fb) where oa.id = v.id`);
  }

  // daily spend, split exactly over the ads (ad sets add up their ads), with the purchases Meta claims (more than the real ones, as usual)
  const wins = new Map<string, number>();
  for (const w of won) wins.set(w.camp.id, (wins.get(w.camp.id) ?? 0) + 1);
  const metrics: (typeof T.adMetricsDaily.$inferInsert)[] = [];
  const adMetrics: (typeof T.adCreativeMetricsDaily.$inferInsert)[] = [];
  const setMetrics: (typeof T.adEntityMetricsDaily.$inferInsert)[] = [];
  for (const c of camps) {
    const days = Math.max(1, Math.round((c.end.getTime() - c.start.getTime()) / DAY));
    const claimed = Math.round(((wins.get(c.id) ?? 0) * 1.4) / days * 100) / 100;
    const weights = c.ads.map((a) => a.weight);
    for (let d = new Date(c.start); d <= c.end; d = new Date(d.getTime() + DAY)) {
      const spend = Math.round(c.dailyMinor * (0.7 + rng.next() * 0.6));
      const impressions = Math.round(spend / 6);
      const clicks = Math.round(impressions * (0.009 + rng.next() * 0.012));
      const purchases = rng.chance(claimed % 1) ? Math.ceil(claimed) : Math.floor(claimed);
      const value = purchases * rng.int(5500, 9500);
      const date = iso(d);
      metrics.push({ tenantId, campaignId: c.id, date, accountExternalId: acc.externalId, spendMinor: spend, impressions, clicks, viewContent: Math.round(clicks * 0.55), purchases, purchaseValueMinor: value });
      const [sp, im, cl, pu, va] = [spend, impressions, clicks, purchases, value].map((v) => splitExact(v, weights));
      c.ads.forEach((a, k) => adMetrics.push({ tenantId, creativeId: a.id, date, spendMinor: sp![k]!, impressions: im![k]!, reach: Math.round(im![k]! * 0.8), clicks: cl![k]!, purchases: pu![k]!, purchaseValueMinor: va![k]!, videoViews3s: a.format === "video" ? Math.round(im![k]! * 0.3) : 0 }));
      for (const set of c.adSets) {
        const ks = c.ads.map((a, k) => (a.set === set ? k : -1)).filter((k) => k >= 0);
        const sum = (xs: number[]) => ks.reduce((t, k) => t + xs[k]!, 0);
        setMetrics.push({ tenantId, entityType: "ad_set", entityId: set.id, campaignId: c.id, date, grain: "day", spendMinor: sum(sp!), impressions: sum(im!), clicks: sum(cl!), reach: Math.round(sum(im!) * 0.8), conversions: sum(pu!), conversionValueMinor: sum(va!), videoViews3s: 0, videoCompletions: 0 });
      }
    }
  }
  for (let i = 0; i < metrics.length; i += 1000) await db.insert(T.adMetricsDaily).values(metrics.slice(i, i + 1000));
  for (let i = 0; i < adMetrics.length; i += 1000) await db.insert(T.adCreativeMetricsDaily).values(adMetrics.slice(i, i + 1000));
  for (let i = 0; i < setMetrics.length; i += 1000) await db.insert(T.adEntityMetricsDaily).values(setMetrics.slice(i, i + 1000));
}
