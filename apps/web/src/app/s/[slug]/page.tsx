import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, PRODUCT_NAME, isLocale, type Locale } from "@hullwise/config";
import { withTenant } from "@hullwise/db";
import { publicSurveyView, SurveyError, surveyTenantForSlug } from "@hullwise/services";
import { loadMessages } from "@/i18n/messages";
import { SurveyForm } from "./survey-form";
import { brandStyle, loadBrand, publicBrand } from "@/server/branding";

import { withIntl } from "@/i18n/intl-scope";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Public post-purchase survey: /s/<store>?o=<order id>&t=<signature>&lang=<it|en|es>. The link
 * comes from the store's order confirmation email, signed with the store's survey secret.
 */
async function SurveyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ o?: string; t?: string; lang?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const tenant = await surveyTenantForSlug(slug);
  if (!tenant) notFound();
  const fallback: Locale = isLocale(tenant.defaultLocale) ? tenant.defaultLocale : DEFAULT_LOCALE;
  const locale: Locale = isLocale(sp.lang) ? sp.lang : fallback;
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages, namespace: "survey_public" }) as unknown as (k: string) => string;
  let view: Awaited<ReturnType<typeof publicSurveyView>> | null = null;
  let error: string | null = null;
  try {
    view = await withTenant(tenant.id, (tx) => publicSurveyView({ tenantId: tenant.id, tx, actor: { type: "system", userId: null } }, sp.o ?? "", sp.t ?? "", locale));
  } catch (e) {
    if (!(e instanceof SurveyError)) throw e;
    if (e.code === "disabled") notFound();
    error = e.code;
  }
  const brand = publicBrand(await loadBrand(tenant.id, slug));
  return (
    <div className="light min-h-screen bg-background text-foreground" style={brandStyle(brand)}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
      <header className="border-b bg-card"><div className="mx-auto max-w-xl px-4 py-4 text-lg font-semibold">{brand.logoUrl ? <img src={brand.logoUrl} alt={tenant.name} className="h-8 w-auto" /> : tenant.name}</div></header>
      <main className="mx-auto max-w-xl px-4 py-8">
        {view ? (
          <NextIntlClientProvider locale={locale} messages={{ survey_public: (messages as Record<string, unknown>).survey_public } as never}>
            <SurveyForm slug={slug} order={sp.o!} signature={sp.t!} locale={locale} question={view.question} thanks={view.thanks} options={view.options} allowOther={view.allowOther} answered={view.answered} />
          </NextIntlClientProvider>
        ) : (
          <p className="text-center text-muted-foreground" data-testid="survey-error">{t(`errors.${error}`)}</p>
        )}
        <p className="mt-8 text-center text-xs text-muted-foreground">{PRODUCT_NAME}</p>
      </main>
    </div>
  );
}

export default withIntl(SurveyPage, "app/s/[slug]/page.tsx");
