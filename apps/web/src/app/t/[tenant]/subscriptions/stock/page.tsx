import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canViewPage } from "@hullwise/config";
import { formatDate, formatNumber } from "@hullwise/core";
import { renewalStock } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { SubscriptionTabs, svcOf } from "../shared";

import { withIntl } from "@/i18n/intl-scope";
const WEEKS = [1, 2, 4, 8] as const;

/** Stock for renewals (addon.subscriptions): units the scheduled renewals need per variant vs available + incoming POs; the reorder suggestion also flows into planning. */
async function RenewalStockPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ weeks?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "subscriptions");
  const t = await getTranslations("subscriptions.stock");
  const weeks = (WEEKS as readonly number[]).includes(Number(sp.weeks)) ? Number(sp.weeks) : 4;
  const rows = await ctx.run((tx) => renewalStock(svcOf(ctx, tx), { weeks }));
  const n = (v: number) => formatNumber(v, ctx.locale);
  const base = `/t/${tenant}/subscriptions/stock`;
  const alerts = rows.filter((r) => r.runOutAt);
  const products = canViewPage(ctx.role, "products");
  const planning = canViewPage(ctx.role, "inventory");
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<div className="flex gap-1 rounded-md bg-muted p-1 text-sm">{WEEKS.map((w) => <Link key={w} href={`${base}?weeks=${w}`} className={cn("rounded-sm px-2 py-1", w === weeks ? "bg-card shadow-sm" : "text-muted-foreground")}>{t("weeks", { n: w })}</Link>)}</div>} />
      <SubscriptionTabs tenant={tenant} active="stock" />
      {alerts.length > 0 && (
        <div className="mb-4 space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="stock-alerts">
          {alerts.map((r) => <p key={r.variantId}><span className="font-medium">{r.label}</span> — {t("alert", { date: formatDate(r.runOutAt!, ctx.locale, ctx.tenant.timezone), units: r.shortfall, suggested: r.suggestedQuantity })}</p>)}
          {planning && <p><Link href={`/t/${tenant}/inventory/planning`} className="underline-offset-4 hover:underline">{t("open_planning")}</Link></p>}
        </div>
      )}
      {rows.length === 0 ? <EmptyState title={t("empty_title")} description={t("empty_description")} /> : (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("table_title", { n: weeks })}</CardTitle><CardDescription>{t("table_description")}</CardDescription></CardHeader>
          <CardContent className="p-0">
            <DataList
              data-testid="renewal-stock"
              rows={rows}
              rowKey={(r) => r.variantId}
              rowProps={(r) => ({ "data-testid": "renewal-stock-row", "data-short": r.runOutAt ? "true" : "false" })}
              columns={[
                { key: "variant", header: t("variant"), mobile: "title", className: "md:max-w-64", cell: (r) => <><span className="block truncate">{products ? <Link href={`/t/${tenant}/products/${r.productId}`} className="hover:underline">{r.label}</Link> : r.label}</span>{r.sku && <span className="font-mono text-xs font-normal text-muted-foreground">{r.sku}</span>}</> },
                { key: "runs_out", header: t("runs_out"), mobile: "badge", cell: (r) => (r.runOutAt ? <Badge variant="destructive">{formatDate(r.runOutAt, ctx.locale, ctx.tenant.timezone)}</Badge> : <span className="text-muted-foreground">{t("covered")}</span>) },
                { key: "renewals", header: t("renewals"), align: "right", className: "tabular", cell: (r) => <Link href={`/t/${tenant}/subscriptions/subscribers?status=active&variant=${r.variantId}`} className="hover:underline">{n(r.renewals)}</Link> },
                { key: "units", header: t("units"), align: "right", className: "tabular", cell: (r) => n(r.units) },
                { key: "available", header: t("available"), align: "right", cell: (r) => <span className={cn("tabular", r.available < r.units && "text-destructive")}>{n(r.available)}</span> },
                { key: "incoming", header: t("incoming"), align: "right", className: "tabular", cell: (r) => n(r.incoming) },
                { key: "suggested", header: t("suggested"), align: "right", className: "font-medium tabular", cell: (r) => <span data-testid="suggested-qty">{r.suggestedQuantity ? n(r.suggestedQuantity) : "—"}</span> },
                { key: "weekly", header: t("by_week"), priority: 2, className: "text-xs text-muted-foreground tabular", cell: (r) => r.weekly.join(" · ") },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(RenewalStockPage, "app/t/[tenant]/subscriptions/stock/page.tsx");
