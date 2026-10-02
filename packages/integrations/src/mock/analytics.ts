import { GA4_GROUP_OF_CHANNEL, aggregateTrafficRows, normalizeLandingPath, type AttributionChannel } from "@hullwise/core";
import type { AnalyticsPlatform, AnalyticsProperty, ConnectionTest, NormalizedTrafficRow } from "../types";
import { FailureScript } from "./failures";

/** One online order as the GA4 simulator sees it: when, where it landed and how it was attributed. */
export interface MockTrafficOrder {
  placedAt: Date;
  landingSite: string | null;
  channel: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

/** The simulated properties a demo store can pick (the first is the store's, the second a staging copy with little traffic). */
export function mockGa4Properties(storeName: string): AnalyticsProperty[] {
  return [
    { propertyId: "312456789", displayName: `${storeName} – GA4`, accountName: storeName, timeZone: null, currencyCode: null },
    { propertyId: "312456790", displayName: `${storeName} – staging`, accountName: storeName, timeZone: null, currencyCode: null },
  ];
}
export const MOCK_GA4_PROPERTY_ID = "312456789";

/** Stable value in [0, 1) per key (FNV-1a): a day's numbers never depend on the window it is read in. */
function unit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return (h >>> 0) / 4294967296;
}

/** Session conversion rate per channel the simulator assumes (orders ÷ sessions): paid social converts least, email most. */
const CHANNEL_CR: Readonly<Record<AttributionChannel, number>> = { paid_social: 0.02, paid_search: 0.028, organic_search: 0.026, social: 0.009, email: 0.04, referral: 0.02, direct: 0.033, marketplace: 0.03, unknown: 0.015 };
/** What GA4 writes for source / medium / campaign when the visit carried no UTM. */
const DEFAULT_TOUCH: Readonly<Record<AttributionChannel, [string, string, string]>> = {
  paid_social: ["facebook", "paid", "(not set)"],
  paid_search: ["google", "cpc", "(not set)"],
  organic_search: ["google", "organic", "(organic)"],
  social: ["instagram.com", "referral", "(referral)"],
  email: ["newsletter", "email", "(not set)"],
  referral: ["blog.example", "referral", "(referral)"],
  direct: ["(direct)", "(none)", "(direct)"],
  marketplace: ["(not set)", "(not set)", "(not set)"],
  unknown: ["(not set)", "(not set)", "(not set)"],
};
/** Browsing that never converts, as a share of the day's converting sessions. */
const BROWSING: readonly { group: string; source: string; medium: string; campaign: string; path: string; share: number }[] = [
  { group: "Direct", source: "(direct)", medium: "(none)", campaign: "(direct)", path: "/", share: 0.06 },
  { group: "Organic Search", source: "google", medium: "organic", campaign: "(organic)", path: "/", share: 0.05 },
  { group: "Organic Search", source: "google", medium: "organic", campaign: "(organic)", path: "/blogs/journal", share: 0.03 },
  { group: "Organic Social", source: "instagram.com", medium: "referral", campaign: "(referral)", path: "/collections/new", share: 0.025 },
  { group: "Email", source: "newsletter", medium: "email", campaign: "(not set)", path: "/collections/sale", share: 0.02 },
  { group: "Referral", source: "blog.example", medium: "referral", campaign: "(referral)", path: "/pages/size-guide", share: 0.015 },
];

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The calendar day of an instant in a time zone (GA4 reports in the property's zone). */
function localDay(at: Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f.format(at);
}

const isChannel = (c: string | null): c is AttributionChannel => !!c && c in CHANNEL_CR;

/**
 * Daily GA4 traffic consistent with a store's orders: every (day, channel, source / medium / campaign,
 * landing page) with orders gets the sessions that channel's conversion rate implies (±30%, stable per
 * key), plus browsing on pages that never convert. Deterministic: the seed and the simulator call it
 * with the same orders, so a resync of the demo writes the same numbers. The staging property gets 3%.
 */
export function buildMockTraffic(orders: readonly MockTrafficOrder[], opts: { since: string; until: string; timeZone: string; propertyId?: string }): NormalizedTrafficRow[] {
  const property = opts.propertyId ?? MOCK_GA4_PROPERTY_ID;
  const factor = property === MOCK_GA4_PROPERTY_ID ? 1 : 0.03;
  const groups = new Map<string, { date: string; channel: AttributionChannel; group: string; source: string; medium: string; campaign: string; page: string; orders: number }>();
  for (const o of orders) {
    const date = localDay(o.placedAt, opts.timeZone);
    if (date < opts.since || date > opts.until) continue;
    const channel: AttributionChannel = isChannel(o.channel) ? o.channel : "unknown";
    if (channel === "marketplace") continue;
    const [ds, dm, dc] = DEFAULT_TOUCH[channel];
    const source = o.utmSource?.trim().toLowerCase() || ds;
    const medium = o.utmMedium?.trim().toLowerCase() || dm;
    const campaign = o.utmCampaign?.trim() || dc;
    const path = normalizeLandingPath(o.landingSite);
    // GA4 keeps the query string; the simulator writes the UTMs (never the click ids) so the path normalisation has work to do
    const page = o.utmSource ? `${path}?utm_source=${encodeURIComponent(source)}&utm_medium=${encodeURIComponent(medium)}` : path;
    const k = [date, channel, source, medium, campaign, page].join("|");
    const g = groups.get(k) ?? { date, channel, group: GA4_GROUP_OF_CHANNEL[channel], source, medium, campaign, page, orders: 0 };
    g.orders++;
    groups.set(k, g);
  }
  const out: NormalizedTrafficRow[] = [];
  const dayTotals = new Map<string, number>();
  const push = (date: string, group: string, source: string, medium: string, campaign: string, page: string, sessions: number, minOrders: number) => {
    const key = `${property}|${date}|${group}|${source}|${medium}|${campaign}|${page}`;
    const s = Math.max(Math.round(sessions * factor), factor < 1 ? 0 : minOrders);
    if (s <= 0) return;
    const u = unit(`${key}|m`);
    out.push({ date, channelGroup: group, source, medium, campaignName: campaign, landingPage: page, landingPath: normalizeLandingPath(page), sessions: s, totalUsers: Math.max(1, Math.round(s * (0.78 + 0.1 * u))), engagedSessions: Math.round(s * (0.55 + 0.2 * u)), addToCarts: Math.min(s, Math.max(factor < 1 ? 0 : minOrders, Math.round(s * (0.06 + 0.05 * u)))) });
  };
  for (const g of groups.values()) {
    const noise = 0.7 + 0.6 * unit(`${property}|${g.date}|${g.group}|${g.source}|${g.medium}|${g.campaign}|${g.page}`);
    const sessions = Math.max(g.orders, Math.round((g.orders / CHANNEL_CR[g.channel]) * noise));
    dayTotals.set(g.date, (dayTotals.get(g.date) ?? 0) + sessions);
    push(g.date, g.group, g.source, g.medium, g.campaign, g.page, sessions, g.orders);
  }
  for (const [date, total] of dayTotals) {
    for (const b of BROWSING) push(date, b.group, b.source, b.medium, b.campaign, b.path, total * b.share * (0.75 + 0.5 * unit(`${property}|${date}|${b.group}|${b.path}`)), 0);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Simulated GA4 property: traffic from `buildMockTraffic` over the store's orders, the property list,
 * and failure injection (quota, expired token) for the sync's retry and resume paths.
 */
export class MockAnalyticsPlatform implements AnalyticsPlatform {
  readonly provider = "ga4";
  readonly failures = new FailureScript();
  /** Windows requested, in order (tests check resumption). */
  readonly calls: { since: string; until: string }[] = [];
  /** Every day the orders cover, built once: a day never depends on the window it is read in. */
  private all: NormalizedTrafficRow[] | null = null;
  constructor(private readonly opts: { orders: readonly MockTrafficOrder[]; timeZone: string; storeName: string; propertyId?: string }) {}

  async testConnection(): Promise<ConnectionTest> {
    try {
      this.failures.check();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const id = this.opts.propertyId ?? MOCK_GA4_PROPERTY_ID;
    const p = mockGa4Properties(this.opts.storeName).find((x) => x.propertyId === id);
    // like GA4: a property the reader was not added to answers 403
    if (!p) return { ok: false, errorCode: "permission", error: "No access to the GA4 property: User does not have sufficient permissions for this property." };
    return { ok: true, accountId: id, accountName: p.displayName };
  }

  async listProperties(): Promise<AnalyticsProperty[]> {
    return mockGa4Properties(this.opts.storeName);
  }

  async fetchDailyTraffic(window: { since: string; until: string }): Promise<NormalizedTrafficRow[]> {
    this.failures.check();
    this.calls.push(window);
    this.all ??= buildMockTraffic(this.opts.orders, { since: "0000-01-01", until: "9999-12-31", timeZone: this.opts.timeZone, propertyId: this.opts.propertyId });
    return this.all.filter((r) => r.date >= window.since && r.date <= window.until).map((r) => ({ ...r }));
  }
}

/** Seed and simulator share this: vendor rows → the stored rows (paths merged). */
export function mockTrafficForStorage(orders: readonly MockTrafficOrder[], opts: { since: string; until: string; timeZone: string; propertyId?: string }) {
  return aggregateTrafficRows(buildMockTraffic(orders, opts));
}
