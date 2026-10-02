import { ContactForm } from "@/components/contact-form";
import { CONTACT_EMAIL, CONTACT_WEBHOOK_URL, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

export function ContactSection({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  return (
    <section id="contact" className="scroll-mt-20 py-16 sm:py-24">
      <div className="container-x grid gap-10 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t("contact.title")}
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">{t("contact.lead")}</p>
          <p className="mt-6 text-sm text-muted-foreground">
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        <ContactForm locale={locale} webhookUrl={CONTACT_WEBHOOK_URL} email={CONTACT_EMAIL} />
      </div>
    </section>
  );
}
