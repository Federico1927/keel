import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canViewPage } from "@keel/config";
import { formatMoney, formatNumber } from "@keel/core";
import { productProfitTable } from "@keel/services";
import { Card, CardContent, CardHeader, CardTitle } from "@keel/ui";
import { analyticsTenant, runAnalytics } from "@/server/analytics";
import { resolvePeriod } from "@/server/period";
import type { TenantContext } from "@/server/tenant";

/**
 * The product's P/L over the last 30 days, from the same service as Analytics → Products (sale
 * orders only, linked campaign spend split by revenue), so the two pages always agree.
 */
export async function ProductPnlCard({ ctx, slug, productId, title }: { ctx: TenantContext; slug: string; productId: string; title: string }) {
  if (!canViewPage(ctx.role, "analytics")) return null;
  const t = await getTranslations("product_mirror.pnl");
  const period = resolvePeriod({ preset: "30d" }, ctx.tenant.timezone);
  const table = await runAnalytics(ctx, (s) => productProfitTable(s, analyticsTenant(ctx), period, { q: title, pageSize: 0 }));
  const row = table.rows.find((r) => r.productId === productId);
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const line = (label: string, value: string, strong = false) => (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "tabular font-semibold" : "tabular"}>{value}</span>
    </div>
  );
  return (
    <Card data-testid="product-pnl">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <Link href={`/t/${slug}/analytics?tab=products&preset=30d&q=${encodeURIComponent(title)}`} className="text-sm text-primary hover:underline">{t("open")}</Link>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {!row ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            {line(t("units"), formatNumber(row.units, ctx.locale))}
            {line(t("net_revenue"), money(row.netRevenueMinor))}
            {line(t("cogs"), `−${money(row.cogsMinor)}`)}
            {line(t("gross_margin"), money(row.grossMarginMinor))}
            {line(t("ad_spend"), `−${money(row.adSpendMinor)}`)}
            {line(t("profit"), money(row.profitMinor), true)}
            {row.unitsWithoutCost > 0 && <p className="text-xs text-warning">{t("missing_cost", { units: row.unitsWithoutCost })}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
