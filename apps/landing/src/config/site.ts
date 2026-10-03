import { PRODUCT_NAME } from "@hullwise/config";

export { PRODUCT_NAME };

/** Locales published by the landing: the same three as the product. */
export const LANDING_LOCALES = ["en", "it", "es"] as const;
export type LandingLocale = (typeof LANDING_LOCALES)[number];
export const DEFAULT_LANDING_LOCALE: LandingLocale = "en";

export function isLandingLocale(value: unknown): value is LandingLocale {
  return typeof value === "string" && (LANDING_LOCALES as readonly string[]).includes(value);
}

/** Path prefix of a locale: the default locale lives at the root. */
export function localePath(locale: LandingLocale): string {
  return locale === DEFAULT_LANDING_LOCALE ? "/" : `/${locale}/`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const SITE_URL = trimSlash(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100");
export const APP_URL = trimSlash(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "federico@automationslab.it";
export const DEMO_URL = process.env.NEXT_PUBLIC_DEMO_URL?.trim() || "";
export const CONTACT_WEBHOOK_URL = process.env.NEXT_PUBLIC_CONTACT_WEBHOOK_URL?.trim() || "";

/** Booking link: external scheduler when configured, otherwise a prefilled email. */
export function demoHref(subject: string): string {
  return DEMO_URL || `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/** Integration guide pages inside the product (tenant-scoped; the slug is resolved after login). */
export function guideHref(provider: "shopify" | "meta" | "google" | "anthropic"): string {
  return `${APP_URL}/login?next=${encodeURIComponent(`/integrations/guide/${provider}`)}`;
}

/**
 * Automations Lab, the studio that builds custom systems. The landing sends visitors who need a
 * bespoke build there; automationslab.it links back here for those who want the product.
 * Italian lives at /it/, English at /en/ (the root only redirects by browser language); there is
 * no Spanish site, so Spanish goes to English.
 */
export const STUDIO_NAME = "Automations Lab";
const STUDIO_URL = trimSlash(process.env.NEXT_PUBLIC_STUDIO_URL ?? "https://automationslab.it");
const STUDIO_PATHS: Record<LandingLocale, string> = { en: "/en/", it: "/it/", es: "/en/" };

/** Link to the studio site, tagged so its analytics can attribute the visit to this landing. */
export function studioHref(locale: LandingLocale, placement: "addons" | "footer"): string {
  const params = new URLSearchParams({
    utm_source: "hullwise",
    utm_medium: "referral",
    utm_campaign: "cross_site",
    utm_content: placement,
  });
  return `${STUDIO_URL}${STUDIO_PATHS[locale]}?${params.toString()}`;
}
