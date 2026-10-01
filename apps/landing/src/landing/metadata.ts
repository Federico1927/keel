import type { Metadata } from "next";
import {
  LANDING_LOCALES,
  PRODUCT_NAME,
  SITE_URL,
  localePath,
  type LandingLocale,
} from "@/config/site";
import { getTranslator } from "@/i18n/messages";

const OG_LOCALE: Record<LandingLocale, string> = { en: "en_US", it: "it_IT" };

export function landingMetadata(locale: LandingLocale): Metadata {
  const t = getTranslator(locale);
  const title = t("meta.title", { product: PRODUCT_NAME });
  const description = t("meta.description");
  const url = `${SITE_URL}${localePath(locale)}`;
  const languages: Record<string, string> = Object.fromEntries(
    LANDING_LOCALES.map((l) => [l, `${SITE_URL}${localePath(l)}`]),
  );
  languages["x-default"] = `${SITE_URL}${localePath("en")}`;
  return {
    metadataBase: new URL(SITE_URL),
    title,
    description,
    alternates: { canonical: url, languages },
    openGraph: {
      type: "website",
      url,
      title,
      description,
      siteName: PRODUCT_NAME,
      locale: OG_LOCALE[locale],
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
    icons: { icon: "/favicon.svg" },
  };
}
