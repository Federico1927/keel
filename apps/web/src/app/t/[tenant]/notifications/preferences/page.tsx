import { getTranslations } from "next-intl/server";
import { notificationTypesFor } from "@keel/config";
import { preferenceMatrix } from "@keel/services";
import { PageHeader } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { NotificationTabs } from "../tabs";
import { PreferencesMatrix } from "./matrix";

export default async function NotificationPreferencesPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "notifications");
  const t = await getTranslations("notifications");
  const rows = await ctx.run((tx) => preferenceMatrix({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id, notificationTypesFor(ctx.activeAddons)));
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("preferences.title")} description={t("preferences.description")} />
      <NotificationTabs ctx={ctx} active="preferences" />
      <PreferencesMatrix slug={tenant} rows={rows} />
    </>
  );
}
