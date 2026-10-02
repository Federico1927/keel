"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { ButtonLink } from "@/components/ui";
import {
  FOUNDING_OFFER,
  OVERAGE,
  PLANS,
  annualMonthlyEquivalent,
  foundingPrice,
  type Plan,
} from "@/config/pricing";
import { PRODUCT_NAME, demoHref, type LandingLocale } from "@/config/site";
import { cx } from "@/lib/cx";
import { formatNumber, formatPrice } from "@/lib/format";

export function Pricing({ locale }: { locale: LandingLocale }) {
  const t = useTranslations("pricing");
  const [annual, setAnnual] = useState(false);
  const toggleId = useId();
  const founding = FOUNDING_OFFER.enabled && !annual;
  return (
    <section id="pricing" className="scroll-mt-20 py-16 sm:py-24">
      <div className="container-x">
        <div className="max-w-3xl">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            {t("title")}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{t("lead")}</p>
        </div>

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="inline-flex items-center gap-1 self-start rounded-md border border-border bg-card p-1 text-sm"
            role="group"
            aria-labelledby={toggleId}
          >
            <span id={toggleId} className="sr-only">
              {t("billing_label")}
            </span>
            <BillingButton active={!annual} onClick={() => setAnnual(false)}>
              {t("monthly")}
            </BillingButton>
            <BillingButton active={annual} onClick={() => setAnnual(true)}>
              {t("annual")}
              <span className="ml-1.5 whitespace-nowrap rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success">
                {t("annual_note")}
              </span>
            </BillingButton>
          </div>
          {FOUNDING_OFFER.enabled && (
            <div
              className={cx(
                "rounded-md border px-4 py-2 text-sm transition-opacity",
                founding
                  ? "border-primary/30 bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground opacity-70",
              )}
            >
              <span className="mr-2 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary-foreground">
                {t("founding.badge")}
              </span>
              <strong>
                {t("founding.title", {
                  percent: FOUNDING_OFFER.discountPercent,
                  months: FOUNDING_OFFER.months,
                })}
              </strong>
              <span className="ml-1">{t("founding.body", { seats: FOUNDING_OFFER.seats })}</span>
            </div>
          )}
        </div>

        <ul className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              locale={locale}
              annual={annual}
              founding={founding}
            />
          ))}
        </ul>
        <p className="mt-6 text-sm text-muted-foreground">
          {t("overage", {
            price: formatPrice(locale, OVERAGE.pricePerBlock),
            n: formatNumber(locale, OVERAGE.blockSize),
          })}
        </p>
      </div>
    </section>
  );
}

function BillingButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex items-center rounded px-3 py-1.5 transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PlanCard({
  plan,
  locale,
  annual,
  founding,
}: {
  plan: Plan;
  locale: LandingLocale;
  annual: boolean;
  founding: boolean;
}) {
  const t = useTranslations("pricing");
  const base =
    plan.monthlyPrice === null
      ? null
      : annual
        ? annualMonthlyEquivalent(plan.monthlyPrice)
        : plan.monthlyPrice;
  const shown = base === null ? null : founding ? foundingPrice(base) : base;
  const demo = demoHref(`${PRODUCT_NAME} ${t(`plans.${plan.id}.name`)}`);
  return (
    <li
      className={cx(
        "relative flex flex-col rounded-lg border bg-card p-6 shadow-sm",
        plan.recommended ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      {plan.recommended && (
        <span className="absolute -top-3 left-6 rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
          {t("recommended")}
        </span>
      )}
      <h3 className="text-xl font-semibold">{t(`plans.${plan.id}.name`)}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t(`plans.${plan.id}.tagline`)}</p>
      <div className="mt-5 min-h-20">
        {shown === null ? (
          <p className="text-3xl font-semibold tracking-tight">{t("on_quote")}</p>
        ) : (
          <>
            <p className="flex items-baseline gap-1">
              <span className="text-4xl font-semibold tracking-tight tabular">
                {formatPrice(locale, shown)}
              </span>
              <span className="text-sm text-muted-foreground">{t("per_month")}</span>
            </p>
            {founding && base !== null && (
              <p className="mt-1 text-xs text-muted-foreground line-through">
                {t("list_price", { price: formatPrice(locale, base) })}
              </p>
            )}
            {annual && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("billed_annually", { total: formatPrice(locale, shown * 12) })}
              </p>
            )}
          </>
        )}
      </div>
      <p className="mt-2 text-sm font-medium">
        {plan.includedOrdersPerMonth === null
          ? t("enterprise_orders", {
              n: formatNumber(
                locale,
                PLANS.filter((p) => p.includedOrdersPerMonth !== null).at(-1)
                  ?.includedOrdersPerMonth ?? 0,
              ),
            })
          : t("included_orders", { n: formatNumber(locale, plan.includedOrdersPerMonth) })}
      </p>
      <p className="text-sm text-muted-foreground">
        {plan.setupFee === null
          ? t("on_quote")
          : t(plan.setupFeeFrom ? "setup_from" : "setup", {
              price: formatPrice(locale, plan.setupFee),
            })}
      </p>
      <ul className="mt-5 flex-1 space-y-2 text-sm">
        {plan.inheritsFrom && (
          <li className="font-medium">
            {t("everything_in", { plan: t(`plans.${plan.inheritsFrom}.name`) })}
          </li>
        )}
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            {t(`features.${f}` as Parameters<typeof t>[0])}
          </li>
        ))}
        {plan.auditRetentionDays !== null && (
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            {t("features.audit_retention", { days: formatNumber(locale, plan.auditRetentionDays) })}
          </li>
        )}
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          {t("features.unlimited_users")}
        </li>
      </ul>
      <div className="mt-6">
        <ButtonLink
          href={demo}
          variant={plan.recommended ? "primary" : "outline"}
          className="w-full"
        >
          {plan.monthlyPrice === null ? t("contact") : t("cta")}
        </ButtonLink>
      </div>
    </li>
  );
}
