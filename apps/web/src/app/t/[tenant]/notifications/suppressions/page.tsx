import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo, isPageEnabled } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { listEmailSuppressions } from "@hullwise/services";
import { Badge, Card, CardContent, DataList, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { NotificationTabs } from "../tabs";
import { AddSuppressionForm, RemoveSuppressionButton } from "./forms";

export default async function SuppressionsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "notifications");
  if (!canDo(ctx.role, "manage_settings")) notFound();
  const t = await getTranslations("notifications");
  const rows = await ctx.run((tx) => listEmailSuppressions({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const category = (c: string) => (c === "all" ? t("suppressions.all_categories") : c === "supplier_po" || c === "return_updates" || c === "marketing" ? t(`suppressions.${c}`) : t.has(`types.${c}`) ? t(`types.${c}`) : c);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("suppressions.title")} description={t("suppressions.description")} />
      <NotificationTabs ctx={ctx} active="suppressions" />
      <AddSuppressionForm slug={tenant} marketing={isPageEnabled("customer_campaigns", ctx.activeAddons)} />
      <Card className="mt-4">
        <CardContent className="p-0">
          {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("suppressions.empty")}</p> : (
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              rowProps={() => ({ "data-testid": "suppression-row" })}
              columns={[
                { key: "email", header: t("suppressions.email"), mobile: "title", className: "break-all text-sm", cell: (r) => <>{r.email}{r.identityType === "phone" && <Badge variant="muted" className="ml-2">{t("suppressions.phone")}</Badge>}{r.note && <p className="text-xs font-normal text-muted-foreground">{r.note}</p>}</> },
                { key: "reason", header: t("suppressions.reason"), mobile: "badge", cell: (r) => <Badge variant={r.reason === "bounce" || r.reason === "complaint" ? "destructive" : "muted"}>{t(`suppressions.reasons.${r.reason}`)}</Badge> },
                { key: "category", header: t("suppressions.category"), className: "text-sm", cell: (r) => category(r.category) },
                { key: "when", header: t("suppressions.when"), className: "text-sm text-muted-foreground", cell: (r) => formatDateTime(r.createdAt, ctx.locale, ctx.tenant.timezone) },
                { key: "remove", header: <span className="sr-only">{t("suppressions.remove")}</span>, mobile: "action", align: "right", cell: (r) => <RemoveSuppressionButton slug={tenant} id={r.id} label={t("suppressions.remove")} /> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
