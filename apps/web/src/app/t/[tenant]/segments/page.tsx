import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo, canWritePage } from "@keel/config";
import { countLeaves, formatDateTime, formatNumber, type SegmentGroup } from "@keel/core";
import { listSegments } from "@keel/services";
import { Button, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { SegmentRowActions } from "./row-actions";
import { SegmentTabs } from "./segment-tabs";

export default async function SegmentsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "segments");
  const t = await getTranslations("segments");
  const segments = await ctx.run((tx) => listSegments({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const canWrite = canWritePage(ctx.role, "segments");
  const canExport = canDo(ctx.role, "export");
  const base = `/t/${tenant}/segments`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={canWrite ? <Button asChild><Link href={`${base}/new`}>{t("new")}</Link></Button> : undefined} />
      <SegmentTabs tenant={tenant} active="segments" />
      {segments.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.rules")}</TableHead>
                  <TableHead className="text-right">{t("columns.members")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.holdout")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.evaluated")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.map((s) => (
                  <TableRow key={s.id} data-testid="segment-row">
                    <TableCell>
                      <Link href={`${base}/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                      {s.description && <div className="truncate text-xs text-muted-foreground">{s.description}</div>}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{t("conditions_n", { n: countLeaves(s.rules as SegmentGroup) })}</TableCell>
                    <TableCell className="text-right tabular">{s.lastCount === null ? "—" : <Link href={`/t/${tenant}/customers?segment=${s.id}`} className="hover:underline">{formatNumber(s.lastCount, ctx.locale)}</Link>}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{s.holdoutPercentage ? `${s.holdoutPercentage}%` : "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell">{s.lastEvaluatedAt ? formatDateTime(s.lastEvaluatedAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                    <TableCell><SegmentRowActions slug={tenant} segmentId={s.id} canWrite={canWrite} canExport={canExport} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
