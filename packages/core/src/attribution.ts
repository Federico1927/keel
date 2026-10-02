import type { AdPlatform } from "@hullwise/config";

/** UTM and click-id extraction from what the commerce platform stores on an order; no vendor-specific params. */
export const CLICK_ID_KEYS = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid", "epik", "li_fat_id"] as const;
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];

export interface AttributionInput {
  landingSite: string | null;
  referringSite: string | null;
  noteAttributes: { name: string; value: string }[];
}
export interface Attribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  utmId: string | null;
  clickIds: Partial<Record<ClickIdKey, string>>;
}

const UTM_KEYS: Record<string, keyof Omit<Attribution, "clickIds">> = { utm_source: "utmSource", utm_medium: "utmMedium", utm_campaign: "utmCampaign", utm_content: "utmContent", utm_term: "utmTerm", utm_id: "utmId" };

function paramsOf(url: string | null): URLSearchParams | null {
  if (!url) return null;
  try {
    return new URL(url, "https://placeholder.invalid").searchParams;
  } catch {
    return null;
  }
}

/** Note attributes win over the landing page, which wins over the referrer (closest to checkout first). */
export function extractAttribution(i: AttributionInput): Attribution {
  const out: Attribution = { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null, utmId: null, clickIds: {} };
  const apply = (get: (k: string) => string | null) => {
    for (const [param, field] of Object.entries(UTM_KEYS)) {
      const v = get(param);
      if (v && out[field] === null) out[field] = v.trim().slice(0, 200);
    }
    for (const k of CLICK_ID_KEYS) {
      const v = get(k);
      if (v && !out.clickIds[k]) out.clickIds[k] = v.trim().slice(0, 200);
    }
  };
  const notes = new Map(i.noteAttributes.map((n) => [n.name.trim().toLowerCase().replace(/[-\s]/g, "_"), n.value]));
  apply((k) => notes.get(k) ?? null);
  const landing = paramsOf(i.landingSite);
  if (landing) apply((k) => landing.get(k));
  const referring = paramsOf(i.referringSite);
  if (referring) apply((k) => referring.get(k));
  return out;
}

export type AttributionChannel = "paid_social" | "paid_search" | "organic_search" | "social" | "email" | "referral" | "direct" | "marketplace" | "unknown";

/** Channel from click ids first, then UTM medium/source, then the referrer host. */
export function deriveChannel(a: Attribution, referringSite: string | null, sourceChannel: string | null = null): AttributionChannel {
  if (a.clickIds.fbclid || a.clickIds.ttclid || a.clickIds.li_fat_id || a.clickIds.epik) return "paid_social";
  if (a.clickIds.gclid || a.clickIds.gbraid || a.clickIds.wbraid || a.clickIds.msclkid) return "paid_search";
  const medium = (a.utmMedium ?? "").toLowerCase();
  const source = (a.utmSource ?? "").toLowerCase();
  const social = /facebook|instagram|meta|tiktok|pinterest|linkedin|snapchat|ig|fb/.test(source);
  const search = /google|bing|yahoo|duckduckgo/.test(source);
  if (/cpc|ppc|paid|paidsocial|paid_social|social_paid/.test(medium)) return social ? "paid_social" : search ? "paid_search" : "paid_social";
  if (/email|newsletter/.test(medium) || /klaviyo|mailchimp|email/.test(source)) return "email";
  if (/social/.test(medium) || social) return "social";
  if (/organic/.test(medium) || search) return "organic_search";
  if (/referral/.test(medium)) return "referral";
  if (sourceChannel && /pos|amazon|ebay|marketplace|zalando/.test(sourceChannel.toLowerCase())) return "marketplace";
  const host = (() => {
    try {
      return referringSite ? new URL(referringSite).hostname.toLowerCase() : "";
    } catch {
      return "";
    }
  })();
  if (/google\.|bing\.|yahoo\.|duckduckgo\./.test(host)) return "organic_search";
  if (/facebook\.|instagram\.|tiktok\.|pinterest\.|l\.facebook|lm\.facebook|t\.co$/.test(host)) return "social";
  if (host) return "referral";
  if (a.utmSource || a.utmCampaign) return "unknown";
  return "direct";
}

/** The ad platform a click id belongs to (only platforms Hullwise imports spend from). */
export const CLICK_ID_PLATFORM: Readonly<Partial<Record<ClickIdKey, AdPlatform>>> = { fbclid: "meta", gclid: "google", gbraid: "google", wbraid: "google", ttclid: "tiktok" };
/** `utm_source` values each ad platform's templates write. */
export const AD_PLATFORM_UTM_SOURCES: Readonly<Record<AdPlatform, readonly string[]>> = { meta: ["facebook", "instagram", "fb", "ig", "meta"], google: ["google"], tiktok: ["tiktok"] };
/** Channel an ad platform's paid traffic belongs to. */
export const AD_PLATFORM_CHANNEL: Readonly<Record<AdPlatform, AttributionChannel>> = { meta: "paid_social", google: "paid_search", tiktok: "paid_social" };

/** The ad platform an order's click ids (first) or UTM source point to, if any. */
export function adPlatformOf(a: Pick<Attribution, "clickIds" | "utmSource">): AdPlatform | null {
  for (const [key, platform] of Object.entries(CLICK_ID_PLATFORM) as [ClickIdKey, AdPlatform][]) if (a.clickIds[key]) return platform;
  const source = (a.utmSource ?? "").trim().toLowerCase();
  if (!source) return null;
  for (const [platform, sources] of Object.entries(AD_PLATFORM_UTM_SOURCES) as [AdPlatform, readonly string[]][]) if (sources.includes(source)) return platform;
  return null;
}

export interface CampaignRef {
  id: string;
  externalId: string;
  name: string;
  platform: string;
}

export function normalizeCampaignName(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Campaign by platform id (utm_id / numeric utm_campaign) first, then by normalized name; platform inferred from the click id (or the UTM source) when present. */
export function matchCampaign(a: Attribution, campaigns: CampaignRef[]): CampaignRef | null {
  if (!campaigns.length) return null;
  const preferred = adPlatformOf(a);
  const ordered = preferred ? [...campaigns.filter((c) => c.platform === preferred), ...campaigns.filter((c) => c.platform !== preferred)] : campaigns;
  for (const candidate of [a.utmId, a.utmCampaign]) {
    if (candidate && /^\d{6,}$/.test(candidate)) {
      const hit = ordered.find((c) => c.externalId === candidate);
      if (hit) return hit;
    }
  }
  if (a.utmCampaign) {
    const wanted = normalizeCampaignName(a.utmCampaign);
    if (wanted) {
      const exact = ordered.find((c) => normalizeCampaignName(c.name) === wanted);
      if (exact) return exact;
      const loose = ordered.find((c) => normalizeCampaignName(c.name).includes(wanted) || wanted.includes(normalizeCampaignName(c.name)));
      if (loose && wanted.length >= 6) return loose;
    }
  }
  return null;
}

/** Splits [since, until] (inclusive ISO dates) into consecutive windows of at most `days` days, oldest first. */
export function splitDateWindows(since: string, until: string, days: number): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end || days < 1) return out;
  for (let d = new Date(start); d <= end; ) {
    const wEnd = new Date(Math.min(d.getTime() + (days - 1) * 864e5, end.getTime()));
    out.push({ since: d.toISOString().slice(0, 10), until: wEnd.toISOString().slice(0, 10) });
    d = new Date(wEnd.getTime() + 864e5);
  }
  return out;
}
