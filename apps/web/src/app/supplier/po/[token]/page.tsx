import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { DEFAULT_LOCALE, PRODUCT_NAME, SUPPORTED_LOCALES, isLocale, type Locale } from "@keel/config";
import { formatDate, formatMoney } from "@keel/core";
import { adminDb, eq, schema, withTenant } from "@keel/db";
import { supplierPoView, tenantForSupplierToken } from "@keel/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { loadMessages } from "@/i18n/messages";
import { SupplierAckForm } from "./form";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Public page the supplier opens from the purchase order email: the order (agreed prices only),
 * a confirm button with an optional new delivery date, or a problem report. No account needed.
 */
export default async function SupplierPoPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang } = await searchParams;
  const found = await tenantForSupplierToken(token);
  if (!found) notFound();
  const [tenant] = await adminDb().select({ defaultLocale: schema.tenants.defaultLocale, timezone: schema.tenants.timezone }).from(schema.tenants).where(eq(schema.tenants.id, found.tenantId)).limit(1);
  const locale: Locale = isLocale(lang) ? lang : isLocale(tenant?.defaultLocale) ? (tenant!.defaultLocale as Locale) : DEFAULT_LOCALE;
  const view = await withTenant(found.tenantId, (tx) => supplierPoView({ tenantId: found.tenantId, tx, actor: { type: "system", userId: null } }, found.poId));
  if (!view) notFound();
  const messages = await loadMessages(locale);
  // messages are loaded at runtime for the chosen language, so keys are not statically typed here
  const t = createTranslator({ locale, messages, namespace: "supplier_portal" as never }) as unknown as (key: string, values?: Record<string, string | number>) => string;
  const money = (m: number) => formatMoney(m, view.currency, locale);
  const tz = tenant?.timezone ?? "UTC";
  const open = ["sent", "confirmed"].includes(view.status);
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8" lang={locale}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{view.companyName}</p>
          <h1 className="text-2xl font-semibold">{t("title", { number: view.number })}</h1>
          <p className="text-sm text-muted-foreground">{t("for_supplier", { supplier: view.supplierName })}</p>
        </div>
        <nav className="flex gap-2 text-sm" aria-label={t("language")}>
          {SUPPORTED_LOCALES.map((l) => (
            <Link key={l} href={`?lang=${l}`} className={l === locale ? "font-semibold" : "text-muted-foreground hover:underline"}>{l.toUpperCase()}</Link>
          ))}
        </nav>
      </header>
      <div className="flex flex-wrap gap-2">
        <Badge variant={view.status === "confirmed" ? "success" : "outline"} data-testid="supplier-po-status">{t(`status.${view.status}`)}</Badge>
        {view.expectedAt && <Badge variant="outline">{t("expected", { date: formatDate(view.expectedAt, locale, tz) })}</Badge>}
        {view.ackAt && <Badge variant="info">{t("answered", { date: formatDate(view.ackAt, locale, tz) })}</Badge>}
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.sku")}</TableHead>
                <TableHead>{t("columns.item")}</TableHead>
                <TableHead className="text-right">{t("columns.quantity")}</TableHead>
                <TableHead className="text-right">{t("columns.unit_price")}</TableHead>
                <TableHead className="text-right">{t("columns.total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{l.supplierSku ?? l.sku ?? "—"}</TableCell>
                  <TableCell>{l.label}</TableCell>
                  <TableCell className="text-right tabular">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular">{money(l.unitCostMinor)}</TableCell>
                  <TableCell className="text-right tabular">{money(l.totalMinor)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={4} className="text-right font-medium">{t("columns.total")}</TableCell>
                <TableCell className="text-right font-semibold tabular">{money(view.totalMinor)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {view.notes && <p className="text-sm text-muted-foreground">{view.notes}</p>}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("answer_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {open ? (
            <NextIntlClientProvider locale={locale} messages={{ supplier_portal: messages.supplier_portal as Record<string, unknown>, common: messages.common as Record<string, unknown> }}>
              <SupplierAckForm token={token} defaultDate={view.expectedAt ? view.expectedAt.toISOString().slice(0, 10) : ""} previousNote={view.ackNote} />
            </NextIntlClientProvider>
          ) : (
            <p className="text-sm text-muted-foreground">{t("closed")}</p>
          )}
        </CardContent>
      </Card>
      <footer className="text-center text-xs text-muted-foreground">{t("powered_by", { product: PRODUCT_NAME })}</footer>
    </main>
  );
}
