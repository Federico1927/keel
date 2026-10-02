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
