import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { WIDGETS, canWritePage } from "@hullwise/config";
import { dataHealthForRole } from "@hullwise/core";
import { DATA_HEALTH_ORDER_DAYS, DATA_HEALTH_RECENT_DAYS, dataHealthReport } from "@hullwise/services";
import { PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant, pageNow } from "@/server/dashboards";
import { DataHealthDetails } from "@/components/dashboard/data-health";

import { withIntl } from "@/i18n/intl-scope";
/** Data completeness (#99): every check with its numbers, for the roles that can fix at least one gap (the widget's rule); each row shows only what the role can act on. */
async function DataHealthPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "dashboard");
  if (!(WIDGETS.setup_health.actPages ?? []).some((p) => canWritePage(ctx.role, p))) notFound();
  const t = await getTranslations("data_health");
  const report = await ctx.run((tx) => dataHealthReport({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, analyticsTenant(ctx), pageNow()));
  const mine = dataHealthForRole(report, (p) => canWritePage(ctx.role, p));
  return (
    <>
      <Link href={`/t/${tenant}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("page.back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("page.description", { days: DATA_HEALTH_ORDER_DAYS, recent: DATA_HEALTH_RECENT_DAYS })} />
      <DataHealthDetails report={mine} env={{ base: `/t/${tenant}`, locale: ctx.locale, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone }} />
    </>
  );
}

export default withIntl(DataHealthPage, "app/t/[tenant]/data-health/page.tsx");
