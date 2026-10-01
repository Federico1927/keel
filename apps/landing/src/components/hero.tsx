import { Check } from "lucide-react";
import { BrowserFrame } from "@/components/browser-frame";
import { ButtonLink } from "@/components/ui";
import { PRODUCT_NAME, demoHref, localePath, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

export function Hero({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const points = ["contract", "setup", "users"] as const;
  return (
    <section className="relative overflow-hidden pb-10 pt-14 sm:pt-20">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-[radial-gradient(60%_60%_at_50%_0%,hsl(205_55%_30%/0.10),transparent)]"
        aria-hidden="true"
      />
      <div className="container-x">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {t("hero.eyebrow")}
          </p>
          <h1 className="mt-4 text-4xl leading-[1.08] sm:text-5xl md:text-6xl">
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
            sizes="(min-width: 1100px) 1024px, 100vw"
          />
        </div>
      </div>
    </section>
  );
}
