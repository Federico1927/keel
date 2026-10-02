import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isPageEnabled } from "@hullwise/config";
import { formatDate, formatMoney, formatNumber, formatPercent } from "@hullwise/core";
import { customerDetail } from "@hullwise/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, DataList, DetailShell, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { WhatsappLog } from "@/components/whatsapp-log";
import { TierBadge } from "../tier-badge";
import { ChurnBadge } from "../churn-badge";
import { CustomerSubscriptionsCard, showsSubscriptions } from "../../subscriptions/subscription-card";

export default async function CustomerDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "customers");
  const t = await getTranslations("customer_detail");
  const tc = await getTranslations("customers");
  const tp = await getTranslations("payment_methods");
  const tpr = await getTranslations("predictions");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await ctx.run((tx) => customerDetail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  if (!detail) notFound();
  const { customer: c, orders, segments, prediction: p } = detail;
  const groups = isPageEnabled("customer_campaigns", ctx.activeAddons);
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "—";
  return (
    <DetailShell
      back={<Link href={`/t/${tenant}/customers`} className="hover:underline">← {tc("title")}</Link>}
      eyebrow={[c.country, c.city].filter(Boolean).join(" · ") || ctx.tenant.name}
      title={name}
      chips={
        <>
          <TierBadge tier={c.tier} />
          {c.acceptsMarketing && <Badge variant="success">{t("accepts_marketing")}</Badge>}
          {c.tags.map((tag) => (
            <Badge key={tag} variant="outline">{tag}</Badge>
          ))}
        </>
      }
      aside={
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("contact")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="break-all">{c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : "—"}</p>
              <p>{c.phone ? <a href={`tel:${c.phone}`} className="hover:underline" data-testid="customer-phone">{c.phone}</a> : "—"}</p>
              <p className="text-muted-foreground">{t("customer_since", { date: c.firstOrderAt ? formatDate(c.firstOrderAt, ctx.locale, ctx.tenant.timezone) : c.platformCreatedAt ? formatDate(c.platformCreatedAt, ctx.locale, ctx.tenant.timezone) : "—" })}</p>
            </CardContent>
          </Card>
          {showsSubscriptions(ctx) && <CustomerSubscriptionsCard ctx={ctx} customerId={c.customerId} />}
          <Card data-testid="prediction-card">
            <CardHeader><CardTitle className="text-base">{tpr("card_title")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!p ? (
                <p className="text-muted-foreground">{tpr("card_none")}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{tpr("columns.risk")}</span><ChurnBadge risk={p.churnRisk} /></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{tpr("columns.p_alive")}</span><span className="tabular">{formatPercent(p.pAlive, ctx.locale, 0)}</span></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{tpr("card_expected_orders")}</span><span className="tabular">{formatNumber(p.expectedOrders90, ctx.locale, { maximumFractionDigits: 2 })} · {formatNumber(p.expectedOrders365, ctx.locale, { maximumFractionDigits: 2 })}</span></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{tpr("card_order_value")}</span><span className="tabular">{money(p.expectedOrderValueMinor)}</span></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{tpr("columns.predicted_value")}</span><span className="font-medium tabular">{money(p.predictedValue365Minor)}</span></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{tpr("columns.next_order")}</span><span className="tabular">{p.nextOrderAt ? formatDate(p.nextOrderAt, ctx.locale, ctx.tenant.timezone) : "—"}</span></div>
                  <p className="text-xs text-muted-foreground">{tpr("card_computed", { at: formatDate(p.computedAt, ctx.locale, ctx.tenant.timezone) })}</p>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("segments")}</CardTitle></CardHeader>
            <CardContent>
              {segments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("no_segments")}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {segments.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <Link href={`/t/${tenant}/segments/${s.id}`} className="hover:underline">{s.name}</Link>
                      {groups && <Badge variant={s.groupName === "holdout" ? "warning" : "muted"}>{t(`group.${s.groupName}`)}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("kpi.orders")} value={formatNumber(c.ordersCount, ctx.locale)} hint={t("kpi.orders_hint", { cancelled: c.cancelledCount, returned: c.returnsCount })} href={`/t/${tenant}/orders?customer=${c.customerId}`} />
        <Stat label={t("kpi.total_spent")} value={money(c.totalSpentMinor)} />
        <Stat label={t("kpi.aov")} value={c.aovMinor === null ? "—" : money(c.aovMinor)} />
        <Stat label={t("kpi.last_order")} value={c.lastOrderAt ? formatDate(c.lastOrderAt, ctx.locale, ctx.tenant.timezone) : "—"} hint={c.daysSinceLastOrder !== null ? t("days_ago", { n: c.daysSinceLastOrder }) : undefined} />
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("orders_title")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={orders}
            rowKey={(o) => o.id}
            columns={[
              { key: "order", header: t("order"), mobile: "title", cell: (o) => <Link href={`/t/${tenant}/orders/${o.id}`} className="font-medium hover:underline">{o.name}</Link> },
              { key: "total", header: t("total"), mobile: "badge", align: "right", className: "tabular max-md:font-semibold", cell: (o) => formatMoney(o.totalMinor, o.currency, ctx.locale) },
              { key: "date", header: t("date"), mobile: "subtitle", cell: (o) => formatDate(o.placedAt, ctx.locale, ctx.tenant.timezone) },
              { key: "status", header: t("status"), label: "", cell: (o) => <StatusBadge status={o.status} /> },
              { key: "payment", header: t("payment"), label: "", cell: (o) => (tp.has(o.paymentMethod) ? tp(o.paymentMethod) : o.paymentMethod) },
            ]}
          />
        </CardContent>
      </Card>
      <div className="mt-6"><WhatsappLog ctx={ctx} customerId={id} /></div>
    </DetailShell>
  );
}
