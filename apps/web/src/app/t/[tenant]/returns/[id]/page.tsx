import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDate, formatDateTime, formatMoney } from "@keel/core";
import { getPortalConfig, returnDetail, returnEvidenceList } from "@keel/services";
import { pickLocalized } from "@keel/core";
import { Badge, Card, CardContent, CardHeader, CardTitle, DetailShell, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { ReturnWorkflow } from "./workflow";
import { BankDetails, PlatformSyncCard, ReviewToggle } from "./platform-card";

const STEPS = ["requested", "approved", "received", "inspected"] as const;

export default async function ReturnDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "returns");
  const t = await getTranslations("return_detail");
  const tr = await getTranslations("returns");
  const ts = await getTranslations("return_status");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const svc = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const detail = await ctx.run((tx) => returnDetail(svc(tx), id));
  if (!detail) notFound();
  const [evidence, portal] = await ctx.run(async (tx) => [await returnEvidenceList(svc(tx), id), await getPortalConfig(svc(tx))] as const);
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
          <Badge variant={r.source === "portal" ? "info" : "outline"} data-testid="return-source">{tr(`source.${r.source}`)}</Badge>
          {r.riskLevel && r.riskLevel !== "none" && <Badge variant={r.riskLevel === "high" ? "destructive" : "warning"} data-testid="return-risk">{t(`risk.${r.riskLevel}`)}</Badge>}
          {r.needsReview && <Badge variant="warning" data-testid="return-review-badge">{t("needs_review")}</Badge>}
          {r.returnless && <Badge variant="outline">{t("returnless")}</Badge>}
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
              {r.deductionMinor > 0 && <p className="text-muted-foreground">{t("deduction", { amount: money(r.deductionMinor) })}</p>}
            </CardContent>
          </Card>
          {(r.source === "portal" || r.trackingCode || r.exchangeNote || r.bankDetailsEnc || evidence.length > 0 || Object.keys(r.customFields).length > 0) && (
            <Card data-testid="return-portal-card">
              <CardHeader><CardTitle className="text-base">{t("portal.title")}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {r.trackingCode && <p><span className="text-muted-foreground">{t("portal.tracking")}:</span> <code>{r.trackingCode}</code>{r.trackingCarrier ? ` · ${r.trackingCarrier}` : ""}</p>}
                {r.exchangeNote && <p><span className="text-muted-foreground">{t("portal.exchange")}:</span> {r.exchangeNote}</p>}
                {Object.entries(r.customFields).map(([k, v]) => {
                  const field = portal.fields.find((f) => f.key === k);
                  const label = field ? pickLocalized(field.label, ctx.locale, ctx.tenant.defaultLocale) || k : k;
                  const value = typeof v === "boolean" ? (v ? t("yes") : t("no")) : field?.type === "select" ? pickLocalized(field.optionLabels[v], ctx.locale, ctx.tenant.defaultLocale) || v : v;
                  return <p key={k}><span className="text-muted-foreground">{label}:</span> {value}</p>;
                })}
                {r.bankDetailsEnc && (canAct ? <BankDetails slug={tenant} returnId={r.id} /> : <p className="text-muted-foreground">{t("portal.bank_hidden")}</p>)}
                {r.customerLocale && <p className="text-xs text-muted-foreground">{t("portal.language", { locale: r.customerLocale.toUpperCase() })}</p>}
                {evidence.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1" data-testid="return-evidence">
                    {evidence.map((e) => (
                      <a key={e.id} href={`/t/${tenant}/returns/${r.id}/evidence/${e.id}`} target="_blank" rel="noreferrer" className="block h-20 w-20 overflow-hidden rounded border bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/t/${tenant}/returns/${r.id}/evidence/${e.id}`} alt={t("portal.photo")} className="h-full w-full object-cover" />
                      </a>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          {(r.riskLevel || r.automations.length > 0) && (
            <Card data-testid="return-rules-card">
              <CardHeader><CardTitle className="text-base">{t("rules_title")}</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {r.riskLevel && <p><span className="text-muted-foreground">{t("risk_label")}:</span> {t(`risk.${r.riskLevel}`)}{r.riskReasons.length ? ` · ${r.riskReasons.map((x) => t(`risk_reasons.${x}`)).join(", ")}` : ""}</p>}
                {r.automations.length > 0 && (
                  <ul className="space-y-0.5" data-testid="return-automations">
                    {r.automations.map((a) => <li key={a.id}>{a.name} <span className="text-xs text-muted-foreground">· {t(`automation_actions.${a.action}`)}</span></li>)}
                  </ul>
                )}
                {canAct && <ReviewToggle slug={tenant} returnId={r.id} needsReview={r.needsReview} />}
              </CardContent>
            </Card>
          )}
          {!r.riskLevel && r.automations.length === 0 && canAct && <ReviewToggle slug={tenant} returnId={r.id} needsReview={r.needsReview} />}
          <PlatformSyncCard slug={tenant} returnId={r.id} syncStatus={r.platformSyncStatus} platformStatus={r.platformStatus} externalId={r.externalId} refundId={r.platformRefundId} error={r.platformError} syncedAt={r.platformSyncedAt ? formatDateTime(r.platformSyncedAt, ctx.locale, ctx.tenant.timezone) : null} canAct={canAct} />
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
