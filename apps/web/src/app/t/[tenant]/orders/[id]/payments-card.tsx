import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, formatDateTime, formatMoney } from "@keel/core";
import { orderBalanceTransactions, type OrderMoney } from "@keel/services";
import { canViewPage } from "@keel/config";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@keel/ui";
import type { TenantContext } from "@/server/tenant";

/** Money on the order after checkout: manual payments and refunds recorded in Keel, and the processor's view (actual fee, deposits). */
export async function PaymentsCard({ ctx, orderId, currency, money: m, nameOf }: { ctx: TenantContext; orderId: string; currency: string; money: OrderMoney; nameOf: (id: string | null) => string | null }) {
  const t = await getTranslations("order_payments");
  const tp = await getTranslations("payment_methods");
  const showPayouts = canViewPage(ctx.role, "analytics");
  const balance = showPayouts ? await ctx.run((tx) => orderBalanceTransactions({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, orderId)) : [];
  if (!m.transactions.length && !balance.length) return null;
  const fmt = (minor: number) => formatMoney(minor, currency, ctx.locale);
  return (
    <Card data-testid="payments-card">
      <CardHeader>
        <CardTitle className="text-base">{t("card_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {m.transactions.length > 0 && (
          <ul className="divide-y">
            {m.transactions.map((x) => (
              <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid={`order-transaction-${x.kind}`}>
                <span className="min-w-0">
                  <span className="font-medium">{t(`kind.${x.kind}`)}</span>
                  {x.method && x.kind === "manual_payment" && <span className="text-muted-foreground"> · {tp(x.method)}</span>}
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTime(x.occurredAt, ctx.locale, ctx.tenant.timezone)} · {nameOf(x.actorUserId) ?? t("system")}
                    {x.requestedMinor !== null && x.requestedMinor !== x.amountMinor ? ` · ${t("accepted_of", { amount: fmt(x.requestedMinor) })}` : ""}
                  </span>
                  {x.note && <span className="block text-xs italic text-muted-foreground">“{x.note}”</span>}
                </span>
                <span className={x.kind === "refund" ? "tabular text-destructive" : "tabular"}>{x.kind === "refund" ? `−${fmt(x.amountMinor)}` : fmt(x.amountMinor)}</span>
              </li>
            ))}
          </ul>
        )}
        {balance.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("processor")}</p>
            <ul className="space-y-1">
              {balance.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="order-balance-transaction">
                  <span>
                    {t(`balance_type.${b.type}`)} · {fmt(b.amountMinor)}
                    {b.feeMinor ? ` · ${t("fee", { amount: fmt(b.feeMinor) })}` : ""}
                  </span>
                  {b.payoutId && b.payoutIssuedAt ? (
                    <Link href={`/t/${ctx.tenant.slug}/analytics/payouts/${b.payoutId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                      {t("payout_of", { date: formatDate(b.payoutIssuedAt, ctx.locale, ctx.tenant.timezone) })}
                      {b.payoutStatus && b.payoutStatus !== "paid" && <Badge variant="muted" className="text-[10px]">{t(`payout_status.${b.payoutStatus}`)}</Badge>}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{t("not_paid_out")}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
