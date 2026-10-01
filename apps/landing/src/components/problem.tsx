import { Calculator, FileClock, Layers, PackageX } from "lucide-react";
import { Section } from "@/components/ui";
import type { LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

const ITEMS = [
  { key: "spread", Icon: Layers },
  { key: "placed", Icon: Calculator },
  { key: "stock", Icon: PackageX },
  { key: "stale", Icon: FileClock },
] as const;

export function Problem({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  return (
    <Section id="problem" title={t("problem.title")} lead={t("problem.lead")} tone="muted">
      <ul className="grid gap-4 sm:grid-cols-2">
        {ITEMS.map(({ key, Icon }) => (
          <li key={key} className="rounded-xl border border-border bg-card p-6">
            <Icon className="size-6 text-primary" aria-hidden="true" />
            <h3 className="mt-4 font-sans text-lg font-semibold tracking-normal">
              {t(`problem.items.${key}.title`)}
            </h3>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              {t(`problem.items.${key}.body`)}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
