import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDateTime } from "@keel/core";
import { listEmailSuppressions } from "@keel/services";
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { NotificationTabs } from "../tabs";
import { AddSuppressionForm, RemoveSuppressionButton } from "./forms";

export default async function SuppressionsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "notifications");
  if (!canDo(ctx.role, "manage_settings")) notFound();
  const t = await getTranslations("notifications");
  const rows = await ctx.run((tx) => listEmailSuppressions({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const category = (c: string) => (c === "all" ? t("suppressions.all_categories") : c === "supplier_po" || c === "return_updates" ? t(`suppressions.${c}`) : t.has(`types.${c}`) ? t(`types.${c}`) : c);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("suppressions.title")} description={t("suppressions.description")} />
      <NotificationTabs ctx={ctx} active="suppressions" />
      <AddSuppressionForm slug={tenant} />
      <Card className="mt-4">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("suppressions.email")}</TableHead>
                <TableHead>{t("suppressions.reason")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("suppressions.category")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("suppressions.when")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} data-testid="suppression-row">
                  <TableCell className="break-all text-sm">{r.email}{r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}</TableCell>
                  <TableCell><Badge variant={r.reason === "bounce" || r.reason === "complaint" ? "destructive" : "muted"}>{t(`suppressions.reasons.${r.reason}`)}</Badge></TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{category(r.category)}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{formatDateTime(r.createdAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  <TableCell className="text-right"><RemoveSuppressionButton slug={tenant} id={r.id} label={t("suppressions.remove")} /></TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-muted-foreground">{t("suppressions.empty")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
