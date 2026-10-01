import { ChevronDown } from "lucide-react";
import { Section } from "@/components/ui";
import { OVERAGE } from "@/config/pricing";
import type { LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";
import { formatNumber, formatPrice } from "@/lib/format";

const ITEMS = ["payments", "contracts", "setup", "security", "overage", "languages"] as const;

export function Faq({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const vars = {
    price: formatPrice(locale, OVERAGE.pricePerBlock),
    n: formatNumber(locale, OVERAGE.blockSize),
  };
  return (
    <Section id="faq" title={t("faq.title")}>
      <div className="mx-auto max-w-3xl divide-y divide-border rounded-2xl border border-border bg-card">
        {ITEMS.map((k) => (
          <details key={k} className="group px-6 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-1 text-left font-medium [&::-webkit-details-marker]:hidden">
              {t(`faq.items.${k}.q`)}
              <ChevronDown
                className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <p className="pb-2 pt-3 leading-relaxed text-muted-foreground">
              {t(`faq.items.${k}.a`, vars)}
            </p>
          </details>
        ))}
      </div>
    </Section>
  );
}
