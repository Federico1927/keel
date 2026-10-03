import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatMoney, formatNumber, usedAmount } from "@hullwise/core";
import { costMonths, listPeriodCosts } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CostLineForm, DeleteCostButton } from "./costs-form";

import { withIntl } from "@/i18n/intl-scope";
/** Fixed and shipping costs per month: estimate first, actual when the invoice arrives. The P/L uses actual ?? estimate. */
async function PeriodCostsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("analytics.costs");
  const canWrite = canWritePage(ctx.role, "settings");
  const months = costMonths(new Date());
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const data = await ctx.run((tx) => listPeriodCosts({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at, months));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const current = months[1];
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics?tab=pnl`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-4">
        {months.map((period) => {
          const lines = data.rows.filter((r) => r.period === period);
          const shipping = lines.find((r) => r.kind === "shipping");
          const fixed = lines.filter((r) => r.kind !== "shipping");
          const fixedEstimate = fixed.reduce((s, r) => s + r.estimateMinor, 0);
          const fixedUsed = fixed.reduce((s, r) => s + usedAmount(r).minor, 0);
          const fixedAllActual = fixed.length > 0 && fixed.every((r) => r.actualMinor !== null);
          const shipEstimate = data.shippingEstimateByMonth[period] ?? 0;
          const orders = data.ordersByMonth[period] ?? 0;
          const isFuture = period > (current ?? "");
          return (
            <Card key={period} data-testid="cost-month">
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">{period}{period === current && <Badge variant="info" className="ml-2">{t("current")}</Badge>}{isFuture && <Badge variant="muted" className="ml-2">{t("next")}</Badge>}</CardTitle>
                  <CardDescription>{t("orders_n", { n: formatNumber(orders, ctx.locale) })} · {t("fixed_used", { amount: money(fixedUsed) })} · {t("shipping_used", { amount: money(shipping?.actualMinor ?? shipEstimate) })}</CardDescription>
                </div>
                <div className="flex gap-1">
                  <Badge variant={fixedAllActual ? "success" : fixed.length ? "warning" : "muted"}>{t("fixed")}: {fixedAllActual ? t("source.actual") : fixed.length ? t("source.estimate") : t("source.none")}</Badge>
                  <Badge variant={shipping?.actualMinor !== null && shipping ? "success" : "warning"}>{t("shipping")}: {shipping?.actualMinor !== null && shipping ? t("source.actual") : t("source.estimate")}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="px-2 py-1">{t("line")}</th>
                        <th className="px-2 py-1 text-right">{t("estimate")}</th>
                        <th className="px-2 py-1 text-right">{t("actual")}</th>
                        <th className="px-2 py-1 text-right">{t("used")}</th>
                        <th className="px-2 py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="px-2 py-1">{t("shipping")} <span className="text-xs text-muted-foreground">· {t("shipping_hint", { amount: money(shipEstimate) })}</span></td>
                        <td className="px-2 py-1 text-right tabular">{money(shipping?.estimateMinor ?? shipEstimate)}</td>
                        <td className="px-2 py-1 text-right tabular">{shipping?.actualMinor !== null && shipping ? money(shipping.actualMinor) : "—"}</td>
                        <td className="px-2 py-1 text-right tabular font-medium">{money(shipping?.actualMinor ?? shipEstimate)}</td>
                        <td className="px-2 py-1 text-right">{canWrite && <CostLineForm slug={tenant} period={period} kind="shipping" label="" estimate={(shipping?.estimateMinor ?? shipEstimate) / 100} actual={shipping?.actualMinor !== null && shipping ? shipping.actualMinor / 100 : null} compact />}</td>
                      </tr>
                      {fixed.map((r) => (
                        <tr key={r.id} className="border-b" data-testid="cost-line">
                          <td className="px-2 py-1">{r.label || t("fixed")}{r.kind === "other" && <Badge variant="outline" className="ml-1">{t("kind_other")}</Badge>}</td>
                          <td className="px-2 py-1 text-right tabular">{money(r.estimateMinor)}</td>
                          <td className="px-2 py-1 text-right tabular">{r.actualMinor !== null ? money(r.actualMinor) : "—"}</td>
                          <td className="px-2 py-1 text-right tabular font-medium">{money(usedAmount(r).minor)}</td>
                          <td className="px-2 py-1 text-right">{canWrite && <span className="flex justify-end gap-1"><CostLineForm slug={tenant} period={period} kind={r.kind} label={r.label} estimate={r.estimateMinor / 100} actual={r.actualMinor !== null ? r.actualMinor / 100 : null} compact /><DeleteCostButton slug={tenant} id={r.id} /></span>}</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="px-2 py-1 font-medium">{t("fixed_total")}</td>
                        <td className="px-2 py-1 text-right tabular">{money(fixedEstimate)}</td>
                        <td className="px-2 py-1 text-right tabular">{fixedAllActual ? money(fixed.reduce((s, r) => s + (r.actualMinor ?? 0), 0)) : "—"}</td>
                        <td className="px-2 py-1 text-right tabular font-medium">{money(fixedUsed)}</td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
                {canWrite && <CostLineForm slug={tenant} period={period} kind="fixed" label="" estimate={0} actual={null} />}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

export default withIntl(PeriodCostsPage, "app/t/[tenant]/analytics/costs/page.tsx");
