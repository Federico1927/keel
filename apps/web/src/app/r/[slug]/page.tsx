import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { DEFAULT_LOCALE, PRODUCT_NAME, SUPPORTED_LOCALES, isLocale, type Locale } from "@keel/config";
import { pickLocalized } from "@keel/core";
import { adminDb, eq, schema, withTenant } from "@keel/db";
import { getPortalConfig, listReturnReasons } from "@keel/services";
import { loadMessages } from "@/i18n/messages";
import { PortalApp, type PortalProps } from "./portal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Public return portal of one store: /r/<store slug>. Everything the customer reads comes from
 * the store's portal configuration in the chosen language (?lang=), else the store's language.
 */
export default async function ReturnPortalPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ lang?: string; order?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const [tenant] = await adminDb().select({ id: schema.tenants.id, name: schema.tenants.name, status: schema.tenants.status, defaultLocale: schema.tenants.defaultLocale }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  if (!tenant || tenant.status !== "active") notFound();
  const { config, reasons } = await withTenant(tenant.id, async (tx) => {
    const ctx = { tenantId: tenant.id, tx, actor: { type: "system" as const, userId: null } };
    return { config: await getPortalConfig(ctx), reasons: await listReturnReasons(ctx, true) };
  });
  if (!config.enabled) notFound();
  const fallback: Locale = isLocale(tenant.defaultLocale) ? tenant.defaultLocale : DEFAULT_LOCALE;
  const locale: Locale = isLocale(sp.lang) ? sp.lang : fallback;
  const L = (m: Record<string, string>) => pickLocalized(m, locale, fallback);
  const messages = await loadMessages(locale);
  const props: PortalProps = {
    slug,
    locale,
    storeName: tenant.name,
    logoUrl: config.logoUrl,
    primaryColor: config.primaryColor,
    title: L(config.title),
    intro: L(config.intro),
    successMessage: L(config.successMessage),
    instructions: L(config.instructions),
    confirmText: L(config.confirmText),
    policyUrl: config.policyUrl,
    supportEmail: config.supportEmail,
    resolutions: config.resolutions,
    lookupBy: config.lookupBy,
    askShippedFirst: config.askShippedFirst,
    tracking: config.tracking,
    photos: config.photos,
    exchangeNoteRequired: config.exchangeNoteRequired,
    fields: config.fields.map((f) => ({ key: f.key, type: f.type, required: f.required, label: L(f.label) || f.key, options: f.options.map((o) => ({ value: o, label: L(f.optionLabels[o] ?? {}) || o })) })),
    reasons: reasons.filter((r) => !config.reasonCodes.length || config.reasonCodes.includes(r.code)).map((r) => ({ code: r.code, label: L(r.labels) || r.label })),
    initialOrder: sp.order?.slice(0, 40) ?? "",
  };
  return (
    <main className="min-h-screen bg-muted/30" style={{ ["--portal" as string]: config.primaryColor }} lang={locale}>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {config.logoUrl ? <img src={config.logoUrl} alt={tenant.name} className="h-8 w-auto" /> : <span className="font-serif text-lg">{tenant.name}</span>}
          </div>
          <nav className="flex items-center gap-3 text-xs" aria-label="Language">
            {config.trackingPage && <Link href={`/r/${slug}/track?lang=${locale}`} className="text-muted-foreground hover:underline" data-testid="portal-track-link">{(messages.return_portal as { track: { link: string } }).track.link}</Link>}
            {SUPPORTED_LOCALES.map((l) => (
              <Link key={l} href={`?lang=${l}`} className={l === locale ? "font-semibold" : "text-muted-foreground hover:underline"}>{l.toUpperCase()}</Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-2xl px-4 py-8">
        <NextIntlClientProvider locale={locale} messages={{ return_portal: messages.return_portal as Record<string, unknown> }}>
          <PortalApp {...props} />
        </NextIntlClientProvider>
      </div>
      <footer className="pb-8 text-center text-xs text-muted-foreground">{PRODUCT_NAME}</footer>
    </main>
  );
}
