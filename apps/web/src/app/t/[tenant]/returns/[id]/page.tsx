import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDate, formatDateTime, formatMoney } from "@keel/core";
import { returnDetail } from "@keel/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, DetailShell, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { ReturnWorkflow } from "./workflow";

const STEPS = ["requested", "approved", "received", "inspected"] as const;

export default async function ReturnDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "returns");
  const t = await getTranslations("return_detail");
  const tr = await getTranslations("returns");
  const ts = await getTranslations("return_status");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await ctx.run((tx) => returnDetail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  if (!detail) notFound();
  const { request: r, order, lines, reason, events, locations } = detail;
  const money = (m: number) => formatMoney(m, order.currency, ctx.locale);
  const canAct = canDo(ctx.role, "approve_return");
  const stepIndex = STEPS.indexOf(r.status as (typeof STEPS)[number]);
  const closed = stepIndex === -1;
  return (
    <DetailShell
      back={<Link href={`/t/${tenant}/returns`} className="hover:underline">← {tr("title")}</Link>}
      eyebrow={`${t("order")} ${order.name}`}
      title={`R-${r.number}`}
      chips={
        <>
          <StatusBadge status={r.status} namespace="return_status" />
          <Badge variant="outline">{tr(`resolution.${r.resolution}`)}</Badge>
          <Badge variant={r.fault === "merchant" ? "warning" : "muted"}>{t(`faults.${r.fault}`)}</Badge>
          {r.outOfWindow && <Badge variant="warning">{tr("out_of_window")}</Badge>}
        </>
      }
      actions={<ReturnWorkflow slug={tenant} returnId={r.id} status={r.status} resolution={r.resolution} lines={lines.map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, unitAmountMinor: l.unitAmountMinor, restocked: l.restocked, inspectionAmountMinor: l.inspectionAmountMinor, hasVariant: Boolean(l.variantId) }))} locations={locations} proposedAmountMinor={r.proposedAmountMinor} currency={order.currency} locale={ctx.locale} canAct={canAct} />}
      aside={
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("order")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p><Link href={`/t/${tenant}/orders/${order.id}`} className="font-medium hover:underline">{order.name}</Link> · <StatusBadge status={order.status} /></p>
              <p>{order.customerName}</p>
              <p className="text-muted-foreground">{order.email}</p>
              <p className="text-muted-foreground">{t("placed", { date: formatDate(order.placedAt, ctx.locale, ctx.tenant.timezone) })}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("notes")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><span className="text-muted-foreground">{t("reason")}:</span> {reason?.label ?? r.reasonCode}</p>
              {r.customerNote && <p><span className="text-muted-foreground">{t("customer_note")}:</span> {r.customerNote}</p>}
              {r.staffNote && <p className="whitespace-pre-line"><span className="text-muted-foreground">{t("staff_note")}:</span> {r.staffNote}</p>}
              {r.voucherCode && <p><span className="text-muted-foreground">{t("voucher_code")}:</span> <code>{r.voucherCode}</code></p>}
              {r.restockLocationId && <p className="text-muted-foreground">{t("restocked_at", { location: locations.find((l) => l.id === r.restockLocationId)?.name ?? "—" })}</p>}
            </CardContent>
          </Card>
        </div>
      }
    >
      <ol className="mb-6 flex flex-wrap gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className={`rounded-full border px-3 py-1 ${!closed && i <= stepIndex ? "bg-primary text-primary-foreground" : closed ? "bg-muted" : ""}`}>{ts(s)}</li>
        ))}
        <li className={`rounded-full border px-3 py-1 ${closed ? (r.status === "rejected" ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground") : ""}`}>{closed ? ts(r.status) : t("closing")}</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("proposed_amount")} value={money(r.proposedAmountMinor)} />
        <Stat label={t("accepted_amount")} value={money(lines.reduce((s, l) => s + (l.inspectionAmountMinor ?? l.quantity * l.unitAmountMinor), 0))} />
        <Stat label={t("refunded_amount")} value={r.refundedAmountMinor === null ? "—" : money(r.refundedAmountMinor)} hint={r.closedAt ? formatDateTime(r.closedAt, ctx.locale, ctx.tenant.timezone) : undefined} />
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("lines")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("item")}</TableHead>
                <TableHead className="text-right">{t("qty")}</TableHead>
                <TableHead className="text-right">{t("unit")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("inspection")}</TableHead>
                <TableHead className="text-right">{t("accepted")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("restocked")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.productId ? <Link href={`/t/${tenant}/products/${l.productId}`} className="font-medium hover:underline">{l.title}</Link> : <span className="font-medium">{l.title}</span>}
                    <div className="text-xs text-muted-foreground">{[l.variantTitle, l.sku].filter(Boolean).join(" · ")}</div>
                  </TableCell>
                  <TableCell className="text-right tabular">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular">{money(l.unitAmountMinor)}</TableCell>
                  <TableCell className="hidden md:table-cell">{l.inspectionOutcome ? t(`outcome.${l.inspectionOutcome}`) : "—"}</TableCell>
                  <TableCell className="text-right tabular">{money(l.inspectionAmountMinor ?? l.quantity * l.unitAmountMinor)}</TableCell>
                  <TableCell className="hidden md:table-cell">{l.restocked ? t("yes") : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("history")}</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {events.map((e) => {
              const diff = e.diff as Record<string, { from: unknown; to: unknown }>;
              return (
                <li key={e.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs text-muted-foreground tabular">{formatDateTime(e.createdAt, ctx.locale, ctx.tenant.timezone)}</span>
                  <span>{e.type === "return_requested" ? t("event_requested") : diff.returnStatus ? t("event_status", { from: ts(String(diff.returnStatus.from)), to: ts(String(diff.returnStatus.to)) }) : t("event_updated")}</span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </DetailShell>
  );
}
