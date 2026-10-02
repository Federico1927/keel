import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { RFM_FREQUENCY_BANDS, RFM_RECENCY_BANDS, buildRfmMatrix, formatMoney, formatNumber, rulesForRfmCell, rulesForRfmTier } from "@hullwise/core";
import { customerProfiles } from "@hullwise/services";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CustomerTabs } from "../customer-tabs";
import { encodeRulesParam } from "@/server/queries/crm";
import { TierBadge } from "../tier-badge";

import { withIntl } from "@/i18n/intl-scope";
async function RfmPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "customers");
  const t = await getTranslations("rfm");
  const tc = await getTranslations("customers");
  const profiles = await ctx.run((tx) => customerProfiles({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const matrix = buildRfmMatrix(profiles);
  const base = `/t/${tenant}/customers`;
  const canSegment = canWritePage(ctx.role, "segments");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const cell = (r: string, f: string) => matrix.cells.find((c) => c.recency === r && c.frequency === f);
  const max = Math.max(1, ...matrix.cells.map((c) => c.customers));
  const segmentHref = (rules: unknown) => `/t/${tenant}/segments/new?rules=${encodeRulesParam(rules)}`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={tc("title")} description={t("description")} />
      <CustomerTabs tenant={tenant} active="rfm" />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("matrix_title")}</CardTitle>
          <CardDescription>{t("matrix_description", { total: formatNumber(matrix.total, ctx.locale) })}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("recency_axis")}</TableHead>
                {RFM_FREQUENCY_BANDS.map((f) => (
                  <TableHead key={f} className="text-center">{t(`frequency.${f}`)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {RFM_RECENCY_BANDS.map((r) => (
                <TableRow key={r}>
                  <TableCell className="font-medium">{t(`recency.${r}`)}</TableCell>
                  {RFM_FREQUENCY_BANDS.map((f) => {
                    const c = cell(r, f);
                    const intensity = c ? Math.min(1, 0.15 + (c.customers / max) * 0.85) : 0;
                    const inner = (
                      <div className="rounded-md p-2 text-center" style={{ backgroundColor: c ? `color-mix(in oklab, var(--primary) ${Math.round(intensity * 35)}%, transparent)` : undefined }}>
                        <div className="text-base font-semibold tabular">{c ? formatNumber(c.customers, ctx.locale) : "—"}</div>
                        {c && <div className="text-[11px] text-muted-foreground">{t("contactable_short", { n: formatNumber(c.contactable, ctx.locale) })} · {money(c.revenueMinor)}</div>}
                      </div>
                    );
                    return (
                      <TableCell key={f} className="p-1 align-top">
                        {c && canSegment ? <Link href={segmentHref(rulesForRfmCell(r, f))} data-testid="rfm-cell" className={cn("block hover:ring-2 hover:ring-ring rounded-md")}>{inner}</Link> : inner}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("tiers_title")}</CardTitle>
          <CardDescription>{t("tiers_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={matrix.tiers}
            rowKey={(x) => x.tier}
            rowProps={() => ({ "data-testid": "rfm-tier-row" })}
            columns={[
              { key: "tier", header: t("tier_col"), mobile: "title", cell: (x) => <TierBadge tier={x.tier} /> },
              { key: "customers", header: tc("columns.customers"), mobile: "badge", align: "right", className: "tabular", cell: (x) => <Link href={`${base}?tier=${x.tier}`} className="hover:underline">{formatNumber(x.customers, ctx.locale)}</Link> },
              { key: "rule", header: t("tier_rule"), mobile: "subtitle", className: "text-xs text-muted-foreground", cell: (x) => t(`tier_rules.${x.tier}`) },
              { key: "contactable", header: t("contactable"), align: "right", className: "tabular", cell: (x) => formatNumber(x.contactable, ctx.locale) },
              { key: "revenue", header: t("revenue"), align: "right", className: "tabular", cell: (x) => money(x.revenueMinor) },
              { key: "share", header: t("share"), align: "right", className: "tabular", cell: (x) => (matrix.total ? `${((x.customers / matrix.total) * 100).toFixed(1)}%` : "—") },
              { key: "segment", header: <span className="sr-only">{t("make_segment")}</span>, mobile: "action", align: "right", cell: (x) => canSegment && x.customers > 0 && <Link href={segmentHref(rulesForRfmTier(x.tier))} className="text-sm hover:underline">{t("make_segment")}</Link> },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(RfmPage, "app/t/[tenant]/customers/rfm/page.tsx");
