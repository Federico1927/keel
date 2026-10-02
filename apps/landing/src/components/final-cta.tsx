import { ButtonLink } from "@/components/ui";
import { PRODUCT_NAME, demoHref, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

export function FinalCta({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  return (
    <section className="bg-primary py-16 text-primary-foreground sm:py-24">
      <div className="container-x text-center">
        <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          {t("cta.title", { product: PRODUCT_NAME })}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg">{t("cta.body")}</p>
        <div className="mt-8">
          <ButtonLink href={demoHref(`${PRODUCT_NAME} demo`)} variant="inverted" size="lg">
            {t("cta.button")}
          </ButtonLink>
        </div>
        {/*
          TESTIMONIALS_PLACEHOLDER: customer quotes, logos and result metrics go here once they are
          real and approved. Nothing invented is rendered until then.
        */}
      </div>
    </section>
  );
}
