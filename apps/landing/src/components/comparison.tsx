import { Check, Minus } from "lucide-react";
import { Section } from "@/components/ui";
import { COMPARISON_CLAIMS } from "@/config/claims";
import { PLANS, STACK_COMPARISON } from "@/config/pricing";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";
import { formatNumber, formatPrice } from "@/lib/format";

const STACK_ITEMS = ["analytics", "inventory", "returns", "spreadsheets", "seats"] as const;
const KEEL_ITEMS = Object.keys(COMPARISON_CLAIMS) as (keyof typeof COMPARISON_CLAIMS)[];

export function Comparison({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const growth = PLANS.find((p) => p.recommended) ?? PLANS[0]!;
  const price = formatPrice(locale, growth.monthlyPrice ?? 0);
  return (
    <Section
      id="comparison"
      title={t("comparison.title")}
      lead={t("comparison.lead", {
        min: STACK_COMPARISON.revenueBandMinMillions,
        max: STACK_COMPARISON.revenueBandMaxMillions,
      })}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6 sm:p-8">
          <p className="text-sm font-medium text-muted-foreground">{t("comparison.stack_label")}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight tabular sm:text-4xl">
            {t("comparison.stack_price", {
              min: formatPrice(locale, STACK_COMPARISON.minMonthly),
              max: formatPrice(locale, STACK_COMPARISON.maxMonthly),
            })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{t("comparison.stack_price_note")}</p>
          <ul className="mt-6 space-y-3">
            {STACK_ITEMS.map((k) => (
              <li key={k} className="flex items-start gap-3 text-muted-foreground">
                <Minus className="mt-1 size-4 shrink-0" aria-hidden="true" />
                {t(`comparison.stack_items.${k}`)}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-6 sm:p-8">
          <p className="text-sm font-medium text-primary">
            {t("comparison.keel_label", {
              product: PRODUCT_NAME,
              plan: t(`pricing.plans.${growth.id}.name`),
            })}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight tabular sm:text-4xl">
            {t("comparison.keel_price", { price })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("comparison.keel_price_note", {
              orders: formatNumber(locale, growth.includedOrdersPerMonth ?? 0),
            })}
          </p>
          <ul className="mt-6 space-y-3">
            {KEEL_ITEMS.map((k) => (
              <li key={k} className="flex items-start gap-3">
                <Check className="mt-1 size-4 shrink-0 text-success" aria-hidden="true" />
                {t(`comparison.keel_items.${k}`)}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mt-6 max-w-3xl text-sm text-muted-foreground">{t("comparison.note")}</p>
    </Section>
  );
}
