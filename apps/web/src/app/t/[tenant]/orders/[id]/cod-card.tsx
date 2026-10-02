import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { displayName, formatDate, formatDateTime, formatMoney } from "@hullwise/core";
import { QUEUE_VIEWS, getCodSettings, listOrderMessages, mergeCandidates, orderPrecheck, queueItemDetail, queueNeighbours, renderOrderTemplates, riskPanel, transfersToday, type QueueView, type ScoreFactor } from "@hullwise/addon-cod";
import { adminDb, and, eq, schema } from "@hullwise/db";
import { getAddressProviderFor } from "@hullwise/services";
import type { Address } from "@hullwise/integrations";
import { EditOrderDialog } from "./edit-order";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { OutcomeDialog, ScoreBadge } from "../../cod/queue-controls";
import { MessagesPanel, PrecheckDialog, TransferMenu } from "./cod-card-extras";

const OPEN = ["pending", "scheduled", "unreachable", "confirm_scheduled"];
const detailText = (f: ScoreFactor) => Object.entries(f.detail).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : String(v)}`).join(" · ");

/**
 * Shown on COD orders when addon.cod is active: explained score with the pre-check, risk economics,
 * attempts, outcome and transfer buttons, confirmation messages and the queue navigator.
 */
export async function CodCard({ ctx, orderId, orderName, canWrite, queue }: { ctx: TenantContext; orderId: string; orderName: string; canWrite: boolean; queue?: { view?: string; tag?: string } }) {
  const t = await getTranslations("cod");
  const tf = await getTranslations("cod.factors");
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  const view: QueueView | null = queue?.view && (QUEUE_VIEWS as readonly string[]).includes(queue.view) ? (queue.view as QueueView) : null;
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const settings = await getCodSettings(s);
    // the pre-check refreshes a stale score first (C.7), so the factors below are current
    const precheck = await orderPrecheck(s, orderId, { timezone: ctx.tenant.timezone, settings, addressProvider: getAddressProviderFor(ctx.tenant.id) });
    const detail = await queueItemDetail(s, orderId);
    if (!detail || !precheck) return null;
    const breakdown = detail.item.scoreBreakdown as { factors?: ScoreFactor[] };
    const isOpen = OPEN.includes(detail.item.status);
    const common = { ...detail, settings, precheck, factors: breakdown.factors ?? [], risk: await riskPanel(s, orderId, settings), messages: await listOrderMessages(s, orderId), nav: view ? await queueNeighbours(s, orderId, { view, userId: ctx.user.id, tag: queue?.tag }) : null };
    if (!isOpen || !canWrite) return { ...common, modify: null, templates: [], transfers: 0 };
    const [order] = await tx.select().from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenant.id), eq(schema.orders.id, orderId))).limit(1);
    const lines = await tx.select().from(schema.orderLines).where(and(eq(schema.orderLines.tenantId, ctx.tenant.id), eq(schema.orderLines.orderId, orderId)));
    const catalog = await tx.select({ id: schema.productVariants.id, sku: schema.productVariants.sku, title: schema.productVariants.title, product: schema.products.title, priceMinor: schema.productVariants.priceMinor }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(and(eq(schema.productVariants.tenantId, ctx.tenant.id), eq(schema.productVariants.isActive, true), eq(schema.products.status, "active"))).orderBy(schema.products.title).limit(600);
    const candidates = await mergeCandidates(s, orderId);
    const templates = await renderOrderTemplates(s, orderId, { shopName: ctx.tenant.name, locale: ctx.locale, operatorName: displayName(ctx.user) }, settings);
    return { ...common, modify: order ? { order, lines, catalog, candidates } : null, templates, transfers: await transfersToday(s, ctx.user.id, ctx.tenant.timezone) };
  });
  if (!data) return null;
  const { item, attempts, factors, modify, precheck, risk, messages, nav, templates, settings } = data;
  const money = (minor: number, currency = modify?.order.currency ?? ctx.tenant.currency) => formatMoney(minor, currency, ctx.locale);
  const addr = (modify?.order.shippingAddress as Address | null) ?? null;
  const open = OPEN.includes(item.status);
  const sorted = [...factors].sort((a, b) => Number(b.contributes) - Number(a.contributes) || b.weight - a.weight);
  const sev = (s: string) => (s === "critical" ? "destructive" : s === "warning" ? "warning" : s === "positive" ? "success" : "muted") as "destructive" | "warning" | "success" | "muted";
  const members = canWrite && open ? await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.isActive, true))) : [];
  const colleagues = members.filter((m) => m.id !== item.assignedTo && ["owner", "admin", "operations", "customer_care"].includes(m.role)).map((m) => ({ id: m.id, label: displayName(m) }));
  const mine = item.assignedTo === ctx.user.id;
  const canTransfer = isAdmin || (mine && item.attemptsCount === 0);
  const navQuery = view ? `?queue=${view}${queue?.tag ? `&tag=${encodeURIComponent(queue.tag)}` : ""}` : "";
  return (
    <Card data-testid="cod-card">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{t("card_title")}</CardTitle>
          <CardDescription>
            {t(`queue_status.${item.status}`)}
            {item.callBackAt ? ` · ${t("call_back_badge", { at: formatDateTime(item.callBackAt, ctx.locale, ctx.tenant.timezone) })}` : ""}
            {item.scheduledConfirmOn ? ` · ${t("planned_badge", { date: formatDate(new Date(`${item.scheduledConfirmOn}T12:00:00Z`), ctx.locale, ctx.tenant.timezone) })}` : ""}
          </CardDescription>
        </div>
        <ScoreBadge score={item.score} tier={item.riskTier} />
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {nav && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs" data-testid="queue-navigator">
            {nav.prev ? <Button asChild variant="ghost" size="sm"><Link href={`/t/${ctx.tenant.slug}/orders/${nav.prev.id}${navQuery}`} data-testid="queue-prev"><ChevronLeft /> {nav.prev.name}</Link></Button> : <span />}
            <Link href={`/t/${ctx.tenant.slug}/cod?view=${view}`} className="text-muted-foreground hover:underline">{nav.position ? t("nav_position", { position: nav.position, total: nav.total, view: t(`views.${view!}`) }) : t(`views.${view!}`)}</Link>
            {nav.next ? <Button asChild variant="ghost" size="sm"><Link href={`/t/${ctx.tenant.slug}/orders/${nav.next.id}${navQuery}`} data-testid="queue-next">{nav.next.name} <ChevronRight /></Link></Button> : <span />}
          </div>
        )}
        {item.escalatedAt && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs" data-testid="escalation-note">{t("escalated_note", { reason: item.escalationReason ?? "" })}</p>}
        {item.scheduledConfirmError && <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{t("planned_error", { error: item.scheduledConfirmError })}</p>}
        <ul className="space-y-1">
          {sorted.map((f) => (
            <li key={f.key} className="flex items-start justify-between gap-2">
              <span className={f.contributes ? "" : "text-muted-foreground"}>
                <Badge variant={sev(f.severity)} className="mr-2">{f.raw === null ? "—" : f.raw}</Badge>
                {tf(`${f.key}.name`)} <span className="text-xs text-muted-foreground">· {t("weight_n", { n: f.weight })}{f.contributes ? "" : ` · ${t("informational")}`}</span>
              </span>
              <span className="max-w-[12rem] truncate text-right text-xs text-muted-foreground" title={JSON.stringify(f.detail)}>{detailText(f)}</span>
            </li>
          ))}
        </ul>
        {risk && (
          <div className="grid grid-cols-2 gap-2 rounded-md border p-2 text-xs sm:grid-cols-4" data-testid="risk-panel">
            <div><span className="block text-muted-foreground">{t("risk_panel.refused")}</span><span className="text-base font-semibold tabular">{risk.refusedPct === null ? "—" : `${risk.refusedPct}%`}</span> <span className="text-muted-foreground">({risk.ordersRefused}/{risk.ordersTotal})</span></div>
            <div><span className="block text-muted-foreground">{t("risk_panel.wasted")}</span><span className="text-base font-semibold tabular">{money(risk.wastedMinor, ctx.tenant.currency)}</span></div>
            <div><span className="block text-muted-foreground">{t("risk_panel.expected")}</span><span className={`text-base font-semibold tabular ${risk.expectedValueMinor !== null && risk.expectedValueMinor < 0 ? "text-destructive" : ""}`} data-testid="expected-value">{risk.expectedValueMinor === null ? "—" : money(risk.expectedValueMinor, ctx.tenant.currency)}</span></div>
            <div><span className="block text-muted-foreground">{t("risk_panel.tier")}</span>{risk.tier ? <Badge variant={risk.tier === "blacklisted" || risk.tier === "high_risk" ? "destructive" : risk.tier === "watch" ? "warning" : "muted"}>{t(`risk.${risk.tier}`)}</Badge> : "—"}</div>
            {risk.linkedKeys.length > 0 && <div className="col-span-2 sm:col-span-4"><span className="text-muted-foreground">{t("risk_panel.linked")}:</span> <span className="font-mono">{risk.linkedKeys.join(" · ")}</span></div>}
            <p className="col-span-2 text-[11px] text-muted-foreground sm:col-span-4">{t("risk_panel.hint", { cost: money(risk.refusalCostMinor, ctx.tenant.currency) })}</p>
          </div>
        )}
        {attempts.length > 0 && (
          <div>
            <p className="mb-1 font-medium">{t("attempts_title", { n: attempts.length })}</p>
            <ul className="space-y-1 text-xs">
              {attempts.map(({ a, operator, operatorEmail }) => (
                <li key={a.id} className="flex flex-wrap gap-2"><span className="tabular text-muted-foreground">{formatDateTime(a.createdAt, ctx.locale, ctx.tenant.timezone)}</span><Badge variant="outline">#{a.attemptNumber}</Badge><span>{t(`outcomes.${a.outcome}`)}</span>{a.channel !== "phone" && <Badge variant="muted">{t.has(`channels.${a.channel}`) ? t(`channels.${a.channel}`) : a.channel}</Badge>}<span className="text-muted-foreground">{operator ?? operatorEmail ?? (a.operatorId ? "" : t("system"))}</span>{a.note && <span className="text-muted-foreground">· {a.note}</span>}</li>
              ))}
            </ul>
          </div>
        )}
        {messages.length > 0 && (
          <div data-testid="message-timeline">
            <p className="mb-1 font-medium">{t("messages.timeline", { n: messages.length })}</p>
            <ul className="space-y-1 text-xs">
              {messages.map(({ m, sender }) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2"><span className="tabular text-muted-foreground">{formatDateTime(m.createdAt, ctx.locale, ctx.tenant.timezone)}</span><Badge variant={m.status === "read" ? "success" : m.status === "failed" ? "destructive" : m.status === "delivered" ? "info" : "outline"} data-testid="message-status">{t(`messages.status.${m.status}`)}</Badge><span>{settings.messageTemplates.find((x) => x.key === m.templateKey)?.name ?? m.templateKey}</span><span className="text-muted-foreground">{sender ?? ""}</span></li>
              ))}
            </ul>
          </div>
        )}
        {canWrite && open && templates.length > 0 && <MessagesPanel slug={ctx.tenant.slug} orderId={orderId} templates={templates} canSend hasPhone={Boolean(modify?.order.phone || modify?.order.phoneE164)} />}
        {canWrite && open && (
          <div className="flex flex-wrap gap-2">
            <OutcomeDialog slug={ctx.tenant.slug} orderId={orderId} orderName={orderName} />
            <PrecheckDialog autoOpen={Boolean(view)} orderId={orderId} orderName={orderName} recomputed={precheck.recomputed} flagged={precheck.flagged.map((f) => ({ key: f.key, severity: f.severity, summary: detailText(f) }))} previousAddresses={precheck.previousAddresses.map((a) => ({ orderId: a.orderId, orderName: a.orderName, date: formatDate(a.placedAt, ctx.locale, ctx.tenant.timezone), address: a.address }))} />
            <TransferMenu slug={ctx.tenant.slug} orderId={orderId} operators={colleagues} canRelease={Boolean(item.assignedTo) && (isAdmin || (mine && item.attemptsCount === 0))} canTransfer={canTransfer} isAdmin={isAdmin} escalated={Boolean(item.escalatedAt)} transfersLeft={isAdmin ? null : Math.max(0, settings.transferDailyLimit - data.transfers)} />
            {modify && (
              <EditOrderDialog
                variant="cod"
                slug={ctx.tenant.slug}
                orderId={orderId}
                orderName={orderName}
                contact={{ customerName: modify.order.customerName ?? "", phone: modify.order.phone ?? "", email: modify.order.email ?? "" }}
                address={{ name: addr?.name ?? modify.order.customerName ?? "", address1: addr?.address1 ?? "", address2: addr?.address2 ?? "", city: addr?.city ?? modify.order.shippingCity ?? "", province: addr?.province ?? "", zip: addr?.zip ?? modify.order.shippingZip ?? "", country: addr?.country ?? modify.order.shippingCountry ?? "" }}
                note={modify.order.note ?? ""}
                lines={modify.lines.filter((l) => l.currentQuantity > 0).map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor }))}
                catalog={modify.catalog.map((v) => ({ id: v.id, label: `${v.sku ? `${v.sku} · ` : ""}${v.product} ${v.title}`.trim(), priceMinor: v.priceMinor }))}
                mergeCandidates={modify.candidates.map((m) => ({ id: m.id, name: m.name, total: money(m.totalMinor, m.currency), lines: m.lines.map((l) => `${l.quantity}× ${l.title}${l.variantTitle ? ` ${l.variantTitle}` : ""}`).join(", ") }))}
                paid={false}
                currency={modify.order.currency}
                locale={ctx.locale}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
