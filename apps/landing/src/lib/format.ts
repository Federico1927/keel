import { PRICING_CURRENCY } from "@/config/pricing";
import type { LandingLocale } from "@/config/site";

const INTL_LOCALE: Record<LandingLocale, string> = { en: "en-US", it: "it-IT" };

export function formatPrice(locale: LandingLocale, amount: number): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency: PRICING_CURRENCY,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatNumber(locale: LandingLocale, n: number): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale]).format(n);
}
