import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDate, formatDiscountValue, formatMoney, formatNumber, type DiscountType } from "@keel/core";
import { discountDetail } from "@keel/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, DetailShell, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { DiscountStateBadge } from "../state-badge";
import { DiscountToggle } from "./toggle";

export default async function DiscountDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "discounts");
  const t = await getTranslations("discount_detail");
  const td = await getTranslations("discounts");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const detail = await ctx.run((tx) => discountDetail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at, id));
  if (!detail) notFound();
  const { discount: d, pool, state, orders, totals } = detail;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  return (
    <DetailShell
      back={<Link href={`/t/${tenant}/discounts`} className="hover:underline">← {td("title")}</Link>}
      eyebrow={d.title ?? pool?.title ?? ctx.tenant.name}
      title={<span className="font-mono">{d.code}</span>}
      chips={
        <>
          <DiscountStateBadge state={state} />
          <Badge variant="outline">{d.type === "free_shipping" ? td("free_shipping") : formatDiscountValue(d.type as DiscountType, d.value, money)}</Badge>
          <Badge variant="muted">{d.source === "keel" ? "Keel" : t("platform")}</Badge>
          {pool && <Link href={`/t/${tenant}/discounts?pool=${pool.id}`} className="text-sm hover:underline">{t("in_pool", { title: pool.title })}</Link>}
        </>
      }
      actions={canDo(ctx.role, "create_discount") ? <DiscountToggle slug={tenant} discountId={d.id} isActive={d.isActive} /> : undefined}
      aside={
        <Card>
          <CardHeader><CardTitle className="text-base">{t("rules")}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="flex justify-between"><span className="text-muted-foreground">{t("validity")}</span><span>{d.startsAt ? formatDate(d.startsAt, ctx.locale, ctx.tenant.timezone) : "—"} → {d.endsAt ? formatDate(d.endsAt, ctx.locale, ctx.tenant.timezone) : "∞"}</span></p>
            <p className="flex justify-between"><span className="text-muted-foreground">{t("usage")}</span><span className="tabular">{formatNumber(d.usedCount, ctx.locale)}{d.usageLimit ? ` / ${formatNumber(d.usageLimit, ctx.locale)}` : ""}</span></p>
            <p className="flex justify-between"><span className="text-muted-foreground">{t("minimum")}</span><span>{d.minimumAmountMinor ? money(d.minimumAmountMinor) : "—"}</span></p>
            <p className="flex justify-between"><span className="text-muted-foreground">{t("external_id")}</span><span className="truncate font-mono text-xs">{d.externalId ?? "—"}</span></p>
          </CardContent>
        </Card>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("kpi.orders")} value={formatNumber(totals.orders, ctx.locale)} hint={t("kpi.orders_hint")} />
        <Stat label={t("kpi.given")} value={money(totals.given)} />
        <Stat label={t("kpi.revenue")} value={money(totals.netRevenueMinor)} />
        <Stat label={t("kpi.margin")} value={money(totals.marginMinor)} hint={totals.netRevenueMinor ? `${((totals.marginMinor / totals.netRevenueMinor) * 100).toFixed(1)}%` : undefined} />
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("orders_title")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("order")}</TableHead>
                <TableHead>{t("date")}</TableHead>
                <TableHead>{t("customer")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead className="text-right">{t("discount")}</TableHead>
                <TableHead className="text-right">{t("total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell><Link href={`/t/${tenant}/orders/${o.id}`} className="font-medium hover:underline">{o.name}</Link></TableCell>
                  <TableCell>{formatDate(o.placedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  <TableCell>{o.customerName}</TableCell>
                  <TableCell><StatusBadge status={o.status} /></TableCell>
                  <TableCell className="text-right tabular">{formatMoney(o.amountMinor, o.currency, ctx.locale)}</TableCell>
                  <TableCell className="text-right tabular">{formatMoney(o.totalMinor, o.currency, ctx.locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </DetailShell>
  );
}
