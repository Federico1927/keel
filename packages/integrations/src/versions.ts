import { GOOGLE_ADS_API_VERSION } from "./google";
import { META_API_VERSION } from "./meta";
import { SHOPIFY_API_VERSION } from "./shopify/oauth";

/**
 * The vendor API version each live adapter is pinned to and the last day the vendor supports it. A unit
 * test fails once a date has passed, so a stale pin is caught in CI before calls start failing or falling
 * forward. `verify: true` = the date comes from the vendor's published policy but was not confirmed on its
 * changelog page ("Da verificare").
 */
export const API_VERSION_SUPPORT = {
  // Shopify: each stable version is supported for at least 12 months (2026-10 → until 2027-10-16 per the issue)
  shopify: { version: SHOPIFY_API_VERSION, supportedUntil: "2027-10-16", verify: false },
  // Google Ads: v23 sunsets around February 2027
  google: { version: GOOGLE_ADS_API_VERSION, supportedUntil: "2027-02-01", verify: true },
  // Meta Marketing API: a version stays available about two years; the date is a conservative early check
  meta: { version: META_API_VERSION, supportedUntil: "2027-09-01", verify: true },
} as const satisfies Record<string, { version: string; supportedUntil: string; verify: boolean }>;

/** Platforms whose pinned version is past (or within `marginDays` of) its support end. */
export function staleApiVersions(now = new Date(), marginDays = 0): { platform: string; version: string; supportedUntil: string }[] {
  const limit = now.getTime() + marginDays * 864e5;
  return Object.entries(API_VERSION_SUPPORT).filter(([, v]) => new Date(`${v.supportedUntil}T23:59:59Z`).getTime() < limit).map(([platform, v]) => ({ platform, version: v.version, supportedUntil: v.supportedUntil }));
}
