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
          <li key={key} className="rounded-lg border border-border bg-background p-6">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-lg font-semibold">{t(`problem.items.${key}.title`)}</h3>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              {t(`problem.items.${key}.body`)}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
