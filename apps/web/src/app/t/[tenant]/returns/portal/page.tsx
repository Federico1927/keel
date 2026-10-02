import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { appUrl, SUPPORTED_LOCALES, canDo, canWritePage } from "@hullwise/config";
import { PAYMENT_METHODS, RETURN_EMAIL_EVENTS, RETURN_STATUSES } from "@hullwise/core";
import { getPortalConfig, listReturnReasons } from "@hullwise/services";
import { notFound } from "next/navigation";
import { Alert, AlertDescription, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { BehaviourForm, PortalConfigForm } from "./forms";

export default async function ReturnPortalSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "returns");
  if (!canWritePage(ctx.role, "returns")) notFound();
  const t = await getTranslations("return_portal_settings");
  const { config, reasons } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { config: await getPortalConfig(s), reasons: await listReturnReasons(s, true) };
  });
  const origin = appUrl();
  return (
    <>
      <Link href={`/t/${tenant}/returns`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      {!config.enabled && (
        <Alert variant="destructive" className="mb-4" data-testid="portal-off">
          <AlertDescription>{t("off_notice", { url: `${origin}/r/${tenant}` })}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <PortalConfigForm slug={tenant} url={`${origin}/r/${tenant}`} config={config} locales={[...SUPPORTED_LOCALES]} defaultLocale={ctx.tenant.defaultLocale} reasons={reasons.map((r) => ({ code: r.code, label: r.label }))} paymentMethods={[...PAYMENT_METHODS]} />
        <BehaviourForm slug={tenant} canEdit={canDo(ctx.role, "manage_settings")} currency={ctx.tenant.currency} statuses={[...RETURN_STATUSES]} emailEvents={[...RETURN_EMAIL_EVENTS]} initial={{ returnShippingCostMinor: ctx.settings.returnShippingCostMinor, returnsWriteBack: ctx.settings.returnsWriteBack, returnPlatformTags: ctx.settings.returnPlatformTags, returnLabelCostMinor: ctx.settings.returnLabelCostMinor, returnHandlingCostMinor: ctx.settings.returnHandlingCostMinor, returnCustomerEmails: ctx.settings.returnCustomerEmails }} />
      </div>
    </>
  );
}
