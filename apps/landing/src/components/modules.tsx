import { Section } from "@/components/ui";
import { ModulesCarousel, type ModuleSlide } from "@/components/modules-carousel";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

/** Module key → capture name, in carousel order (the differentiator first). */
const MODULES = [
  { key: "campaigns", shot: "campaigns" },
  { key: "analytics", shot: "analytics-pl" },
  { key: "assistant", shot: "assistant" },
  { key: "orders", shot: "orders" },
  { key: "shipments", shot: "shipments" },
  { key: "inventory", shot: "inventory" },
  { key: "purchasing", shot: "purchasing" },
  { key: "returns", shot: "returns" },
  { key: "discounts", shot: "discounts" },
  { key: "crm", shot: "rfm" },
] as const;

export function Modules({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const slides: ModuleSlide[] = MODULES.map((m) => ({
    key: m.key,
    shot: m.shot,
    title: t(`modules.items.${m.key}.title`),
    body: t(`modules.items.${m.key}.body`),
    alt: t(`modules.items.${m.key}.alt`, { product: PRODUCT_NAME }),
  }));
  return (
    <Section id="modules" title={t("modules.title")} lead={t("modules.lead")}>
      <ModulesCarousel locale={locale} slides={slides} />
    </Section>
  );
}
