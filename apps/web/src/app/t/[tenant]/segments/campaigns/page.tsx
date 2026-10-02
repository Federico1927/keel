import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDate, formatMoney, formatNumber } from "@hullwise/core";
import { listRetentionCampaigns } from "@hullwise/services";
import { Badge, Button, Card, CardContent, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { SegmentTabs } from "../segment-tabs";
import { UpliftBadge } from "./uplift-badge";

export default async function RetentionCampaignsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "customer_campaigns");
  const t = await getTranslations("retention");
  const ts = await getTranslations("segments");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const rows = await ctx.run((tx) => listRetentionCampaigns({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at));
  const canWrite = canWritePage(ctx.role, "customer_campaigns");
  const base = `/t/${tenant}/segments/campaigns`;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={ts("title")} description={t("description")} actions={canWrite ? <Button asChild><Link href={`${base}/new`}>{t("new")}</Link></Button> : undefined} />
      <SegmentTabs tenant={tenant} active="campaigns" activeAddons={ctx.activeAddons} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.channel")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.sent")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.groups")}</TableHead>
                  <TableHead>{t("columns.uplift")}</TableHead>
                  <TableHead className="text-right">{t("columns.net_margin")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="retention-row">
                    <TableCell>
                      <Link href={`${base}/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                      <div className="truncate text-xs text-muted-foreground">{r.segmentName ?? t("segment_deleted")}</div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{t(`channels.${r.channel}`)}</TableCell>
                    <TableCell className="hidden md:table-cell">{r.status === "draft" ? <Badge variant="outline">{t("status.draft")}</Badge> : r.sentAt ? formatDate(r.sentAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{r.status === "sent" ? `${formatNumber(r.treatedCount, ctx.locale)} / ${formatNumber(r.holdoutCount, ctx.locale)}` : "—"}</TableCell>
                    <TableCell><UpliftBadge results={r.results} locale={ctx.locale} /></TableCell>
                    <TableCell className="text-right tabular">{r.results?.report.netIncrementalMarginMinor != null ? money(r.results.report.netIncrementalMarginMinor) : "—"}</TableCell>
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
