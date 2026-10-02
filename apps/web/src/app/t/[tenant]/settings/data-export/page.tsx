import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { TENANT_EXPORT_TTL_DAYS, canDo } from "@keel/config";
import { listTenantExports } from "@keel/services";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { AutoRefresh } from "@/components/lists/auto-refresh";
import { DataExportTable } from "@/components/data-export/export-table";
import { RequestDataExportButton } from "@/components/data-export/request-button";

/** Full data export of the tenant (#32): owner only. One CSV per table in a zip, link valid for a few days. */
export default async function DataExportPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  if (!canDo(ctx.role, "export_tenant_data")) notFound();
  const t = await getTranslations("data_export");
  const ts = await getTranslations("settings");
  const rows = await ctx.run((tx) => listTenantExports(tx, ctx.tenant.id));
  const busy = rows.some((r) => r.status === "pending" || r.status === "running");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<Button asChild variant="outline"><Link href={`/t/${tenant}/settings`}>{ts("title")}</Link></Button>} />
      {busy && <AutoRefresh seconds={3} />}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t("what_title")}</CardTitle>
          <CardDescription>{t("what_description", { days: TENANT_EXPORT_TTL_DAYS })}</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestDataExportButton mode="owner" target={tenant} disabled={busy} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <DataExportTable rows={rows} locale={ctx.locale} timezone={ctx.tenant.timezone} hrefFor={(id) => `/t/${tenant}/settings/data-export/${id}`} />
        </CardContent>
      </Card>
    </>
  );
}
