import { and, eq, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { createRng } from "@hullwise/integrations/rng";
import { ADS_UTM_TEMPLATES, OTHER_SEARCH_TERM, SALE_STATUSES, ZERO_METRICS, groupRareTerms, rollupMetricRows, splitExact, type MetricRow } from "@hullwise/core";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const DAY = 864e5;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const RETENTION_DAYS = 90;
const MIN_IMPRESSIONS = 10;

/** Copy and vocabulary per demo store: a winning two-word phrase, the words it is made of used in losing ads, and neutral pools. */
const COPY = {
  northwind: {
    win: "lino naturale",
    winHeadlines: ["Camicia in lino naturale", "Lino naturale per giornate calde", "Abito leggero di lino naturale", "Pantalone ampio, lino naturale", "Lino naturale tinto in capo", "Gilet sartoriale, lino naturale"],
    loseHeadlines: ["Lino e cotone, look naturale", "Saldi lino fino al 30%", "Look naturale in città", "Effetto naturale garantito"],
    pool: ["Spedizione gratuita", "Reso facile in 30 giorni", "Nuova collezione autunno", "Qualità sartoriale", "Prezzi outlet", "Edizione limitata", "Cotone biologico", "Prodotto in Italia", "Consegna in 24 ore", "Scopri lo stile", "Taglio moderno", "Colori di stagione"],
    winBodies: ["Fresco e traspirante.", "Morbido al tatto.", "Cucito a mano.", "Comodo dalla mattina alla sera.", "Tessuto certificato.", "Vestibilità rilassata."],
    nouns: ["camicia", "abito", "maglione", "giacca", "pantaloni", "gonna", "cappotto", "felpa"],
    qualifiers: ["donna", "uomo", "cotone", "elegante", "estiva", "invernale", "oversize", "lunga"],
    modifiers: ["saldi", "online", "prezzo", "outlet", "offerta", "economica"],
    free: "gratis",
    waste: "vestiti gratis",
    rsaExtra: ["Consegna rapida", "Resi semplici", "Nuovi arrivi ogni settimana", "Paga in tre rate"],
    rsaDescriptions: ["Scopri la collezione e scegli il tuo stile.", "Spedizione in 24 ore e cambio taglia facile.", "Materiali selezionati, prezzi chiari."],
    domain: "https://northwind-apparel.example",
  },
  harbor: {
    win: "solid oak",
    winHeadlines: ["Dining table in solid oak", "Solid oak, built to last", "Handmade bench of solid oak", "Bedside table, solid oak", "Solid oak shelves for every room", "Coffee table carved from solid oak"],
    loseHeadlines: ["Oak finish in solid colors", "Oak and walnut, now 30% off", "Solid colors for spring", "Solid deals this weekend"],
    pool: ["Free shipping", "Easy 30-day returns", "New fall collection", "Designer quality", "Outlet prices", "Limited edition", "Organic cotton", "Made in the USA", "Delivery in 48 hours", "Discover the look", "Modern lines", "Seasonal colors"],
    winBodies: ["Sanded by hand.", "Natural oil finish.", "Delivered assembled.", "Ten-year warranty.", "Sustainably sourced timber.", "Rounded safe corners."],
    nouns: ["dining table", "accent chair", "floor lamp", "area rug", "bookshelf", "bed frame", "throw pillows", "wall mirror"],
    qualifiers: ["modern", "wooden", "large", "small", "white", "velvet", "outdoor", "round"],
    modifiers: ["sale", "cheap", "near me", "best", "online", "for sale"],
    free: "free",
    waste: "free furniture",
    rsaExtra: ["Fast delivery", "Simple returns", "New arrivals weekly", "Pay in 4 installments"],
    rsaDescriptions: ["Browse the collection and find your style.", "Delivery in 48 hours and easy returns.", "Selected materials, clear prices."],
    domain: "https://harbor-home.example",
  },
} as const;

interface AdRow { id: string; campaignId: string; externalId: string; adsetExternalId: string | null; adsetName: string | null; platform: string; format: string; status: string; headline: string | null; name: string }
interface Day { id: string; creativeId: string; date: string; spendMinor: number; impressions: number; clicks: number; reach: number; purchases: number; purchaseValueMinor: number; videoViews3s: number }

async function chunked<T>(rows: T[], fn: (c: T[]) => Promise<unknown>, size = 500) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/**
 * Ads below the campaign for a demo store (issue #40), written after the main dataset with its own
 * RNG so nothing else moves: ad sets / ad groups, the ads' copy and UTM templates, RSA and
 * dynamic-creative assets, Google keywords and search terms, daily metrics for the last 90 days and
 * monthly roll-ups before (the shape the retention job leaves), and the orders' `utm_content` /
 * `utm_term` the templates would have produced. Designed so every tab has a story: a wasted-spend
 * search term whose only orders were cancelled, a winning two-word phrase in the copy of the
 * profitable ads, losing ads that use its words separately, one campaign whose ads miss the UTMs.
 */
export async function seedAdsDepth(db: Db, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  const rng = createRng(key === "northwind" ? 404001 : 404002);
  const copy = COPY[key];
  const T = schema;
  const campaigns = await db.select({ id: T.campaigns.id, externalId: T.campaigns.externalId, platform: T.campaigns.platform, name: T.campaigns.name, status: T.campaigns.status }).from(T.campaigns).where(eq(T.campaigns.tenantId, tenantId)).orderBy(T.campaigns.platform, T.campaigns.externalId);
  if (!campaigns.length) return;
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const ads: AdRow[] = await db.select({ id: T.adCreatives.id, campaignId: T.adCreatives.campaignId, externalId: T.adCreatives.externalId, adsetExternalId: T.adCreatives.adsetExternalId, adsetName: T.adCreatives.adsetName, platform: T.adCreatives.platform, format: T.adCreatives.format, status: T.adCreatives.status, headline: T.adCreatives.headline, name: T.adCreatives.name }).from(T.adCreatives).where(eq(T.adCreatives.tenantId, tenantId)).orderBy(T.adCreatives.externalId);
  const adsByCampaign = new Map<string, AdRow[]>();
  for (const a of ads) adsByCampaign.set(a.campaignId, [...(adsByCampaign.get(a.campaignId) ?? []), a]);
  const adByExt = new Map(ads.map((a) => [`${a.campaignId}|${a.externalId}`, a]));
  const days: Day[] = await db.select({ id: T.adCreativeMetricsDaily.id, creativeId: T.adCreativeMetricsDaily.creativeId, date: T.adCreativeMetricsDaily.date, spendMinor: T.adCreativeMetricsDaily.spendMinor, impressions: T.adCreativeMetricsDaily.impressions, clicks: T.adCreativeMetricsDaily.clicks, reach: T.adCreativeMetricsDaily.reach, purchases: T.adCreativeMetricsDaily.purchases, purchaseValueMinor: T.adCreativeMetricsDaily.purchaseValueMinor, videoViews3s: T.adCreativeMetricsDaily.videoViews3s }).from(T.adCreativeMetricsDaily).where(eq(T.adCreativeMetricsDaily.tenantId, tenantId)).orderBy(T.adCreativeMetricsDaily.date, T.adCreativeMetricsDaily.creativeId);
  const google = campaigns.filter((c) => c.platform === "google");

  /* ---------- ad sets / ad groups ---------- */
  const adSetIdByKey = new Map<string, string>();
  const adSetRows: (typeof T.adSets.$inferInsert)[] = [];
  for (const a of ads) {
    const k = `${a.campaignId}|${a.adsetExternalId ?? "default"}`;
    if (adSetIdByKey.has(k)) continue;
    const id = rng.uuid();
    adSetIdByKey.set(k, id);
    const c = campaignById.get(a.campaignId)!;
    const n = adSetIdByKey.size;
    const name = c.platform === "meta" ? (a.adsetName ?? "Ad set") : `${copy.nouns[n % copy.nouns.length]} – ${n % 2 ? "exact" : "broad"}`;
    adSetRows.push({ id, tenantId, campaignId: a.campaignId, platform: c.platform, externalId: a.adsetExternalId ?? `${c.externalId}-as1`, name, status: c.status === "archived" ? "archived" : a.status === "paused" && c.status === "active" ? "active" : c.status, optimizationGoal: c.platform === "meta" ? "OFFSITE_CONVERSIONS" : "SEARCH_STANDARD", dailyBudgetMinor: null, syncedAt: now });
  }
  await chunked(adSetRows, (c) => db.insert(T.adSets).values(c));
  const adSetOf = (a: AdRow) => adSetIdByKey.get(`${a.campaignId}|${a.adsetExternalId ?? "default"}`)!;
  const adSetExtOf = new Map(adSetRows.map((s) => [s.id!, s.externalId]));

  /* ---------- Google keywords and the wasted-spend term ---------- */
  interface Kw { id: string; campaignId: string; adSetId: string; text: string; matchType: "exact" | "phrase" | "broad"; weight: number; terms: { id: string; text: string; weight: number; noConv: boolean }[]; waste: boolean }
  const keywords: Kw[] = [];
  for (const c of google) {
    for (const adSetId of new Set((adsByCampaign.get(c.id) ?? []).map(adSetOf))) {
      const used = new Set<string>();
      const n = rng.int(4, 6);
      for (let i = 0; i < n; i++) {
        let text = `${rng.pick(copy.nouns)} ${rng.pick(copy.qualifiers)}`;
        if (key === "harbor") text = `${rng.pick(copy.qualifiers)} ${rng.pick(copy.nouns)}`;
        if (used.has(text)) continue;
        used.add(text);
        const matchType = rng.weighted([["exact", 40], ["phrase", 30], ["broad", 30]] as const);
        const variants = matchType === "exact" ? [text] : matchType === "phrase" ? [text, `${text} ${rng.pick(copy.modifiers)}`, `${rng.pick(copy.modifiers)} ${text}`] : [text, `${rng.pick(copy.modifiers)} ${text}`, `${text} ${rng.pick(copy.modifiers)}`, key === "northwind" ? `${text} ${copy.free}` : `${copy.free} ${text}`, `${rng.pick(copy.qualifiers)} ${text.split(" ").at(-1)}`];
        const terms = [...new Set(variants)].map((t, j) => ({ id: rng.uuid(), text: t, weight: j === 0 ? 3 : 0.4 + rng.next(), noConv: t.includes(copy.free) }));
        keywords.push({ id: rng.uuid(), campaignId: c.id, adSetId, text, matchType, weight: 0.5 + rng.next() * 1.5, terms, waste: false });
      }
    }
  }

  /* ---------- orders: the UTMs the templates would have produced ---------- */
  const attribution = await db
    .select({ id: T.orderAttribution.id, orderId: T.orderAttribution.orderId, campaignId: T.orderAttribution.campaignId, utmContent: T.orderAttribution.utmContent, status: T.orders.status, placedAt: T.orders.placedAt })
    .from(T.orderAttribution)
    .innerJoin(T.orders, eq(T.orders.id, T.orderAttribution.orderId))
    .where(and(eq(T.orderAttribution.tenantId, tenantId), sql`${T.orderAttribution.campaignId} is not null`))
    .orderBy(T.orders.placedAt, T.orders.id);
  const utm = new Map<string, { content: string | null; term: string | null }>();
  for (const a of attribution) {
    const c = campaignById.get(a.campaignId!);
    if (!c) continue;
    if (c.platform === "meta") {
      const ad = a.utmContent ? adByExt.get(`${c.id}|${a.utmContent}`) : undefined;
      utm.set(a.id, { content: a.utmContent, term: ad ? (adSetExtOf.get(adSetOf(ad)) ?? null) : null });
    } else {
      const list = adsByCampaign.get(c.id) ?? [];
      const ad = list.length ? rng.pick(list) : null;
      const kws = keywords.filter((k) => k.campaignId === c.id && !k.waste && (!ad || k.adSetId === adSetOf(ad)));
      const kw = kws.length ? rng.weighted(kws.map((k) => [k, k.weight] as const)) : null;
      utm.set(a.id, { content: ad?.externalId ?? null, term: kw?.text ?? null });
    }
  }
  /* ---------- winners: profitable ads in the last 90 days carry the winning phrase ---------- */
  const since90 = new Date(now.getTime() - 90 * DAY);
  const sale = SALE_STATUSES as readonly string[];
  const orderIds = attribution.filter((a) => a.placedAt >= since90 && sale.includes(a.status)).map((a) => a.orderId);
  const approx = new Map<string, number>();
  if (orderIds.length) {
    const rows = await db.execute<{ id: string; v: number }>(sql`select o.id, ((o.total_minor - o.refunded_minor) * 0.8 - coalesce((select sum(l.current_quantity * coalesce(l.unit_cost_minor, 0)) from order_lines l where l.order_id = o.id), 0) - 900)::int as v from orders o where o.id in ${sql`(${sql.join(orderIds.map((i) => sql`${i}::uuid`), sql`, `)})`}`);
    for (const r of rows.rows) approx.set(r.id, Number(r.v));
  }
  // one Meta campaign (the one whose recent orders earn the least) has ads without utm_content / utm_term: its orders reach Hullwise without an ad
  const campaignMargin = new Map<string, number>();
  for (const a of attribution) if (approx.has(a.orderId)) campaignMargin.set(a.campaignId!, (campaignMargin.get(a.campaignId!) ?? 0) + approx.get(a.orderId)!);
  const metaWithAds = campaigns.filter((c) => c.platform === "meta" && (adsByCampaign.get(c.id)?.length ?? 0) > 0).sort((x, y) => (campaignMargin.get(x.id) ?? 0) - (campaignMargin.get(y.id) ?? 0) || x.externalId.localeCompare(y.externalId));
  const missingUtm = metaWithAds.length > 1 ? (metaWithAds.find((c) => c.status === "active") ?? metaWithAds[0]!) : null;
  if (missingUtm) for (const a of attribution) if (a.campaignId === missingUtm.id) utm.set(a.id, { content: null, term: null });
  const marginByAd = new Map<string, { margin: number; orders: number }>();
  const tally = () => {
    marginByAd.clear();
    for (const a of attribution) {
      const v = approx.get(a.orderId);
      const u = utm.get(a.id);
      if (v === undefined || !u?.content) continue;
      const ad = adByExt.get(`${a.campaignId}|${u.content}`);
      if (!ad) continue;
      const cur = marginByAd.get(ad.id) ?? { margin: 0, orders: 0 };
      marginByAd.set(ad.id, { margin: cur.margin + v, orders: cur.orders + 1 });
    }
  };
  tally();
  const eligible = () => ads.filter((a) => (marginByAd.get(a.id)?.margin ?? 0) > 0 && (adsByCampaign.get(a.campaignId)?.length ?? 0) >= 2);
  const usable = () => new Set(eligible().map((a) => a.campaignId)).size;
  // small stores (the test scale): fewer than two profitable ads, so recent sale orders of other campaigns are pointed at one ad each
  if (usable() < 2) {
    const have = new Set(eligible().map((a) => a.campaignId));
    const spare = attribution.filter((a) => approx.has(a.orderId) && (approx.get(a.orderId) ?? 0) > 0 && !have.has(a.campaignId!) && a.campaignId !== missingUtm?.id && (adsByCampaign.get(a.campaignId!)?.length ?? 0) >= 2);
    for (const a of spare) {
      if (usable() >= 2) break;
      if (have.has(a.campaignId!)) continue;
      const c = campaignById.get(a.campaignId!)!;
      const ad = adsByCampaign.get(c.id)![0]!;
      utm.set(a.id, { content: ad.externalId, term: c.platform === "meta" ? (adSetExtOf.get(adSetOf(ad)) ?? null) : (utm.get(a.id)?.term ?? null) });
      have.add(c.id);
      tally();
    }
  }
  const recentFrom = iso(new Date(now.getTime() - 95 * DAY));
  const spend90 = new Map<string, number>();
  for (const d of days) if (d.date >= iso(since90)) spend90.set(d.creativeId, (spend90.get(d.creativeId) ?? 0) + d.spendMinor);
  // a winner needs a sibling ad in its campaign that is not a winner, to take the spend it gives up
  const perCampaign = new Map<string, number>();
  const winners = eligible()
    .sort((x, y) => marginByAd.get(y.id)!.margin - marginByAd.get(x.id)!.margin || x.externalId.localeCompare(y.externalId))
    .filter((a) => {
      const n = perCampaign.get(a.campaignId) ?? 0;
      if (n + 1 >= (adsByCampaign.get(a.campaignId)?.length ?? 0)) return false;
      perCampaign.set(a.campaignId, n + 1);
      return true;
    })
    .slice(0, 6);
  const winnerIds = new Set(winners.map((w) => w.id));
  // their spend in the last 95 days drops to 15% of their margin; a sibling ad of the same campaign takes the rest that day (campaign totals unchanged)
  const changed = new Map<string, Day>();
  const byDay = new Map<string, Day[]>();
  for (const d of days) if (d.date >= recentFrom) byDay.set(`${d.date}`, [...(byDay.get(d.date) ?? []), d]);
  const campaignOfAd = new Map(ads.map((a) => [a.id, a.campaignId]));
  for (const w of winners) {
    const target = Math.round(marginByAd.get(w.id)!.margin * 0.15);
    const mine = days.filter((d) => d.creativeId === w.id && d.date >= recentFrom);
    const total = mine.reduce((s, d) => s + d.spendMinor, 0);
    if (total <= target || total === 0) continue;
    const f = target / total;
    for (const d of mine) {
      const sibling = (byDay.get(d.date) ?? []).filter((x) => x.creativeId !== w.id && !winnerIds.has(x.creativeId) && campaignOfAd.get(x.creativeId) === w.campaignId).sort((a, b) => b.spendMinor - a.spendMinor || a.creativeId.localeCompare(b.creativeId))[0];
      if (!sibling) continue;
      const keep = Math.floor(d.spendMinor * f);
      sibling.spendMinor += d.spendMinor - keep;
      d.spendMinor = keep;
      changed.set(d.id, d);
      changed.set(sibling.id, sibling);
    }
  }
  await chunked([...changed.values()], (c) => db.execute(sql`update ad_creative_metrics_daily m set spend_minor = v.s from (values ${sql.join(c.map((d) => sql`(${d.id}::uuid, ${d.spendMinor}::int)`), sql`, `)}) as v(id, s) where m.id = v.id`));
  /* ---------- the wasted-spend term: an exact keyword in the busiest Google ad group whose only orders were cancelled ---------- */
  const since30 = iso(new Date(now.getTime() - 30 * DAY));
  const groupSpend = new Map<string, number>();
  for (const d of days) {
    if (d.date < since30) continue;
    const ad = ads.find((a) => a.id === d.creativeId);
    if (ad && campaignById.get(ad.campaignId)?.platform === "google") groupSpend.set(adSetOf(ad), (groupSpend.get(adSetOf(ad)) ?? 0) + d.spendMinor);
  }
  const wasteGroup = [...groupSpend.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const wasteCampaign = wasteGroup ? campaignById.get(adSetRows.find((r) => r.id === wasteGroup)!.campaignId)! : null;
  if (wasteGroup && wasteCampaign) {
    keywords.push({ id: rng.uuid(), campaignId: wasteCampaign.id, adSetId: wasteGroup, text: copy.waste, matchType: "exact", weight: 1.2, terms: [{ id: rng.uuid(), text: copy.waste, weight: 1, noConv: true }], waste: true });
    // the most recent cancelled orders (attributed or not; small stores may have none in the last weeks) become its clicks
    const cancelled = await db.select({ id: T.orderAttribution.id, placedAt: T.orders.placedAt }).from(T.orderAttribution).innerJoin(T.orders, eq(T.orders.id, T.orderAttribution.orderId)).where(and(eq(T.orderAttribution.tenantId, tenantId), eq(T.orders.status, "cancelled"), sql`${T.orders.placedAt} <= ${now}`)).orderBy(sql`${T.orders.placedAt} desc`, T.orders.id).limit(3);
    const wasteAd = (adsByCampaign.get(wasteCampaign.id) ?? []).find((a) => adSetOf(a) === wasteGroup) ?? null;
    const within = cancelled.filter((c) => c.placedAt.getTime() >= now.getTime() - 30 * DAY);
    for (const { id } of within.length ? within : cancelled.slice(0, 1)) {
      utm.set(id, { content: wasteAd?.externalId ?? null, term: copy.waste });
      await db.update(T.orderAttribution).set({ campaignId: wasteCampaign.id, utmSource: "google", utmMedium: "cpc", utmCampaign: wasteCampaign.externalId, utmContent: wasteAd?.externalId ?? null, utmTerm: copy.waste, channel: "paid_search", clickIds: { gclid: `Cj0KCQ-waste-${id.slice(0, 8)}` } }).where(eq(T.orderAttribution.id, id));
      const hit = attribution.find((a) => a.id === id);
      if (hit) hit.campaignId = wasteCampaign.id;
    }
  }

  const spendAfter = new Map<string, number>();
  for (const d of days) if (d.date >= iso(since90)) spendAfter.set(d.creativeId, (spendAfter.get(d.creativeId) ?? 0) + d.spendMinor);
  const losers = ads.filter((a) => !winnerIds.has(a.id) && !marginByAd.get(a.id) && (spendAfter.get(a.id) ?? 0) > 0).sort((x, y) => (spendAfter.get(y.id) ?? 0) - (spendAfter.get(x.id) ?? 0) || x.externalId.localeCompare(y.externalId)).slice(0, 4);
  const loserIds = new Set(losers.map((l) => l.id));
  void spend90;

  // one Meta campaign (not a winner's) whose ads miss utm_content / utm_term: its orders reach Hullwise without an ad
  const updates = attribution.filter((a) => utm.has(a.id)).map((a) => ({ id: a.id, ...utm.get(a.id)! }));
  await chunked(updates, (c) => db.execute(sql`update order_attribution oa set utm_content = v.c, utm_term = v.t from (values ${sql.join(c.map((u) => sql`(${u.id}::uuid, ${u.content}::text, ${u.term}::text)`), sql`, `)}) as v(id, c, t) where oa.id = v.id`));

  /* ---------- ads: copy, URL, UTM template, ad set ---------- */
  const poolFor = (i: number) => [copy.pool[(2 * i) % copy.pool.length]!, copy.pool[(2 * i + 1) % copy.pool.length]!];
  const adUpdates: { id: string; adSetId: string; headline: string; body: string; finalUrl: string; urlTags: string }[] = [];
  const rsaOf = new Map<string, { headlines: string[]; descriptions: string[] }>();
  ads.forEach((a) => {
    const c = campaignById.get(a.campaignId)!;
    const wi = winners.findIndex((w) => w.id === a.id);
    const li = losers.findIndex((l) => l.id === a.id);
    let headline = a.headline ?? a.name;
    let body: string;
    if (c.platform === "google") {
      const kws = keywords.filter((k) => k.adSetId === adSetOf(a) && !k.waste).map((k) => k.text);
      const headlines = [...kws.slice(0, 3).map((k) => k[0]!.toUpperCase() + k.slice(1)), ...rng.shuffle(copy.rsaExtra).slice(0, 2)];
      const descriptions = rng.shuffle(copy.rsaDescriptions).slice(0, 2);
      rsaOf.set(a.id, { headlines, descriptions });
      headline = headlines.join(" | ");
      body = descriptions.join(" ");
    } else body = rng.shuffle(copy.pool).slice(0, 2).join(". ");
    if (wi >= 0) {
      headline = copy.winHeadlines[wi % copy.winHeadlines.length]!;
      body = `${copy.winBodies[wi % copy.winBodies.length]} ${poolFor(wi).join(". ")}.`;
      if (c.platform === "google") rsaOf.set(a.id, { headlines: [headline, ...poolFor(wi)], descriptions: [copy.winBodies[wi % copy.winBodies.length]!] });
    } else if (li >= 0) headline = copy.loseHeadlines[li % copy.loseHeadlines.length]!;
    const tags = c.platform === "meta" ? (c.id === missingUtm?.id ? "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}" : ADS_UTM_TEMPLATES.meta) : ADS_UTM_TEMPLATES.google;
    adUpdates.push({ id: a.id, adSetId: adSetOf(a), headline, body, finalUrl: `${copy.domain}/collections/${c.externalId}`, urlTags: tags });
  });
  await chunked(adUpdates, (c) => db.execute(sql`update ad_creatives a set ad_set_id = v.s, headline = v.h, body = v.b, final_url = v.u, url_tags = v.t from (values ${sql.join(c.map((u) => sql`(${u.id}::uuid, ${u.adSetId}::uuid, ${u.headline}::text, ${u.body}::text, ${u.finalUrl}::text, ${u.urlTags}::text)`), sql`, `)}) as v(id, s, h, b, u, t) where a.id = v.id`));
  void loserIds;

  /* ---------- assets: Google RSA headlines/descriptions, Meta dynamic creative ---------- */
  interface Asset { id: string; adId: string; fieldType: string; type: "text" | "image" | "video"; ctr: number; weight: number }
  const assets: Asset[] = [];
  const assetRows: (typeof T.adAssets.$inferInsert)[] = [];
  let assetSeq = 0;
  for (const a of ads) {
    const c = campaignById.get(a.campaignId)!;
    const add = (fieldType: string, type: "text" | "image" | "video", text: string | null, label: string | null, ctr: number) => {
      const id = rng.uuid();
      const ext = `${c.platform === "google" ? "88" : "61"}${String(100000 + assetSeq++)}`;
      assets.push({ id, adId: a.id, fieldType, type, ctr, weight: 0.5 + rng.next() });
      assetRows.push({ id, tenantId, campaignId: c.id, adSetId: adSetOf(a), creativeId: a.id, platform: c.platform, externalId: `${a.externalId}|${fieldType}|${ext}`, assetExternalId: ext, type, fieldType, textContent: text, url: type === "text" ? null : `${copy.domain}/media/${ext}.${type === "video" ? "mp4" : "jpg"}`, performanceLabel: label, syncedAt: now });
    };
    if (c.platform === "google") {
      const rsa = rsaOf.get(a.id)!;
      rsa.headlines.forEach((h, i) => { const label = i === rsa.headlines.length - 1 && rsa.headlines.length > 3 ? "LOW" : rng.weighted([["BEST", 25], ["GOOD", 50], ["LEARNING", 25]] as const); add("headline", "text", h, label, label === "LOW" ? 0.35 : label === "BEST" ? 1.3 : 1); });
      rsa.descriptions.forEach((d) => add("description", "text", d, rng.pick(["GOOD", "BEST", "LEARNING"]), 1));
    } else if (rng.chance(0.3) || winnerIds.has(a.id)) {
      // dynamic creative: three bodies, two titles, two visuals
      for (const b of rng.shuffle(copy.pool).slice(0, 3)) add("body", "text", b, null, 0.6 + rng.next() * 0.8);
      add("title", "text", adUpdates.find((u) => u.id === a.id)!.headline, null, 1);
      add("title", "text", rng.pick(copy.pool), null, 0.6 + rng.next() * 0.6);
      add("image", "image", null, null, 0.8 + rng.next() * 0.4);
      add(a.format === "video" ? "video" : "image", a.format === "video" ? "video" : "image", null, null, 0.7 + rng.next() * 0.6);
    }
  }
  await chunked(assetRows, (c) => db.insert(T.adAssets).values(c));

  /* ---------- keywords and search terms rows ---------- */
  const kwRows = keywords.map((k) => ({ id: k.id, tenantId, campaignId: k.campaignId, adSetId: k.adSetId, platform: "google", externalId: `${adSetExtOf.get(k.adSetId)}~${k.id.slice(0, 8)}`, text: k.text, matchType: k.matchType, qualityScore: k.waste ? 3 : rng.int(3, 10), status: campaignById.get(k.campaignId)!.status === "active" ? "active" : "paused", negative: false, syncedAt: now }));
  await chunked(kwRows, (c) => db.insert(T.adKeywords).values(c));
  const otherIds = new Map<string, string>();
  const termRows: (typeof T.adSearchTerms.$inferInsert)[] = [];
  for (const k of keywords) for (const t of k.terms) termRows.push({ id: t.id, tenantId, campaignId: k.campaignId, adSetId: k.adSetId, keywordId: k.id, platform: "google", externalId: `${adSetExtOf.get(k.adSetId)}|${t.text}`, text: t.text, matchType: t.text === k.text ? "exact" : k.matchType, status: t.text === k.text ? "added" : "none", isOther: false });
  for (const adSetId of new Set(keywords.map((k) => k.adSetId))) {
    const id = rng.uuid();
    otherIds.set(adSetId, id);
    termRows.push({ id, tenantId, campaignId: keywords.find((k) => k.adSetId === adSetId)!.campaignId, adSetId, keywordId: null, platform: "google", externalId: `${adSetExtOf.get(adSetId)}|${OTHER_SEARCH_TERM}`, text: OTHER_SEARCH_TERM, matchType: null, status: "none", isOther: true });
  }
  const seenTerm = new Set<string>();
  const uniqueTerms = termRows.filter((r) => (seenTerm.has(r.externalId) ? false : (seenTerm.add(r.externalId), true)));
  const keptTermIds = new Set(uniqueTerms.map((r) => r.id!));
  await chunked(uniqueTerms, (c) => db.insert(T.adSearchTerms).values(c));

  /* ---------- metrics: ad sets, assets, keywords, search terms (90 days daily, months before) ---------- */
  const cutoff = iso(new Date(now.getTime() - RETENTION_DAYS * DAY));
  const metricRows: MetricRow[] = [];
  const campaignOfEntity = new Map<string, string>();
  const push = (entityType: string, entityId: string, campaignId: string, date: string, m: Partial<MetricRow>) => {
    campaignOfEntity.set(entityId, campaignId);
    metricRows.push({ ...ZERO_METRICS, ...m, entityType, entityId, date, grain: "day" });
  };
  const daysByAd = new Map<string, Day[]>();
  for (const d of days) daysByAd.set(d.creativeId, [...(daysByAd.get(d.creativeId) ?? []), d]);
  const setDay = new Map<string, MetricRow & { campaignId: string; adSetId: string }>();
  for (const a of ads) {
    for (const d of daysByAd.get(a.id) ?? []) {
      const k = `${adSetOf(a)}|${d.date}`;
      const cur = setDay.get(k) ?? { ...ZERO_METRICS, entityType: "ad_set", entityId: adSetOf(a), date: d.date, grain: "day" as const, campaignId: a.campaignId, adSetId: adSetOf(a) };
      setDay.set(k, { ...cur, spendMinor: cur.spendMinor + d.spendMinor, impressions: cur.impressions + d.impressions, clicks: cur.clicks + d.clicks, reach: cur.reach + d.reach, conversions: cur.conversions + d.purchases, conversionValueMinor: cur.conversionValueMinor + d.purchaseValueMinor, videoViews3s: cur.videoViews3s + d.videoViews3s });
      // assets split the ad's day within each field type (Google labels LOW get a low CTR)
      const mine = assets.filter((x) => x.adId === a.id);
      for (const field of new Set(mine.map((x) => x.fieldType))) {
        const group = mine.filter((x) => x.fieldType === field);
        const imp = splitExact(d.impressions, group.map((x) => x.weight));
        const clk = splitExact(d.clicks, group.map((x) => x.weight * x.ctr));
        const sp = splitExact(d.spendMinor, group.map((x) => x.weight * x.ctr));
        const conv = splitExact(d.purchases, group.map((x) => x.weight * x.ctr));
        const val = splitExact(d.purchaseValueMinor, group.map((x) => x.weight * x.ctr));
        group.forEach((x, i) => push("asset", x.id, a.campaignId, d.date, { impressions: imp[i]!, clicks: clk[i]!, spendMinor: sp[i]!, conversions: conv[i]!, conversionValueMinor: val[i]!, videoViews3s: x.type === "video" ? Math.round(imp[i]! * 0.3) : 0 }));
      }
    }
  }
  for (const s of setDay.values()) {
    push("ad_set", s.entityId, s.campaignId, s.date, s);
    const kws = keywords.filter((k) => k.adSetId === s.adSetId);
    if (!kws.length) continue;
    const w = kws.map((k) => k.weight);
    const sp = splitExact(s.spendMinor, w);
    const imp = splitExact(s.impressions, w);
    const clk = splitExact(s.clicks, w);
    const conv = splitExact(s.conversions, kws.map((k) => (k.waste ? 0 : k.weight)));
    const val = splitExact(s.conversionValueMinor, kws.map((k) => (k.waste ? 0 : k.weight)));
    kws.forEach((k, i) => {
      push("keyword", k.id, s.campaignId, s.date, { spendMinor: sp[i]!, impressions: imp[i]!, clicks: clk[i]!, conversions: conv[i]!, conversionValueMinor: val[i]! });
      const terms = k.terms.filter((t) => keptTermIds.has(t.id));
      const tw = terms.map((t) => t.weight);
      const tsp = splitExact(sp[i]!, tw);
      const timp = splitExact(imp[i]!, tw);
      const tclk = splitExact(clk[i]!, tw);
      const tconv = splitExact(conv[i]!, terms.map((t) => (t.noConv ? 0 : t.weight)));
      const tval = splitExact(val[i]!, terms.map((t) => (t.noConv ? 0 : t.weight)));
      terms.forEach((t, j) => push("search_term", t.id, s.campaignId, s.date, { spendMinor: tsp[j]!, impressions: timp[j]!, clicks: tclk[j]!, conversions: tconv[j]!, conversionValueMinor: tval[j]! }));
    });
  }
  // the shape the retention job leaves: months before the cutoff, rare search terms of closed months in "(other)"
  const rolled = rollupMetricRows(metricRows, cutoff);
  const termAdSet = new Map(uniqueTerms.map((t) => [t.id!, t.adSetId!]));
  const closed = `${cutoff.slice(0, 7)}-01`;
  const months = [...rolled.months.filter((m) => m.date >= closed), ...groupRareTerms(rolled.months.filter((m) => m.date < closed), MIN_IMPRESSIONS, (id) => otherIds.get(termAdSet.get(id) ?? "") ?? null)];
  for (const id of otherIds.values()) campaignOfEntity.set(id, uniqueTerms.find((t) => t.id === id)!.campaignId);
  const values = [...rolled.keep, ...months].map((m) => ({ tenantId, entityType: m.entityType, entityId: m.entityId, campaignId: campaignOfEntity.get(m.entityId)!, date: m.date, grain: m.grain, spendMinor: m.spendMinor, impressions: m.impressions, clicks: m.clicks, reach: m.reach, conversions: m.conversions, conversionValueMinor: m.conversionValueMinor, videoViews3s: m.videoViews3s, videoCompletions: m.videoCompletions }));
  await chunked(values, (c) => db.insert(T.adEntityMetricsDaily).values(c), 1000);
  // terms whose every month went to "(other)" no longer carry metrics: the retention job deletes them too
  const withMetrics = new Set(values.filter((v) => v.entityType === "search_term").map((v) => v.entityId));
  const orphanTerms = uniqueTerms.filter((t) => !t.isOther && !withMetrics.has(t.id!)).map((t) => t.id!);
  if (orphanTerms.length) await chunked(orphanTerms, (c) => db.delete(T.adSearchTerms).where(inArray(T.adSearchTerms.id, c)));

  /* ---------- a finished entity sync per platform ---------- */
  for (const provider of [...new Set(campaigns.map((c) => c.platform))]) {
    await db.insert(T.syncRuns).values({ tenantId, provider, objectType: "ads_entities", kind: "delta", status: "success", cursor: { since: iso(new Date(now.getTime() - 30 * DAY)), until: iso(now), phase: "metrics", level: 5, window: 0, counts: {} }, rowsWritten: values.length, startedAt: new Date(now.getTime() - 26 * 36e5), finishedAt: new Date(now.getTime() - 26 * 36e5 + 95_000), durationMs: 95_000 });
    await db.insert(T.integrationHealth).values({ tenantId, source: `${provider}:entities`, status: "ok", lastSuccessAt: new Date(now.getTime() - 26 * 36e5), lastAttemptAt: new Date(now.getTime() - 26 * 36e5), lastMetricDate: iso(now), rowsWrittenLast: values.length, freshnessMinutes: provider === "google" ? 720 : 240 }).onConflictDoNothing();
  }
}
