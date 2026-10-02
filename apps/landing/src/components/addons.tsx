import { BookOpenCheck, Code2, Megaphone, MessageCircle, PhoneCall, Puzzle, Repeat } from "lucide-react";
import { Section } from "@/components/ui";
import { ADDONS, addonOnSale } from "@/config/pricing";
import type { LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";
import { formatPrice } from "@/lib/format";

const ICONS = {
  customer_campaigns: Megaphone,
  subscriptions: Repeat,
  cod: PhoneCall,
  whatsapp_spoki: MessageCircle,
  accounting: BookOpenCheck,
  custom_integration: Puzzle,
  custom_development: Code2,
} as const;
type AddonKey = keyof typeof ICONS;

export function Addons({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  return (
    <Section id="addons" title={t("addons.title")} lead={t("addons.lead")} tone="muted">
      <ul className="grid gap-4 sm:grid-cols-2">
        {ADDONS.map((a) => {
          const key = a.id as AddonKey;
          const Icon = ICONS[key];
          const price = !addonOnSale(a.id)
            ? t("addons.coming_soon")
            : a.kind === "monthly"
              ? t("addons.per_month", { price: formatPrice(locale, a.price) })
              : t("addons.quote");
          return (
            <li
              key={a.id}
              className="flex flex-col rounded-lg border border-border bg-background p-6"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-lg font-semibold">{t(`addons.items.${key}.title`)}</h3>
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
