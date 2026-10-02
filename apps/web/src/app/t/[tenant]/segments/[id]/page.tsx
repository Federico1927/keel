import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo, canWritePage, isPageEnabled } from "@keel/config";
import { formatDate, formatDateTime, formatMoney, formatNumber, type SegmentGroup } from "@keel/core";
import { and, eq, schema } from "@keel/db";
import { listSegmentDestinations, segmentInsights, segmentMembers } from "@keel/services";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { segmentBuilderOptions } from "@/server/queries/crm";
import { SegmentBuilder } from "../builder";
import { SegmentRowActions } from "../row-actions";
import { TierBadge } from "../../customers/tier-badge";
import { SegmentSyncCard } from "./destinations";
import { SegmentInsightsCard } from "./insights";

export default async function SegmentDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "segments");
  const t = await getTranslations("segments");
  const tc = await getTranslations("customers");
  const tr = await getTranslations("retention");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await ctx.run(async (tx) => {
    const [segment] = await tx.select().from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenant.id), eq(schema.segments.id, id))).limit(1);
    if (!segment) return null;
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const members = await segmentMembers(s, id, { limit: 50 });
    const destinations = await listSegmentDestinations(s, id);
    const insights = await segmentInsights(s, id);
    return { segment, members, destinations, insights };
  });
  if (!data) notFound();
  const { segment, members, destinations, insights } = data;
  const options = await segmentBuilderOptions(ctx);
  const canWrite = canWritePage(ctx.role, "segments");
  const canExport = canDo(ctx.role, "export");
  const groups = isPageEnabled("customer_campaigns", ctx.activeAddons);
  const canCampaign = groups && canWritePage(ctx.role, "customer_campaigns");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const holdoutCount = segment.lastCount !== null ? Math.round((segment.lastCount * segment.holdoutPercentage) / 100) : null;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/segments`} className="hover:underline">← {t("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={segment.name} description={segment.description ?? undefined} actions={<>{canCampaign && <Button asChild variant="outline" size="sm"><Link href={`/t/${tenant}/segments/campaigns/new?segment=${segment.id}`}>{tr("new_for_segment")}</Link></Button>}<SegmentRowActions slug={tenant} segmentId={segment.id} canWrite={canWrite} canExport={canExport} afterDelete={`/t/${tenant}/segments`} /></>} />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label={t("columns.members")} value={segment.lastCount === null ? "—" : formatNumber(segment.lastCount, ctx.locale)} href={`/t/${tenant}/customers?segment=${segment.id}`} hint={segment.lastEvaluatedAt ? t("evaluated_at", { at: formatDateTime(segment.lastEvaluatedAt, ctx.locale, ctx.tenant.timezone) }) : t("never_evaluated")} />
        {groups && <Stat label={t("columns.holdout")} value={segment.holdoutPercentage ? `${segment.holdoutPercentage}%` : "—"} hint={holdoutCount !== null && segment.holdoutPercentage ? t("holdout_n", { n: formatNumber(holdoutCount, ctx.locale) }) : undefined} />}
        {groups && <Stat label={t("treated")} value={segment.lastCount !== null && holdoutCount !== null ? formatNumber(segment.lastCount - holdoutCount, ctx.locale) : "—"} />}
      </div>
      <SegmentBuilder slug={tenant} segment={{ id: segment.id, name: segment.name, description: segment.description, rules: segment.rules as SegmentGroup, holdoutPercentage: segment.holdoutPercentage }} options={options} currency={ctx.tenant.currency} locale={ctx.locale} canWrite={canWrite} holdoutEnabled={groups} />
      {insights.members > 0 && <SegmentInsightsCard tenant={tenant} insights={insights} currency={ctx.tenant.currency} locale={ctx.locale} />}
      <SegmentSyncCard
        slug={tenant}
        segmentId={segment.id}
        segmentName={segment.name}
        live={segment.liveUpdates}
        canWrite={canWrite}
        canPush={canWrite && canExport}
        holdoutExcluded={groups}
        destinations={destinations.map((d) => ({ id: d.id, provider: d.provider, audienceName: d.audienceName, autoSync: d.autoSync, status: d.status, memberCount: d.memberCount, lastSyncAt: d.lastSyncAt ? d.lastSyncAt.toISOString() : null, lastAdded: d.lastAdded, lastRemoved: d.lastRemoved, lastError: d.lastError }))}
      />
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
                {groups && <TableHead>{t("group")}</TableHead>}
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
                  {groups && <TableCell><Badge variant={m.groupName === "holdout" ? "warning" : "muted"}>{t(`groups.${m.groupName}`)}</Badge></TableCell>}
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
