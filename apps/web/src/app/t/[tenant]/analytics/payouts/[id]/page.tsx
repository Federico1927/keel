import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { formatDate, formatDateTime, formatMoney } from "@keel/core";
import { payoutDetail } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { PAYOUT_STATUS_VARIANT as STATUS_VARIANT } from "../status";

/** One deposit: its orders, fees, refunds and net, every row linked to the order behind it. */
export default async function PayoutDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "analytics");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await ctx.run((tx) => payoutDetail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  if (!d) notFound();
  const t = await getTranslations("payouts");
  const tp = await getTranslations("payment_methods");
  const money = (m: number) => formatMoney(m, d.payout.currency, ctx.locale);
  const p = d.payout;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics/payouts`} className="hover:underline">← {t("back_list")}</Link></p>
      <PageHeader eyebrow={t("detail_eyebrow")} title={t("detail_title", { date: formatDate(p.issuedAt, ctx.locale, ctx.tenant.timezone) })} description={t("detail_description", { id: p.externalId })} actions={<Badge variant={STATUS_VARIANT[p.status] ?? "muted"}>{t(`status.${p.status}`)}</Badge>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("totals.gross")} value={money(p.grossMinor)} hint={t("orders_charged", { n: d.orders.charged })} href={`/t/${tenant}/orders?payout=${p.id}`} />
        <Stat label={t("totals.refunds")} value={money(p.refundsMinor)} hint={t("orders_refunded", { n: d.orders.refunded })} />
        <Stat label={t("totals.adjustments")} value={money(p.adjustmentsMinor)} />
        <Stat label={t("totals.fees")} value={money(p.feeMinor)} />
        <Stat label={t("totals.net")} value={money(p.netMinor)} />
      </div>
      {!d.matches && (
        <Alert variant="warning" className="mb-4" data-testid="payout-mismatch">
          <AlertDescription>{t("mismatch", { net: money(d.computed.netMinor), n: d.transactions.length })}</AlertDescription>
        </Alert>
      )}
      {d.orders.unmatched > 0 && (
        <Alert variant="info" className="mb-4">
          <AlertDescription>{t("unmatched", { n: d.orders.unmatched })}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("transactions_title", { n: d.transactions.length })}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table data-testid="payout-transactions">
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.when")}</TableHead>
                <TableHead>{t("columns.type")}</TableHead>
                <TableHead>{t("columns.order")}</TableHead>
                <TableHead className="text-right">{t("columns.amount")}</TableHead>
                <TableHead className="text-right">{t("columns.fee")}</TableHead>
                <TableHead className="text-right">{t("columns.net")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.transactions.map((x) => (
                <TableRow key={x.id} data-testid="payout-transaction">
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(x.occurredAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  <TableCell>{t(`type.${x.type}`)}</TableCell>
                  <TableCell>
                    {x.orderId ? <Link href={`/t/${tenant}/orders/${x.orderId}`} className="font-medium text-primary hover:underline">{x.orderName}</Link> : <span className="text-muted-foreground">{x.orderExternalId ?? "—"}</span>}
                    {x.paymentMethod && <span className="block text-xs text-muted-foreground">{tp(x.paymentMethod)}</span>}
                  </TableCell>
                  <TableCell className={cn("text-right tabular", x.amountMinor < 0 && "text-destructive")}>{money(x.amountMinor)}</TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">{x.feeMinor ? money(-x.feeMinor) : "—"}</TableCell>
                  <TableCell className="text-right tabular">{money(x.netMinor)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-medium">
                <TableCell colSpan={3}>{t("total")}</TableCell>
                <TableCell className="text-right tabular">{money(d.computed.grossMinor + d.computed.refundsMinor + d.computed.adjustmentsMinor)}</TableCell>
                <TableCell className="text-right tabular">{money(-d.computed.feesMinor)}</TableCell>
                <TableCell className="text-right tabular" data-testid="payout-net">{money(d.computed.netMinor)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
