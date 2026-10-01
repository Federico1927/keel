import { ArrowUpRight } from "lucide-react";
import { Section } from "@/components/ui";
import { guideHref, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

const STEPS = ["connect", "configure", "operate"] as const;
const GUIDES = ["shopify", "meta", "google"] as const;

export function HowItWorks({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  return (
    <Section id="how" title={t("how.title")} lead={t("how.lead")} tone="muted">
      <ol className="grid gap-6 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s} className="relative rounded-xl border border-border bg-card p-6">
            <span
              className="flex size-9 items-center justify-center rounded-full bg-primary font-serif text-lg text-primary-foreground"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <h3 className="mt-4 font-sans text-lg font-semibold tracking-normal">
              {t(`how.steps.${s}.title`)}
            </h3>
            <p className="mt-2 leading-relaxed text-muted-foreground">{t(`how.steps.${s}.body`)}</p>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-sm text-muted-foreground">{t("how.guides_label")}</p>
      <ul className="mt-3 flex flex-wrap gap-3">
        {GUIDES.map((g) => (
          <li key={g}>
            <a
              href={guideHref(g)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(`how.guides.${g}`)}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}
