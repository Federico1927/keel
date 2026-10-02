import {
  Activity,
  Bot,
  Clock,
  LayoutDashboard,
  ListChecks,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Section } from "@/components/ui";
import { ModulesCarousel, type ModuleSlide } from "@/components/modules-carousel";
import { COMING_SOON, EXTRA_FEATURES, MODULE_SLIDES } from "@/config/claims";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

const EXTRA_ICONS = {
  dashboards: LayoutDashboard,
  mcp: Bot,
  money: Wallet,
  lists: ListChecks,
  health: Activity,
  roles: ShieldCheck,
} as const;

/** Carousel of the core modules, the "also included" grid and the labelled "Coming soon" block. Every item is a claim of `config/claims.ts`. */
export function Modules({ locale }: { locale: LandingLocale }) {
  const t = getTranslator(locale);
  const slides: ModuleSlide[] = MODULE_SLIDES.map((m) => ({
    key: m.key,
    shot: m.shot,
    title: t(`modules.items.${m.key}.title`),
    body: t(`modules.items.${m.key}.body`),
    alt: t(`modules.items.${m.key}.alt`, { product: PRODUCT_NAME }),
  }));
  return (
    <Section id="modules" title={t("modules.title")} lead={t("modules.lead")}>
      <ModulesCarousel locale={locale} slides={slides} />
      <h3 className="mt-16 text-xl font-semibold">{t("modules.extra.title")}</h3>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {EXTRA_FEATURES.map((f) => {
          const Icon = EXTRA_ICONS[f.key];
          return (
            <li key={f.key} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                {"fromPlan" in f && (
                  <span className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {t("modules.extra.from_plan", { plan: t(`pricing.plans.${f.fromPlan}.name`) })}
                  </span>
                )}
              </div>
              <p className="mt-4 font-semibold">{t(`modules.extra.items.${f.key}.title`)}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t(`modules.extra.items.${f.key}.body`)}
              </p>
            </li>
          );
        })}
      </ul>
      <section
        className="mt-10 rounded-lg border border-dashed border-input/60 p-5 sm:p-6"
        aria-labelledby="coming-soon-title"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            <Clock className="size-3.5" aria-hidden="true" />
            {t("coming_soon.badge")}
          </span>
          <h3 id="coming-soon-title" className="font-semibold">
            {t("coming_soon.title")}
          </h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{t("coming_soon.lead")}</p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {COMING_SOON.map((c) => (
            <li key={c.key}>
              <p className="font-medium">{t(`coming_soon.items.${c.key}.title`)}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {t(`coming_soon.items.${c.key}.body`)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </Section>
  );
}
