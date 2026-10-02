import { preload } from "react-dom";
import { Check } from "lucide-react";
import { BrowserFrame } from "@/components/browser-frame";
import { ButtonLink } from "@/components/ui";
import { screenshotSrcSet } from "@/config/screenshots";
import { PRODUCT_NAME, demoHref, localePath, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

const HERO_SIZES = "(min-width: 1100px) 1024px, 100vw";

export function Hero({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const points = ["contract", "setup", "users"] as const;
  // The hero screenshot is the LCP element: preload it so the browser fetches it with the HTML.
  const { src, srcSet } = screenshotSrcSet(locale, "dashboard", "hero");
  preload(src, { as: "image", imageSrcSet: srcSet, imageSizes: HERO_SIZES, fetchPriority: "high" });
  return (
    <section className="relative overflow-hidden pb-12 pt-14 sm:pt-20">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[36rem] bg-[radial-gradient(60%_60%_at_50%_0%,var(--color-hero-glow),transparent)]"
        aria-hidden="true"
      />
      <div className="container-x">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-sm font-medium text-muted-foreground shadow-sm">
            {t("hero.eyebrow")}
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl md:text-6xl">
            {t("hero.title")}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            {t("hero.subtitle")}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href={demoHref(`${PRODUCT_NAME} demo`)} size="lg">
              {t("hero.cta")}
            </ButtonLink>
            <ButtonLink href={`${localePath(locale)}#modules`} variant="outline" size="lg">
              {t("hero.secondary")}
            </ButtonLink>
          </div>
          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {points.map((p) => (
              <li key={p} className="flex items-center gap-1.5">
                <Check className="size-4 text-success" aria-hidden="true" />
                {t(`hero.points.${p}`)}
              </li>
            ))}
          </ul>
        </div>
        <div className="mx-auto mt-12 max-w-5xl sm:mt-16">
          <BrowserFrame
            locale={locale}
            name="dashboard"
            role="hero"
            alt={t("hero.screenshot_alt", { product: PRODUCT_NAME })}
            priority
            sizes={HERO_SIZES}
          />
        </div>
      </div>
    </section>
  );
}
