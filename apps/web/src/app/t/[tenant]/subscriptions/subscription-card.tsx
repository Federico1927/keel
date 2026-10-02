import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canViewPage, isPageEnabled } from "@hullwise/config";
import { formatDate, formatMoney } from "@hullwise/core";
import { customerSubscriptions, orderSubscription, type SubscriptionCardRow } from "@hullwise/services";
import { Card, CardContent, CardHeader, CardTitle } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { RiskBadge, SubscriptionStatusBadge, intervalFormatter, svcOf } from "./shared";

/** Whether the viewer sees subscription cards: the add-on is on and their role opens the subscriptions page. */
export const showsSubscriptions = (ctx: TenantContext) => isPageEnabled("subscriptions", ctx.activeAddons) && canViewPage(ctx.role, "subscriptions");

async function Rows({ ctx, rows, extra }: { ctx: TenantContext; rows: SubscriptionCardRow[]; extra?: string }) {
  const t = await getTranslations("subscriptions.card");
  const every = await intervalFormatter();
  const slug = ctx.tenant.slug;
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((r) => (
        <li key={r.id} className="rounded-md border p-2">
          <div className="flex items-center justify-between gap-2"><Link href={`/t/${slug}/subscriptions/subscribers/${r.id}`} className="truncate font-medium hover:underline">{r.products || t("contract")}</Link><SubscriptionStatusBadge status={r.status} /></div>
          <p className="text-xs text-muted-foreground">{formatMoney(r.priceMinor, r.currency, ctx.locale)} · {every(r.intervalUnit, r.intervalCount)} · {t("renewals", { n: r.renewals })}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">{r.nextBillingAt && (r.status === "active" || r.status === "paused") && <span>{t("next", { date: formatDate(r.nextBillingAt, ctx.locale, ctx.tenant.timezone) })}</span>}<RiskBadge risk={r.churnRisk} />{r.paymentFailingSince && <span className="text-destructive">{t("failing")}</span>}</div>
          {extra && <p className="mt-1 text-xs text-muted-foreground">{extra}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The customer's subscriptions on the customer page. */
export async function CustomerSubscriptionsCard({ ctx, customerId }: { ctx: TenantContext; customerId: string }) {
  const rows = await ctx.run((tx) => customerSubscriptions(svcOf(ctx, tx), customerId));
  if (!rows.length) return null;
  const t = await getTranslations("subscriptions.card");
  return (
    <Card data-testid="customer-subscriptions">
      <CardHeader><CardTitle className="text-base">{t("title")}</CardTitle></CardHeader>
      <CardContent><Rows ctx={ctx} rows={rows} /></CardContent>
    </Card>
  );
}

/** The contract behind an order a subscription created, on the order page. */
export async function OrderSubscriptionCard({ ctx, orderId }: { ctx: TenantContext; orderId: string }) {
  const row = await ctx.run((tx) => orderSubscription(svcOf(ctx, tx), orderId));
  if (!row) return null;
  const t = await getTranslations("subscriptions.card");
  return (
    <Card data-testid="order-subscription">
      <CardHeader><CardTitle className="text-base">{t("order_title")}</CardTitle></CardHeader>
      <CardContent><Rows ctx={ctx} rows={[row]} extra={row.isFirst ? t("first_order") : t("renewal_order", { n: row.renewalNumber ?? 0 })} /></CardContent>
    </Card>
  );
}
