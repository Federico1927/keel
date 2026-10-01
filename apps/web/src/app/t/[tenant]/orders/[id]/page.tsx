import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { adminDb, eq, inArray, schema } from "@keel/db";
import { formatDateTime, formatMoney, daysInTransit, orderEditBlock } from "@keel/core";
import { customerOrderHistory, duplicateSiblings, latestPlatformWrites } from "@keel/services";
import { ORDER_DISCOUNT_PRESETS_BPS, canDo, canViewPage, canWritePage, isPageEnabled } from "@keel/config";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardHeader, CardTitle, DetailShell, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { adjacentOrders, getOrderDetail, getOrderEditData } from "@/server/queries/orders";
import { StatusBadge } from "@/components/status-badge";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { OrderActions } from "./actions-bar";
import { Timeline } from "./timeline";
import { NotesPanel } from "./notes";
import { CodCard } from "./cod-card";
import { EditOrderDialog, type AddressForm } from "./edit-order";
import { DiscountOrderDialog } from "./discount-order";
import { RecordTasks } from "@/components/record-tasks";

export default async function OrderDetailPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "orders");
  const detail = await getOrderDetail(ctx, id);
  if (!detail) notFound();
  const { order, lines, events, notes, shipments, sourceStates, shipmentEvents, attribution, campaign, discounts, returns } = detail;
  const canRequestReturn = canWritePage(ctx.role, "returns") && isPageEnabled("returns", ctx.activeAddons) && ["shipped", "delivered", "returned_partial"].includes(order.status);
  const t = await getTranslations("order_detail");
  const tp = await getTranslations("payment_methods");
  const [history, duplicates, adjacent, platformWrite] = await Promise.all([
    ctx.run((tx) => customerOrderHistory({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id)),
    ctx.run((tx) => duplicateSiblings({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id, ctx.settings.duplicateOrderWindowDays)),
    adjacentOrders(ctx, order.placedAt, order.id),
    ctx.run(async (tx) => (await latestPlatformWrites({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, "order", [id])).get(id)),
  ]);
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const actorIds = [...new Set([...events.map((e) => e.actorUserId), ...notes.map((n) => n.authorId), order.assignedTo].filter((x): x is string => Boolean(x)))];
  const extra = actorIds.filter((a) => !members.some((m) => m.id === a));
  const extraUsers = extra.length ? await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, extra)) : [];
  const people = [...members, ...extraUsers].map((m) => ({ id: m.id, name: m.name ?? m.email }));
  const nameOf = (id: string | null | undefined) => (id ? (people.find((p) => p.id === id)?.name ?? "—") : null);
  const base = `/t/${tenant}/orders`;
  const fmt = (minor: number) => formatMoney(minor, order.currency, ctx.locale);
  const addr = order.shippingAddress as { name?: string; address1?: string; address2?: string; city?: string; province?: string; zip?: string; country?: string; phone?: string } | null;
  const canChange = canDo(ctx.role, "change_order_state");
  // order editing (core, any payment method): open and unfulfilled orders, roles with edit_order
  const editBlock = orderEditBlock({ ...order, shipmentCount: shipments.length });
  const canEdit = canDo(ctx.role, "edit_order") && editBlock === null;
  const edit = await getOrderEditData(ctx, order, { editable: canEdit });
  const showEdit = canEdit && !edit.codOwnsEdit;
  const tl = await getTranslations("order_detail.lineage");
  const nameById = new Map(edit.lineage.map((o) => [o.id, o.name]));
  const replacedSources = edit.lineage.filter((o) => o.replacedByOrderId === order.id);
  const replacedBy = order.replacedByOrderId ? { id: order.replacedByOrderId, name: nameById.get(order.replacedByOrderId) ?? order.replacedByOrderId.slice(0, 8) } : null;
  const asForm = (a: typeof addr): AddressForm => ({ name: a?.name ?? order.customerName ?? "", address1: a?.address1 ?? "", address2: a?.address2 ?? "", city: a?.city ?? order.shippingCity ?? "", province: a?.province ?? "", zip: a?.zip ?? order.shippingZip ?? "", country: a?.country ?? order.shippingCountry ?? "" });
  const paid = order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded";
  const editProps = {
    slug: tenant,
    orderId: order.id,
    orderName: order.name,
    contact: { customerName: order.customerName ?? "", phone: order.phone ?? "", email: order.email ?? "" },
    address: asForm(addr),
    billing: order.billingAddress ? asForm(order.billingAddress as typeof addr) : null,
    note: order.note ?? "",
    lines: lines.filter((l) => l.currentQuantity > 0).map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.currentQuantity, unitPriceMinor: l.unitPriceMinor })),
    catalog: edit.catalog.map((v) => ({ id: v.id, label: `${v.sku ? `${v.sku} · ` : ""}${v.product} ${v.title}`.trim(), priceMinor: v.priceMinor })),
    mergeCandidates: edit.candidates.map((m) => ({ id: m.id, name: m.name, total: formatMoney(m.totalMinor, m.currency, ctx.locale), lines: m.lines.map((l) => `${l.quantity}× ${l.title}${l.variantTitle ? ` ${l.variantTitle}` : ""}`).join(", ") })),
    paid,
    currency: order.currency,
    locale: ctx.locale,
  };
  const mergeableDuplicates = showEdit ? duplicates.filter((d) => edit.candidates.some((c) => c.id === d.orderId)).map((d) => d.orderId) : [];

  return (
    <DetailShell
      back={
        <div className="flex items-center justify-between">
          <Link href={base} className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-4 w-4" /> {t("back")}
          </Link>
          <div className="flex items-center gap-1">
            {adjacent.newer && (
              <Button asChild variant="ghost" size="sm">
                <Link href={`${base}/${adjacent.newer.id}`}>
                  <ChevronLeft /> {adjacent.newer.name}
                </Link>
              </Button>
            )}
            {adjacent.older && (
              <Button asChild variant="ghost" size="sm">
                <Link href={`${base}/${adjacent.older.id}`}>
                  {adjacent.older.name} <ChevronRight />
                </Link>
              </Button>
            )}
          </div>
        </div>
      }
      eyebrow={formatDateTime(order.placedAt, ctx.locale, ctx.tenant.timezone)}
      title={order.name}
      chips={
        <>
          <StatusBadge status={order.status} />
          {order.statusSource === "manual" && <Badge variant="outline">{t("manual_status")}</Badge>}
          <StatusBadge status={order.paymentStatus} namespace="payment_status" />
          <Badge variant="secondary">{tp(order.paymentMethod)}</Badge>
          {order.platformTags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          {order.assignedTo && <Badge variant="info">{t("assigned_to", { name: nameOf(order.assignedTo) ?? "" })}</Badge>}
          <PlatformWriteStatus slug={tenant} write={platformWrite} canRetry={canDo(ctx.role, "cancel_order")} showError />
        </>
      }
      actions={
        canChange || canEdit ? (
          <>
            {showEdit && <EditOrderDialog {...editProps} />}
            {canEdit && <DiscountOrderDialog slug={tenant} orderId={order.id} orderName={order.name} amounts={order} presetsBps={ORDER_DISCOUNT_PRESETS_BPS} paid={paid} currency={order.currency} locale={ctx.locale} />}
            {canChange && <OrderActions slug={tenant} orderId={order.id} currentStatus={order.status} statusSource={order.statusSource} cancelled={Boolean(order.cancelledAt) || Boolean(order.replacedByOrderId)} members={people} assignedTo={order.assignedTo} canCancel={canDo(ctx.role, "cancel_order")} canAssign={canDo(ctx.role, "assign")} />}
          </>
        ) : undefined
      }
      aside={
        <>
          <RecordTasks slug={tenant} type="order" id={order.id} label={order.name} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("customer")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-medium">{order.customerName ?? "—"}</p>
              <p className="text-muted-foreground">{order.email}</p>
              <p className="text-muted-foreground">{order.phone}</p>
              {addr && (
                <address className="not-italic text-muted-foreground">
                  {addr.address1}
                  {addr.address2 ? `, ${addr.address2}` : ""}
                  <br />
                  {addr.zip} {addr.city} {addr.province ? `(${addr.province})` : ""}
                  <br />
                  {addr.country}
                </address>
              )}
              {order.customerId && (
                <Link href={`/t/${tenant}/customers/${order.customerId}`} className="text-primary hover:underline">
                  {t("open_customer")}
                </Link>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("history_title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!history.identified ? (
                <p className="text-muted-foreground">{t("history_unidentified")}</p>
              ) : history.orders.length === 0 ? (
                <p className="text-muted-foreground">{t("history_first")}</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded border p-2"><span className="block text-muted-foreground">{t("history.total")}</span><span className="font-serif text-lg tabular">{history.stats.total}</span></div>
                    <div className="rounded border p-2"><span className="block text-muted-foreground">{t("history.spent")}</span><span className="font-serif text-lg tabular">{fmt(history.stats.totalSpentMinor)}</span></div>
                    <div className="rounded border p-2"><span className="block text-muted-foreground">{t("history.delivered")}</span><span className="tabular">{history.stats.delivered}</span></div>
                    <div className="rounded border p-2"><span className="block text-muted-foreground">{t("history.returned")}</span><span className="tabular">{history.stats.returned}</span> · <span className="text-muted-foreground">{t("history.cancelled")}</span> <span className="tabular">{history.stats.cancelled}</span></div>
                  </div>
                  <ul className="max-h-64 space-y-1 overflow-y-auto">
                    {history.orders.slice(0, 30).map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-2">
                        <Link href={`${base}/${o.id}`} className="text-primary hover:underline">
                          {o.name}
                        </Link>
                        <span className="flex items-center gap-1">
                          {o.matchedVia !== "customer" && <Badge variant={o.matchedVia === "name" ? "warning" : "outline"} className="text-[10px]">{t(`history.via.${o.matchedVia}`)}</Badge>}
                          <StatusBadge status={o.status} className="text-[10px]" />
                        </span>
                      </li>
                    ))}
                  </ul>
                  {history.hops > 1 && <p className="text-xs text-muted-foreground">{t("history_hops", { hops: history.hops })}</p>}
                </>
              )}
            </CardContent>
          </Card>
          {attribution && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("attribution")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">{t("channel")}:</span> {attribution.channel}
                </p>
                {campaign && (
                  <p>
                    <span className="text-muted-foreground">{t("campaign")}:</span>{" "}
                    <Link href={`/t/${tenant}/campaigns/${campaign.id}`} className="text-primary hover:underline">
                      {campaign.name}
                    </Link>
                  </p>
                )}
                {attribution.utmSource && <p className="text-xs text-muted-foreground">utm: {[attribution.utmSource, attribution.utmMedium, attribution.utmCampaign].filter(Boolean).join(" / ")}</p>}
                {order.landingSite && <p className="truncate text-xs text-muted-foreground" title={order.landingSite}>{order.landingSite}</p>}
              </CardContent>
            </Card>
          )}
        </>
      }
    >
      {edit.lineage.length > 0 && (
        <Alert variant={replacedBy ? "warning" : "info"} data-testid="lineage-banner">
          <AlertTitle>{tl("title")}</AlertTitle>
          <AlertDescription className="space-y-1">
            {replacedBy && (
              <p>
                {tl.rich("replaced_by", { order: replacedBy.name, link: (chunks) => <Link href={`${base}/${replacedBy.id}`} className="font-medium underline">{chunks}</Link> })}
                {!order.cancelledAt && ` ${tl("not_cancelled")}`}
              </p>
            )}
            {order.replacesOrderId && (
              <p>
                {tl("replaces")}{" "}
                {(replacedSources.length ? replacedSources : [{ id: order.replacesOrderId, name: nameById.get(order.replacesOrderId) ?? "—" }]).map((o, i) => <span key={o.id}>{i > 0 ? ", " : ""}<Link href={`${base}/${o.id}`} className="font-medium underline">{o.name}</Link></span>)}
                . {tl("replaces_hint")}
              </p>
            )}
            {edit.lineage.length > 2 && (
              <p className="text-xs">
                {tl("chain")}:{" "}
                {edit.lineage.map((o, i) => <span key={o.id}>{i > 0 ? " → " : ""}{o.id === order.id ? <strong>{o.name}</strong> : <Link href={`${base}/${o.id}`} className="underline">{o.name}</Link>}</span>)}
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
      {duplicates.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>{t("duplicates_title")}</AlertTitle>
          <AlertDescription>
            {t("duplicates_description", { days: ctx.settings.duplicateOrderWindowDays })}{" "}
            {duplicates.map((d) => (
              <Link key={d.orderId} href={`${base}/${d.orderId}`} className="mr-2 font-medium underline">
                {d.name} ({t(`duplicates.${d.matchType}`)})
              </Link>
            ))}
            {mergeableDuplicates.length > 0 && (
              <span className="mt-2 block">
                <EditOrderDialog {...editProps} trigger="merge" initialMerge={mergeableDuplicates} />
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {order.holdReason && (
        <Alert variant="info">
          <AlertDescription>{t("on_hold_reason", { reason: order.holdReason })}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("lines")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("line.product")}</TableHead>
                <TableHead className="text-right">{t("line.qty")}</TableHead>
                <TableHead className="text-right">{t("line.unit")}</TableHead>
                <TableHead className="text-right">{t("line.total")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.productId ? (
                      <Link href={`/t/${tenant}/products/${l.productId}`} className="font-medium hover:underline">
                        {l.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{l.title}</span>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {l.variantTitle} {l.sku ? `· ${l.sku}` : ""}
                    </p>
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {l.currentQuantity}
                    {l.currentQuantity !== l.quantity && <span className="text-muted-foreground"> / {l.quantity}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular">{fmt(l.unitPriceMinor)}</TableCell>
                  <TableCell className="text-right tabular">{fmt(l.totalMinor)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-t p-4 text-sm sm:ml-auto sm:w-80">
            <dt className="text-muted-foreground">{t("totals.subtotal")}</dt>
            <dd className="text-right tabular">{fmt(order.subtotalMinor)}</dd>
            {order.discountMinor > 0 && (
              <>
                <dt className="text-muted-foreground">
                  {t("totals.discount")} {discounts.map((d) => d.code).join(", ")}
                </dt>
                <dd className="text-right tabular">−{fmt(order.discountMinor)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t("totals.shipping")}</dt>
            <dd className="text-right tabular">{fmt(order.shippingMinor)}</dd>
            <dt className="text-muted-foreground">{t("totals.tax")}</dt>
            <dd className="text-right tabular">{fmt(order.taxMinor)}</dd>
            <dt className="font-medium">{t("totals.total")}</dt>
            <dd className="text-right font-medium tabular">{fmt(order.totalMinor)}</dd>
            {order.refundedMinor > 0 && (
              <>
                <dt className="text-muted-foreground">{t("totals.refunded")}</dt>
                <dd className="text-right tabular text-destructive">−{fmt(order.refundedMinor)}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {shipments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("shipments")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {shipments.map((s) => (
              <div key={s.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={s.status} namespace="shipment_status" />
                  <span className="font-medium">{s.carrier}</span>
                  {s.trackingUrl ? (
                    <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {s.trackingNumber}
                    </a>
                  ) : (
                    <span>{s.trackingNumber}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{t("days_in_transit", { days: daysInTransit(s.shippedAt, s.deliveredAt) ?? 0 })}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {sourceStates.filter((x) => x.shipmentId === s.id).map((x) => (
                    <span key={x.id} className={`rounded border px-1.5 py-0.5 ${x.source === s.sourceOfTruth ? "border-primary text-foreground" : ""}`}>
                      {x.source}: {x.status} · {formatDateTime(x.lastEventAt, ctx.locale, ctx.tenant.timezone)}
                    </span>
                  ))}
                </div>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {shipmentEvents.filter((e) => e.shipmentId === s.id).slice(0, 6).map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="w-36 shrink-0 text-muted-foreground">{formatDateTime(e.occurredAt, ctx.locale, ctx.tenant.timezone)}</span>
                      <span>
                        {e.description} {e.location ? <span className="text-muted-foreground">· {e.location}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {order.paymentMethod === "cod" && isPageEnabled("cod_queue", ctx.activeAddons) && canViewPage(ctx.role, "cod_queue") && <CodCard ctx={ctx} orderId={order.id} orderName={order.name} canWrite={canWritePage(ctx.role, "cod_queue")} />}
      {(returns.length > 0 || canRequestReturn) && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{t("returns")}</CardTitle>
            {canRequestReturn && <Link href={`/t/${tenant}/returns/new?order=${order.id}`} className="text-sm underline-offset-4 hover:underline">{t("request_return")}</Link>}
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {returns.map((r) => (
              <Link key={r.id} href={`/t/${tenant}/returns/${r.id}`} className="flex items-center justify-between rounded border p-2 hover:bg-muted/40">
                <span>
                  R-{r.number} · {r.reasonCode} · {r.resolution}
                </span>
                <StatusBadge status={r.status} namespace="return_status" />
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <NotesPanel slug={tenant} orderId={order.id} currentUserId={ctx.user.id} isAdmin={ctx.role === "owner" || ctx.role === "admin"} canWrite={canDo(ctx.role, "add_note")} people={people} notes={notes.map((n) => ({ id: n.id, authorId: n.authorId, authorName: nameOf(n.authorId) ?? t("system"), body: n.body, createdAt: n.createdAt.toISOString() }))} locale={ctx.locale} timezone={ctx.tenant.timezone} />
        <Timeline currency={order.currency} events={events.map((e) => ({ id: e.id, type: e.type, actorName: e.actorUserId ? nameOf(e.actorUserId) : null, actorType: e.actorType, diff: e.diff as Record<string, { from: unknown; to: unknown }>, metadata: e.metadata as Record<string, unknown>, createdAt: e.createdAt.toISOString() }))} locale={ctx.locale} timezone={ctx.tenant.timezone} />
      </div>
    </DetailShell>
  );
}
