import { PRICING_CURRENCY } from "@/config/pricing";
import type { LandingLocale } from "@/config/site";

const INTL_LOCALE: Record<LandingLocale, string> = { en: "en-US", it: "it-IT", es: "es-ES" };

/**
 * `useGrouping: "always"` matters: Italian CLDR data groups 4-digit numbers only from some ICU
 * versions on ("1000" in Node 22, "1.000" in Chromium 141). Client components re-render these
 * strings in the browser, so the output must not depend on the ICU version or hydration fails.
 */
const GROUPING = { useGrouping: "always" } as const;

export function formatPrice(locale: LandingLocale, amount: number): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency: PRICING_CURRENCY,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
    ...GROUPING,
  }).format(amount);
}

export function formatNumber(locale: LandingLocale, n: number): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], GROUPING).format(n);
}
