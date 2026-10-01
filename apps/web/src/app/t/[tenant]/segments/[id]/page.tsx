import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo, canWritePage } from "@keel/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, type SegmentGroup } from "@keel/core";
import { and, eq, schema } from "@keel/db";
import { segmentMembers } from "@keel/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { segmentBuilderOptions } from "@/server/queries/crm";
import { SegmentBuilder } from "../builder";
import { SegmentRowActions } from "../row-actions";
import { TierBadge } from "../../customers/tier-badge";

export default async function SegmentDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "segments");
  const t = await getTranslations("segments");
  const tc = await getTranslations("customers");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await ctx.run(async (tx) => {
    const [segment] = await tx.select().from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenant.id), eq(schema.segments.id, id))).limit(1);
    if (!segment) return null;
    const members = await segmentMembers({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id, { limit: 50 });
    return { segment, members };
  });
  if (!data) notFound();
  const { segment, members } = data;
  const options = await segmentBuilderOptions(ctx);
  const canWrite = canWritePage(ctx.role, "segments");
  const canExport = canDo(ctx.role, "export");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const holdoutCount = segment.lastCount !== null ? Math.round((segment.lastCount * segment.holdoutPercentage) / 100) : null;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/segments`} className="hover:underline">← {t("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={segment.name} description={segment.description ?? undefined} actions={<SegmentRowActions slug={tenant} segmentId={segment.id} canWrite={canWrite} canExport={canExport} afterDelete={`/t/${tenant}/segments`} />} />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label={t("columns.members")} value={segment.lastCount === null ? "—" : formatNumber(segment.lastCount, ctx.locale)} href={`/t/${tenant}/customers?segment=${segment.id}`} hint={segment.lastEvaluatedAt ? t("evaluated_at", { at: formatDateTime(segment.lastEvaluatedAt, ctx.locale, ctx.tenant.timezone) }) : t("never_evaluated")} />
        <Stat label={t("columns.holdout")} value={segment.holdoutPercentage ? `${segment.holdoutPercentage}%` : "—"} hint={holdoutCount !== null && segment.holdoutPercentage ? t("holdout_n", { n: formatNumber(holdoutCount, ctx.locale) }) : undefined} />
        <Stat label={t("treated")} value={segment.lastCount !== null && holdoutCount !== null ? formatNumber(segment.lastCount - holdoutCount, ctx.locale) : "—"} />
      </div>
      <SegmentBuilder slug={tenant} segment={{ id: segment.id, name: segment.name, description: segment.description, rules: segment.rules as SegmentGroup, holdoutPercentage: segment.holdoutPercentage }} options={options} currency={ctx.tenant.currency} locale={ctx.locale} canWrite={canWrite} />
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("members_title")}</CardTitle>
          <CardDescription>{t("members_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc("columns.customer")}</TableHead>
                <TableHead>{t("group")}</TableHead>
                <TableHead className="text-right">{tc("columns.orders")}</TableHead>
                <TableHead className="text-right">{tc("columns.total_spent")}</TableHead>
                <TableHead className="hidden md:table-cell">{tc("columns.last_order")}</TableHead>
                <TableHead>{tc("columns.tier")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.customerId} data-testid="member-row">
                  <TableCell><Link href={`/t/${tenant}/customers/${m.customerId}`} className="hover:underline">{[m.firstName, m.lastName].filter(Boolean).join(" ") || m.email || "—"}</Link></TableCell>
                  <TableCell><Badge variant={m.groupName === "holdout" ? "warning" : "muted"}>{t(`groups.${m.groupName}`)}</Badge></TableCell>
                  <TableCell className="text-right tabular">{m.ordersCount}</TableCell>
                  <TableCell className="text-right tabular">{money(m.totalSpentMinor)}</TableCell>
                  <TableCell className="hidden md:table-cell">{m.lastOrderAt ? formatDate(m.lastOrderAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                  <TableCell><TierBadge tier={m.tier} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
