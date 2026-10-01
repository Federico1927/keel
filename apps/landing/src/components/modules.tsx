import { BrowserFrame } from "@/components/browser-frame";
import { Section } from "@/components/ui";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

/** Module key → capture name. The first entry is featured full-width. */
const MODULES = [
  { key: "campaigns", shot: "campaigns" },
  { key: "analytics", shot: "analytics-pl" },
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
  const [featured, ...rest] = MODULES;
  return (
    <Section id="modules" title={t("modules.title")} lead={t("modules.lead")}>
      <article className="grid items-center gap-8 rounded-2xl border border-border bg-card p-6 sm:p-8 lg:grid-cols-[2fr_3fr]">
        <div>
          <h3 className="text-2xl sm:text-3xl">{t(`modules.items.${featured.key}.title`)}</h3>
          <p className="mt-3 leading-relaxed text-muted-foreground">
            {t(`modules.items.${featured.key}.body`)}
          </p>
        </div>
        <BrowserFrame
          locale={locale}
          name={featured.shot}
          role="card"
          alt={t(`modules.items.${featured.key}.alt`, { product: PRODUCT_NAME })}
          sizes="(min-width: 1024px) 640px, 100vw"
        />
      </article>
      <ul className="mt-6 grid gap-6 md:grid-cols-2">
        {rest.map((m) => (
          <li
            key={m.key}
            className="flex flex-col rounded-2xl border border-border bg-card p-5 sm:p-6"
          >
            <BrowserFrame
              locale={locale}
              name={m.shot}
              role="card"
              alt={t(`modules.items.${m.key}.alt`, { product: PRODUCT_NAME })}
              sizes="(min-width: 1100px) 520px, (min-width: 768px) 50vw, 100vw"
            />
            <h3 className="mt-5 font-sans text-xl font-semibold tracking-normal">
              {t(`modules.items.${m.key}.title`)}
            </h3>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              {t(`modules.items.${m.key}.body`)}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
