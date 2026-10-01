import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatMoney, formatPercent } from "@keel/core";
import { orderPnlDetail } from "@keel/services";
import { canViewPage } from "@keel/config";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@keel/ui";
import type { TenantContext } from "@/server/tenant";
import { analyticsTenant, runAnalytics } from "@/server/analytics";

/** Order P/L (the same `orderEconomics` the period P/L sums), shown to roles that can read analytics. */
export async function EconomicsCard({ ctx, orderId }: { ctx: TenantContext; orderId: string }) {
  if (!canViewPage(ctx.role, "analytics")) return null;
  const d = await runAnalytics(ctx, (s) => orderPnlDetail(s, analyticsTenant(ctx), orderId));
  if (!d) return null;
  const t = await getTranslations("analytics_depth.economics");
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const p = d.pnl;
  const neg = (m: number) => (m ? -m : 0);
  const rows: { key: string; value: number; bold?: boolean; badge?: string }[] = p
    ? [
        { key: "gross", value: p.grossRevenueMinor },
        ...(p.refundedMinor ? [{ key: "refunds", value: neg(p.refundedMinor) }] : []),
        { key: "tax", value: neg(p.taxMinor) },
        { key: "net", value: p.netRevenueMinor, bold: true },
        { key: "cogs", value: neg(p.cogsMinor), badge: p.cogsComplete ? undefined : t("incomplete") },
        { key: "shipping", value: neg(p.shippingCostMinor), badge: t("estimated") },
        { key: "fee", value: neg(p.paymentFeeMinor), badge: t(`fee_source.${d.paymentFeeSource}`) },
        { key: "margin", value: p.marginMinor, bold: true },
        { key: "returns", value: neg(p.returnCostMinor) },
        { key: "contribution", value: p.contributionMinor, bold: true },
      ]
    : [];
  return (
    <Card data-testid="order-economics">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{d.replaced ? t("replaced") : p && !p.inScope ? t("not_sale") : t("description")}</CardDescription>
      </CardHeader>
      {p && p.inScope && (
        <CardContent className="space-y-1 text-sm">
          {rows.map((r) => (
            <div key={r.key} className={cn("flex items-center justify-between gap-2", r.bold && "border-t pt-1 font-medium")} data-testid={`economics-${r.key}`}>
              <span className="flex items-center gap-1.5">
                {t(`lines.${r.key}`)}
                {r.badge && <Badge variant="outline" className="text-[10px]">{r.badge}</Badge>}
              </span>
              <span className={cn("tabular", r.value < 0 && "text-muted-foreground", r.bold && r.value < 0 && "text-destructive")}>{money(r.value)}</span>
            </div>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">{t("margin_rate", { rate: formatPercent(p.netRevenueMinor ? p.contributionMinor / p.netRevenueMinor : null, ctx.locale) })}</p>
          <Link href={`/t/${ctx.tenant.slug}/analytics?${new URLSearchParams({ tab: "orders_pnl", from: d.placedAt.toISOString().slice(0, 10), to: d.placedAt.toISOString().slice(0, 10), q: d.name })}`} className="text-xs underline-offset-4 hover:underline">{t("open_table")}</Link>
        </CardContent>
      )}
    </Card>
  );
}
