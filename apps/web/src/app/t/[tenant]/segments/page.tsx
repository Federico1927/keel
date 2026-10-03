import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo, canWritePage, isPageEnabled } from "@hullwise/config";
import { countLeaves, formatDateTime, formatNumber, type SegmentGroup } from "@hullwise/core";
import { listSegments } from "@hullwise/services";
import { Button, Card, CardContent, DataList, EmptyState, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { SegmentRowActions } from "./row-actions";
import { SegmentTabs } from "./segment-tabs";

import { withIntl } from "@/i18n/intl-scope";
async function SegmentsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "segments");
  const t = await getTranslations("segments");
  const segments = await ctx.run((tx) => listSegments({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const canWrite = canWritePage(ctx.role, "segments");
  const canExport = canDo(ctx.role, "export");
  const base = `/t/${tenant}/segments`;
  const groups = isPageEnabled("customer_campaigns", ctx.activeAddons);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={canWrite ? <Button asChild><Link href={`${base}/new`}>{t("new")}</Link></Button> : undefined} />
      <SegmentTabs tenant={tenant} active="segments" activeAddons={ctx.activeAddons} />
      {segments.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={segments}
              rowKey={(s) => s.id}
              rowProps={() => ({ "data-testid": "segment-row" })}
              columns={[
                { key: "name", header: t("columns.name"), mobile: "title", cell: (s) => <><Link href={`${base}/${s.id}`} className="font-medium hover:underline">{s.name}</Link>{s.description && <div className="truncate text-xs font-normal text-muted-foreground">{s.description}</div>}</> },
                { key: "members", header: t("columns.members"), mobile: "badge", align: "right", className: "tabular max-md:font-semibold", cell: (s) => (s.lastCount === null ? "—" : <Link href={`/t/${tenant}/customers?segment=${s.id}`} className="hover:underline">{formatNumber(s.lastCount, ctx.locale)}</Link>) },
                { key: "rules", header: t("columns.rules"), label: "", cell: (s) => t("conditions_n", { n: countLeaves(s.rules as SegmentGroup) }) },
                ...(groups ? [{ key: "holdout", header: t("columns.holdout"), align: "right" as const, className: "tabular", cell: (s: (typeof segments)[number]) => (s.holdoutPercentage ? `${s.holdoutPercentage}%` : "—") }] : []),
                { key: "evaluated", header: t("columns.evaluated"), priority: 2, cell: (s) => (s.lastEvaluatedAt ? formatDateTime(s.lastEvaluatedAt, ctx.locale, ctx.tenant.timezone) : "—") },
                { key: "actions", header: <span className="sr-only">{t("columns.name")}</span>, mobile: "action", cell: (s) => <SegmentRowActions slug={tenant} segmentId={s.id} canWrite={canWrite} canExport={canExport} /> },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(SegmentsPage, "app/t/[tenant]/segments/page.tsx");
