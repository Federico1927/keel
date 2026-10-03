import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canViewPage, canWritePage } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatPercent } from "@hullwise/core";
import { subscriptionDetail } from "@hullwise/services";
import { Card, CardContent, CardHeader, CardTitle, DataList, DetailShell, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { ContractActions } from "../../controls";
import { RiskBadge, SubscriptionStatusBadge, intervalFormatter, svcOf } from "../../shared";

import { withIntl } from "@/i18n/intl-scope";
const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One subscription contract: lines, care actions the app supports, charges, timeline with author and diff, orders. */
async function SubscriberDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requirePage(tenant, "subscriptions");
  const d = await ctx.run((tx) => subscriptionDetail(svcOf(ctx, tx), id));
  if (!d) notFound();
  const t = await getTranslations("subscriptions");
  const every = await intervalFormatter();
  const c = d.contract;
  const money = (m: number) => formatMoney(m, c.currency, ctx.locale);
  const date = (v: Date | null) => (v ? formatDate(v, ctx.locale, ctx.tenant.timezone) : "—");
  const name = d.customer ? [d.customer.firstName, d.customer.lastName].filter(Boolean).join(" ") || d.customer.email : t("detail.unknown_customer");
  const reason = c.cancellationReasonCode ? (d.reasons.find((r) => r.code === c.cancellationReasonCode)?.label ?? c.cancellationReasonCode) : null;
  const factors = (c.churnFactors as { key: string; impact: number }[] | null) ?? [];
  const showOrders = canViewPage(ctx.role, "orders");
  return (
    <DetailShell
      back={<Link href={`/t/${tenant}/subscriptions/subscribers`} className="hover:underline">← {t("subscribers.title")}</Link>}
      eyebrow={t(`provider.apps.${c.provider}`) + ` · #${c.externalId}`}
      title={name ?? "—"}
      chips={<><SubscriptionStatusBadge status={c.status} /><RiskBadge risk={c.churnRisk} />{c.paymentFailingSince && <span className="text-sm text-destructive" data-testid="detail-failing">{t("detail.failing_since", { date: date(c.paymentFailingSince) })}</span>}</>}
      aside={
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("detail.actions")}</CardTitle></CardHeader>
            <CardContent>
              {canWritePage(ctx.role, "subscriptions") ? <ContractActions slug={tenant} contractId={c.id} status={c.status} capabilities={d.capabilities} nextBillingAt={c.nextBillingAt?.toISOString().slice(0, 10) ?? null} lines={d.lines.map((l) => ({ id: l.id, label: `${l.title}${l.variantTitle ? ` · ${l.variantTitle}` : ""}`, productId: l.productId, variantId: l.variantId }))} swapOptions={d.swapOptions.map((v) => ({ id: v.id, productId: v.productId, title: v.title }))} reasons={d.reasons.filter((r) => r.isActive).map((r) => ({ code: r.code, label: r.label }))} /> : <p className="text-sm text-muted-foreground">{t("detail.read_only")}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("detail.customer")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {d.customer ? <><Link href={`/t/${tenant}/customers/${d.customer.id}`} className="font-medium hover:underline">{name}</Link><p className="text-muted-foreground">{d.customer.email ?? "—"}</p></> : <p className="text-muted-foreground">—</p>}
              <p className="text-muted-foreground">{t("detail.assignee", { name: d.assigneeName ?? t("recovery.unassigned") })}</p>
              <p className="text-muted-foreground">{t("detail.last_contact", { date: date(c.lastContactAt) })}</p>
            </CardContent>
          </Card>
          {factors.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">{t("detail.risk_title")}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>{t("detail.retention", { pct: formatPercent((c.churnRetentionBps ?? 0) / 10_000, ctx.locale, 0) })}</p>
                <ul className="space-y-0.5 text-xs">{factors.map((f) => <li key={f.key} className="flex justify-between gap-2"><span className="text-muted-foreground">{t(`detail.factors.${f.key}`)}</span><span className={f.impact < 0 ? "text-destructive tabular" : "tabular"}>{f.impact > 0 ? "+" : ""}{Math.round(f.impact * 100)}</span></li>)}</ul>
              </CardContent>
            </Card>
          )}
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("detail.price")} value={money(c.priceMinor)} hint={every(c.intervalUnit, c.intervalCount)} />
        <Stat label={t("detail.mrr")} value={money(c.mrrMinor)} />
        <Stat label={t("detail.next_billing")} value={c.endedAt ? "—" : date(c.nextBillingAt)} hint={c.endedAt ? t("subscribers.ended", { date: date(c.endedAt) }) : undefined} />
        <Stat label={t("detail.renewals")} value={String(c.renewalsCount)} hint={t("detail.since", { date: date(c.activatedAt) })} href={showOrders ? `/t/${tenant}/orders?subscriptionContract=${c.id}` : undefined} />
      </div>
      {c.endedAt && <p className="mt-3 text-sm" data-testid="detail-cancellation">{t(`detail.cancelled_${c.cancellationKind === "involuntary" ? "involuntary" : "voluntary"}`, { date: date(c.endedAt) })}{reason ? ` · ${reason}` : ""}{c.cancellationReasonRaw ? <span className="text-muted-foreground"> — “{c.cancellationReasonRaw}”</span> : null}</p>}
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("detail.lines")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataList
            data-testid="subscription-lines"
            rows={d.lines}
            rowKey={(l) => l.id}
            columns={[
              { key: "product", header: t("detail.product"), mobile: "title", cell: (l) => <>{l.productId && canViewPage(ctx.role, "products") ? <Link href={`/t/${tenant}/products/${l.productId}`} className="hover:underline">{l.title}</Link> : l.title}{l.variantTitle && <span className="text-muted-foreground"> · {l.variantTitle}</span>}</> },
              { key: "quantity", header: t("detail.quantity"), align: "right", className: "tabular", cell: (l) => l.quantity },
              { key: "price", header: t("detail.unit_price"), align: "right", className: "tabular", cell: (l) => money(l.unitPriceMinor) },
            ]}
          />
        </CardContent>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("detail.timeline")}</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm" data-testid="subscription-timeline">
              {d.events.map((e) => {
                const diff = Object.entries((e.diff ?? {}) as Record<string, { from?: unknown; to?: unknown }>);
                const meta = e.metadata as { body?: string; errorCode?: string; reason?: string; note?: string };
                return (
                  <li key={e.id} className="border-l-2 pl-3" data-testid="timeline-event" data-type={e.type}>
                    <p><span className="font-medium">{t.has(`events.${e.type}`) ? t(`events.${e.type}`) : e.type}</span> <span className="text-xs text-muted-foreground">· {e.actorName ?? t(`authors.${e.authorType}`)} · {formatDateTime(e.occurredAt, ctx.locale, ctx.tenant.timezone)}</span></p>
                    {diff.length > 0 && <ul className="text-xs text-muted-foreground">{diff.map(([k, v]) => <li key={k}><span className="font-mono">{k}</span>: {k === "assignedTo" ? (d.people[String(v?.from)] ?? fmt(v?.from)) : fmt(v?.from)} → {k === "assignedTo" ? (d.people[String(v?.to)] ?? fmt(v?.to)) : fmt(v?.to)}</li>)}</ul>}
                    {meta.body && <p className="text-xs">{meta.body}</p>}
                    {meta.errorCode && <p className="text-xs text-destructive">{t.has(`payment_errors.${meta.errorCode}`) ? t(`payment_errors.${meta.errorCode}`) : meta.errorCode}</p>}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("detail.charges")}</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table data-testid="subscription-charges">
                <TableHeader><TableRow><TableHead>{t("detail.when")}</TableHead><TableHead>{t("detail.outcome")}</TableHead><TableHead className="text-right">{t("detail.amount")}</TableHead></TableRow></TableHeader>
                <TableBody>{d.attempts.map((a) => <TableRow key={a.id}><TableCell className="whitespace-nowrap text-xs">{formatDateTime(a.attemptedAt, ctx.locale, ctx.tenant.timezone)}</TableCell><TableCell className="text-xs">{a.status === "failed" ? <span className="text-destructive">{t.has(`payment_errors.${a.errorCode}`) ? t(`payment_errors.${a.errorCode}`) : (a.errorCode ?? t("detail.failed"))}{a.nextRetryAt && <span className="text-muted-foreground"> · {t("detail.retry", { date: date(a.nextRetryAt) })}</span>}</span> : t(`detail.attempt_${a.status}`)}</TableCell><TableCell className="text-right tabular">{money(a.amountMinor)}</TableCell></TableRow>)}</TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("detail.orders")}</CardTitle></CardHeader>
            <CardContent className="p-0">
              <DataList
                data-testid="subscription-orders"
                rows={d.orders}
                rowKey={(o) => o.id}
                columns={[
                  { key: "order", header: t("detail.orders"), mobile: "title", cell: (o) => (showOrders ? <Link href={`/t/${tenant}/orders/${o.id}`} className="font-medium hover:underline">{o.name}</Link> : o.name) },
                  { key: "kind", header: t("profit.order_n"), mobile: "subtitle", className: "text-xs text-muted-foreground", cell: (o) => `${o.renewalNumber ? t("profit.renewal_n", { n: o.renewalNumber }) : t("profit.first_order")} · ${date(o.placedAt)}` },
                  { key: "status", header: t("subscribers.status"), mobile: "badge", cell: (o) => <StatusBadge status={o.status} /> },
                  { key: "total", header: t("detail.amount"), align: "right", className: "tabular", cell: (o) => money(o.totalMinor) },
                ]}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </DetailShell>
  );
}

export default withIntl(SubscriberDetailPage, "app/t/[tenant]/subscriptions/subscribers/[id]/page.tsx");
