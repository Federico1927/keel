import { matchCampaign, type AttributionChannel, type CampaignRef } from "./attribution";

/**
 * Web analytics traffic (GA4, #86): sessions by channel, source / medium / campaign and landing page,
 * and the conversion rate Hullwise derives from them (orders ÷ sessions). Pure: the adapters map the
 * vendor's rows, the services read them.
 */

/** Order source channels that come from a storefront session, so they belong in a conversion rate (POS, draft and API orders do not). */
export const ONLINE_SOURCE_CHANNELS = ["web"] as const;

/** GA4's default channel groups (`sessionDefaultChannelGroup`) → Hullwise's attribution channels. Unknown groups map to `unknown`. */
export const GA4_CHANNEL_GROUP_MAP: Readonly<Record<string, AttributionChannel>> = {
  "paid social": "paid_social",
  "paid search": "paid_search",
  "paid shopping": "paid_search",
  "cross-network": "paid_search",
  display: "paid_search",
  "paid video": "paid_search",
  "organic search": "organic_search",
  "organic shopping": "organic_search",
  "organic social": "social",
  "organic video": "social",
  email: "email",
  referral: "referral",
  affiliates: "referral",
  direct: "direct",
};

/** The Hullwise channel of a GA4 default channel group (case-insensitive). */
export function channelOfGa4Group(group: string | null | undefined): AttributionChannel {
  return GA4_CHANNEL_GROUP_MAP[(group ?? "").trim().toLowerCase()] ?? "unknown";
}

/** The GA4 group a Hullwise channel shows as (the simulator writes these). */
export const GA4_GROUP_OF_CHANNEL: Readonly<Record<AttributionChannel, string>> = {
  paid_social: "Paid Social",
  paid_search: "Paid Search",
  organic_search: "Organic Search",
  social: "Organic Social",
  email: "Email",
  referral: "Referral",
  direct: "Direct",
  marketplace: "Unassigned",
  unknown: "Unassigned",
};

/** GA4's placeholders for "no campaign": never matched to a campaign. */
export const GA4_NO_CAMPAIGN = ["(not set)", "(direct)", "(organic)", "(referral)", "(none)", "(other)", "(data deleted)", "(cross-network)"] as const;

/** Value stored for a missing dimension (GA4 writes `(not set)`). */
export const TRAFFIC_NOT_SET = "(not set)";

/**
 * The path of a landing page, the key both GA4 rows and orders are grouped by: scheme and host
 * dropped, query string and fragment dropped, repeated and trailing slashes removed, lower-cased.
 * `/Products/Linen-Shirt/?utm_source=x` and `https://shop.example/products/linen-shirt#reviews`
 * are the same page. Empty or missing → `(not set)`; GA4's own placeholders are kept as they are.
 * The SQL twin is `landingPathSql` (packages/services); a test keeps them equal.
 */
export function normalizeLandingPath(url: string | null | undefined): string {
  const raw = (url ?? "").trim();
  if (!raw) return TRAFFIC_NOT_SET;
  if (raw.startsWith("(") && raw.endsWith(")")) return raw.toLowerCase();
  let path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  path = path.split("?")[0]!.split("#")[0]!.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!path) return "/";
  return (path.startsWith("/") ? path : `/${path}`).slice(0, 500);
}

/** GA4 report dates (`20260115`) as ISO dates; ISO input is returned unchanged. */
export function ga4DateToIso(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

/** Orders ÷ sessions; null without sessions. Can exceed 1 when another tool counts the sessions (we never clamp). */
export function conversionRate(orders: number, sessions: number): number | null {
  return sessions > 0 ? orders / sessions : null;
}

export interface ConversionRateRow {
  key: string;
  orders: number;
  /** GA4 sessions. */
  sessions: number;
  rate: number | null;
  /** First-party pixel sessions of the same key, when the caller passes them. */
  pixelSessions: number | null;
  pixelRate: number | null;
  engagedSessions: number;
  addToCarts: number;
}

/**
 * One row per key seen in any input (orders, GA4 sessions, pixel sessions), with the conversion
 * rate against each traffic source; sorted by GA4 sessions, then orders, then key. Totals add up the rows.
 */
export function conversionRateRows(input: {
  orders: readonly { key: string; orders: number }[];
  sessions: readonly { key: string; sessions: number; engagedSessions?: number; addToCarts?: number }[];
  pixel?: readonly { key: string; sessions: number }[];
  /** Orders over the pixel's own coverage (it may have started after the period did); default `orders`. */
  pixelOrders?: readonly { key: string; orders: number }[];
}): { rows: ConversionRateRow[]; totals: Omit<ConversionRateRow, "key"> } {
  const map = new Map<string, ConversionRateRow>();
  const at = (key: string) => {
    let r = map.get(key);
    if (!r) {
      r = { key, orders: 0, sessions: 0, rate: null, pixelSessions: input.pixel ? 0 : null, pixelRate: null, engagedSessions: 0, addToCarts: 0 };
      map.set(key, r);
    }
    return r;
  };
  for (const o of input.orders) at(o.key).orders += o.orders;
  for (const s of input.sessions) {
    const r = at(s.key);
    r.sessions += s.sessions;
    r.engagedSessions += s.engagedSessions ?? 0;
    r.addToCarts += s.addToCarts ?? 0;
  }
  for (const p of input.pixel ?? []) {
    const r = at(p.key);
    r.pixelSessions = (r.pixelSessions ?? 0) + p.sessions;
  }
  const pixelOrders = new Map<string, number>();
  for (const o of input.pixelOrders ?? input.orders) {
    at(o.key);
    pixelOrders.set(o.key, (pixelOrders.get(o.key) ?? 0) + o.orders);
  }
  const rows = [...map.values()].map((r) => ({ ...r, rate: conversionRate(r.orders, r.sessions), pixelRate: r.pixelSessions === null ? null : conversionRate(pixelOrders.get(r.key) ?? 0, r.pixelSessions) }));
  rows.sort((a, b) => b.sessions - a.sessions || b.orders - a.orders || a.key.localeCompare(b.key));
  const sum = (f: (r: ConversionRateRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const orders = sum((r) => r.orders);
  const sessions = sum((r) => r.sessions);
  const pixelSessions = input.pixel ? sum((r) => r.pixelSessions ?? 0) : null;
  const pixelOrderTotal = [...pixelOrders.values()].reduce((a, b) => a + b, 0);
  return { rows, totals: { orders, sessions, rate: conversionRate(orders, sessions), pixelSessions, pixelRate: pixelSessions === null ? null : conversionRate(pixelOrderTotal, pixelSessions), engagedSessions: sum((r) => r.engagedSessions), addToCarts: sum((r) => r.addToCarts) } };
}

/**
 * The campaign a GA4 traffic row belongs to, by the same rule orders use (`matchCampaign`): the
 * session's UTM campaign is the platform's campaign id (the tracking templates write `utm_campaign`
 * as the id) or its name, normalised; the session source picks the platform when ambiguous. GA4's
 * placeholders (`(not set)`, `(organic)`, …) never match. Recorded in DECISIONS (2026-10-02, GA4).
 */
export function matchTrafficCampaign(row: { source: string; medium: string; campaignName: string }, campaigns: CampaignRef[]): CampaignRef | null {
  const name = row.campaignName.trim();
  if (!name || (GA4_NO_CAMPAIGN as readonly string[]).includes(name.toLowerCase())) return null;
  const blank = (v: string) => (!v || v.startsWith("(") ? null : v);
  return matchCampaign({ utmSource: blank(row.source), utmMedium: blank(row.medium), utmCampaign: name, utmContent: null, utmTerm: null, utmId: null, clickIds: {} }, campaigns);
}

/** The dimensions a stored traffic row is unique on (after the landing page is reduced to its path). */
export interface TrafficKey {
  date: string;
  channelGroup: string;
  source: string;
  medium: string;
  campaignName: string;
  landingPath: string;
}
export interface TrafficMetrics {
  sessions: number;
  totalUsers: number;
  engagedSessions: number;
  addToCarts: number;
}

const cap = (v: string, n: number) => (v.trim() || TRAFFIC_NOT_SET).slice(0, n);

/**
 * Sums vendor rows that share a stored key: two landing pages that differ only by their query string
 * (click ids) are one path. Metrics add up, including `totalUsers` (an upper bound once summed: GA4
 * users are not additive). Strings are capped so the unique index stays small. Order: date, then key.
 */
export function aggregateTrafficRows<R extends TrafficKey & TrafficMetrics>(rows: readonly R[]): (TrafficKey & TrafficMetrics)[] {
  const map = new Map<string, TrafficKey & TrafficMetrics>();
  for (const r of rows) {
    const k: TrafficKey = { date: r.date, channelGroup: cap(r.channelGroup, 100), source: cap(r.source, 200), medium: cap(r.medium, 200), campaignName: cap(r.campaignName, 200), landingPath: cap(r.landingPath, 500) };
    const id = [k.date, k.channelGroup, k.source, k.medium, k.campaignName, k.landingPath].join("\u001f");
    const cur = map.get(id);
    if (cur) {
      cur.sessions += r.sessions;
      cur.totalUsers += r.totalUsers;
      cur.engagedSessions += r.engagedSessions;
      cur.addToCarts += r.addToCarts;
    } else map.set(id, { ...k, sessions: r.sessions, totalUsers: r.totalUsers, engagedSessions: r.engagedSessions, addToCarts: r.addToCarts });
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
}
