import { IntlProvider } from "@/components/intl-provider";
import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { Problem } from "@/components/problem";
import { Modules } from "@/components/modules";
import { HowItWorks } from "@/components/how-it-works";
import { Comparison } from "@/components/comparison";
import { Pricing } from "@/components/pricing";
import { Addons } from "@/components/addons";
import { Faq } from "@/components/faq";
import { FinalCta } from "@/components/final-cta";
import { ContactSection } from "@/components/contact-section";
import { Footer } from "@/components/footer";
import type { LandingLocale } from "@/config/site";
import { getMessages } from "@/i18n/messages";

/**
 * The whole landing for one locale. Route groups `(en)` and `(it)/it` render it; adding a locale is
 * a message file plus a route group with three one-line files (layout, page, opengraph-image).
 */
export function LandingPage({ locale }: { locale: LandingLocale }) {
  return (
    <IntlProvider locale={locale} messages={getMessages(locale)}>
      <Header locale={locale} />
      <main id="main">
        <Hero locale={locale} />
        <Problem locale={locale} />
        <Modules locale={locale} />
        <HowItWorks locale={locale} />
        <Comparison locale={locale} />
        <Pricing locale={locale} />
        <Addons locale={locale} />
        <Faq locale={locale} />
        <FinalCta locale={locale} />
        <ContactSection locale={locale} />
      </main>
      <Footer locale={locale} />
    </IntlProvider>
  );
}
