import type { MetadataRoute } from "next";
import { LANDING_LOCALES, SITE_URL, localePath } from "@/config/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const languages = Object.fromEntries(
    LANDING_LOCALES.map((l) => [l, `${SITE_URL}${localePath(l)}`]),
  );
  return LANDING_LOCALES.map((locale) => ({
    url: `${SITE_URL}${localePath(locale)}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: locale === "en" ? 1 : 0.9,
    alternates: { languages },
  }));
}
