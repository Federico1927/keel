import { Code2, PhoneCall, Puzzle } from "lucide-react";
import { Section } from "@/components/ui";
import { ADDONS } from "@/config/pricing";
import type { LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";
import { formatPrice } from "@/lib/format";

const ICONS = {
  cod: PhoneCall,
  custom_integration: Puzzle,
  custom_development: Code2,
} as const;
type AddonKey = keyof typeof ICONS;

export function Addons({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  return (
    <Section id="addons" title={t("addons.title")} lead={t("addons.lead")} tone="muted">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ADDONS.map((a) => {
          const key = a.id as AddonKey;
          const Icon = ICONS[key];
          const price =
            a.kind === "monthly"
              ? t(a.from ? "addons.from_per_month" : "addons.per_month", {
                  price: formatPrice(locale, a.price),
                })
              : t("addons.quote");
          return (
            <li key={a.id} className="flex flex-col rounded-xl border border-border bg-card p-6">
              <Icon className="size-6 text-primary" aria-hidden="true" />
              <h3 className="mt-4 font-sans text-lg font-semibold tracking-normal">
                {t(`addons.items.${key}.title`)}
              </h3>
              <p className="mt-2 flex-1 leading-relaxed text-muted-foreground">
                {t(`addons.items.${key}.body`)}
              </p>
              <p className="mt-4 text-sm font-medium tabular">{price}</p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
