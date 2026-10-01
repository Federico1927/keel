import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { DEFAULT_LOCALE, PRODUCT_NAME, SUPPORTED_LOCALES, isLocale, type Locale } from "@keel/config";
import { adminDb, eq, schema, withTenant } from "@keel/db";
import { getPortalConfig } from "@keel/services";
import { loadMessages } from "@/i18n/messages";
import { TrackApp } from "./track";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Public order tracking of one store, branded like its return portal. */
export default async function TrackPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const [tenant] = await adminDb().select({ id: schema.tenants.id, name: schema.tenants.name, status: schema.tenants.status, defaultLocale: schema.tenants.defaultLocale, timezone: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  if (!tenant || tenant.status !== "active") notFound();
  const config = await withTenant(tenant.id, (tx) => getPortalConfig({ tenantId: tenant.id, tx, actor: { type: "system", userId: null } }));
  if (!config.enabled || !config.trackingPage) notFound();
  const locale: Locale = isLocale(sp.lang) ? sp.lang : isLocale(tenant.defaultLocale) ? tenant.defaultLocale : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  return (
    <main className="min-h-screen bg-muted/30" lang={locale}>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {config.logoUrl ? <img src={config.logoUrl} alt={tenant.name} className="h-8 w-auto" /> : <span className="font-serif text-lg">{tenant.name}</span>}
          <nav className="flex gap-2 text-xs" aria-label="Language">
            {SUPPORTED_LOCALES.map((l) => <Link key={l} href={`?lang=${l}`} className={l === locale ? "font-semibold" : "text-muted-foreground hover:underline"}>{l.toUpperCase()}</Link>)}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-2xl px-4 py-8">
        <NextIntlClientProvider locale={locale} messages={{ return_portal: messages.return_portal as Record<string, unknown>, order_status: messages.order_status as Record<string, unknown>, shipment_status: messages.shipment_status as Record<string, unknown> }}>
          <TrackApp slug={slug} locale={locale} timezone={tenant.timezone} primaryColor={config.primaryColor} returnsHref={`/r/${slug}?lang=${locale}`} lookupBy={config.lookupBy} />
        </NextIntlClientProvider>
      </div>
      <footer className="pb-8 text-center text-xs text-muted-foreground">{PRODUCT_NAME}</footer>
    </main>
  );
}
