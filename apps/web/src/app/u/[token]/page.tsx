import type { Metadata } from "next";
import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, PRODUCT_NAME, isLocale, type Locale } from "@hullwise/config";
import { eq, schema, withTenant } from "@hullwise/db";
import { verifyUnsubscribeToken } from "@hullwise/services";
import { loadMessages } from "@/i18n/messages";
import { UnsubscribeForm } from "./form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Public page behind the unsubscribe link of every optional email; confirming is a POST, so link scanners do not unsubscribe anyone. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = verifyUnsubscribeToken(decodeURIComponent(token));
  const tenant = p ? await withTenant(p.tenantId, async (tx) => (await tx.select({ name: schema.tenants.name, defaultLocale: schema.tenants.defaultLocale }).from(schema.tenants).where(eq(schema.tenants.id, p.tenantId)).limit(1))[0] ?? null) : null;
  const locale: Locale = tenant && isLocale(tenant.defaultLocale) ? tenant.defaultLocale : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages }) as unknown as ((k: string, v?: Record<string, string>) => string) & { has: (k: string) => boolean };
  const category = p ? (p.category === "all" ? t("unsubscribe.all") : t.has(`notifications.types.${p.category}`) ? t(`notifications.types.${p.category}`) : p.category === "supplier_po" ? t("notifications.suppressions.supplier_po") : p.category) : "";
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">{PRODUCT_NAME}</p>
        {!p || !tenant ? (
          <>
            <h1 className="mt-2 text-xl">{t("unsubscribe.invalid_title")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("unsubscribe.invalid")}</p>
          </>
        ) : (
          <UnsubscribeForm
            token={decodeURIComponent(token)}
            labels={{ confirmTitle: t("unsubscribe.confirm_title"), confirm: t("unsubscribe.confirm", { category, tenant: tenant.name, email: p.email }), button: t("unsubscribe.button"), doneTitle: t("unsubscribe.done_title"), done: t("unsubscribe.done", { category, tenant: tenant.name, email: p.email }), invalid: t("unsubscribe.invalid") }}
          />
        )}
      </div>
    </main>
  );
}
