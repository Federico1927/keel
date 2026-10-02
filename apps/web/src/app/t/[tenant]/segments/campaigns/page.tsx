import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { after } from "next/server";
import { canDo, canWritePage } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { listRetentionCampaigns } from "@hullwise/services";
import { Button, Card, CardContent, DataList, EmptyState, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { kickCampaigns } from "@/server/campaigns";
import { SegmentTabs } from "../segment-tabs";
import { UpliftBadge } from "./uplift-badge";
import { CampaignStatusBadge } from "./status-badge";

import { withIntl } from "@/i18n/intl-scope";
async function RetentionCampaignsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "customer_campaigns");
  const t = await getTranslations("retention");
  const ts = await getTranslations("segments");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const rows = await ctx.run((tx) => listRetentionCampaigns({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at));
  const canWrite = canWritePage(ctx.role, "customer_campaigns");
  const base = `/t/${tenant}/segments/campaigns`;
  // without a worker, due campaigns start and queued messages go out on page loads
  after(() => kickCampaigns(ctx));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={ts("title")} description={t("description")} actions={<>{canDo(ctx.role, "manage_settings") && <Button asChild variant="outline"><Link href={`${base}/settings`} data-testid="campaign-settings-link">{t("settings.link")}</Link></Button>}{canWrite && <Button asChild><Link href={`${base}/new`}>{t("new")}</Link></Button>}</>} />
      <SegmentTabs tenant={tenant} active="campaigns" activeAddons={ctx.activeAddons} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              rowProps={() => ({ "data-testid": "retention-row" })}
              columns={[
                { key: "name", header: t("columns.name"), mobile: "title", cell: (r) => <><Link href={`${base}/${r.id}`} className="font-medium hover:underline">{r.name}</Link><div className="truncate text-xs font-normal text-muted-foreground">{r.segmentName ?? t("segment_deleted")}</div></> },
                { key: "sent", header: t("columns.sent"), mobile: "badge", cell: (r) => <><CampaignStatusBadge status={r.status} label={t(`status.${r.status}`)} /><div className="text-xs text-muted-foreground max-md:hidden">{r.status === "scheduled" && r.scheduledAt ? formatDateTime(r.scheduledAt, ctx.locale, ctx.tenant.timezone) : r.sentAt ? formatDate(r.sentAt, ctx.locale, ctx.tenant.timezone) : ""}</div></> },
                { key: "channel", header: t("columns.channel"), mobile: "subtitle", cell: (r) => <>{t(`channels.${r.channel}`)}{r.kind === "sequence" && <span className="text-xs text-muted-foreground md:block"><span className="md:hidden"> · </span>{t("kinds.sequence")}</span>}<span className="text-xs md:hidden">{r.status === "scheduled" && r.scheduledAt ? ` · ${formatDateTime(r.scheduledAt, ctx.locale, ctx.tenant.timezone)}` : r.sentAt ? ` · ${formatDate(r.sentAt, ctx.locale, ctx.tenant.timezone)}` : ""}</span></> },
                { key: "groups", header: t("columns.groups"), align: "right", priority: 2, className: "tabular", cell: (r) => (r.sentAt ? `${formatNumber(r.treatedCount, ctx.locale)} / ${formatNumber(r.holdoutCount, ctx.locale)}` : "—") },
                { key: "uplift", header: t("columns.uplift"), label: "", cell: (r) => <UpliftBadge results={r.results} locale={ctx.locale} /> },
                { key: "margin", header: t("columns.net_margin"), align: "right", className: "tabular", cell: (r) => (r.results?.report.netIncrementalMarginMinor != null ? money(r.results.report.netIncrementalMarginMinor) : "—") },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(RetentionCampaignsPage, "app/t/[tenant]/segments/campaigns/page.tsx");
