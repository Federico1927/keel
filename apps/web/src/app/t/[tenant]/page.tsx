import { getTranslations } from "next-intl/server";
import { PageHeader, Stat } from "@keel/ui";
import { requirePage } from "@/server/tenant";

export default async function DashboardPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "dashboard");
  const t = await getTranslations("dashboard");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("kpi.revenue")} value="—" hint={t("coming_soon")} />
        <Stat label={t("kpi.orders")} value="—" hint={t("coming_soon")} />
        <Stat label={t("kpi.aov")} value="—" hint={t("coming_soon")} />
        <Stat label={t("kpi.cancel_rate")} value="—" hint={t("coming_soon")} />
      </div>
    </>
  );
}
