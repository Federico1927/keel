import { LocaleSwitch } from "@/components/header";
import { Logo } from "@/components/logo";
import {
  APP_URL,
  CONTACT_EMAIL,
  PRODUCT_NAME,
  localePath,
  type LandingLocale,
} from "@/config/site";
import { getTranslator } from "@/i18n/messages";

export function Footer({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const base = localePath(locale);
  return (
    <footer className="border-t border-border bg-background py-12">
      <div className="container-x flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div>
          <a href={base} className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Logo className="size-6 text-primary" />
            {PRODUCT_NAME}
          </a>
          <p className="mt-2 text-sm text-muted-foreground">{t("footer.tagline")}</p>
        </div>
        <nav
          className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm sm:grid-cols-3"
          aria-label="Footer"
        >
          <a href={`${base}#modules`} className="hover:underline">
            {t("footer.product")}
          </a>
          <a href={`${base}#pricing`} className="hover:underline">
            {t("footer.pricing")}
          </a>
          <a href={`${base}#faq`} className="hover:underline">
            {t("footer.faq")}
          </a>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:underline">
            {t("footer.contact")}
          </a>
          <a href={`${APP_URL}/login`} className="hover:underline">
            {t("footer.sign_in", { product: PRODUCT_NAME })}
          </a>
        </nav>
        <LocaleSwitch current={locale} label={t("footer.language")} className="self-start" />
      </div>
      <div className="container-x mt-10 text-xs text-muted-foreground">
        {t("footer.rights", { year: new Date().getFullYear(), product: PRODUCT_NAME })}
      </div>
    </footer>
  );
}
