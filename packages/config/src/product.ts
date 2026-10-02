/** The product name lives here and nowhere else (CLAUDE.md §0). */
export const PRODUCT_NAME = "Hullwise";
export const PRODUCT_TAGLINE_KEY = "product.tagline";
export const DEFAULT_LOCALE = "en" as const;
export const SUPPORTED_LOCALES = ["en", "it", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
