import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@keel/config";
import { PO_TRANSITIONS, formatDate, formatDateTime, formatMoney } from "@keel/core";
import { Badge, Card, CardContent, CardHeader, CardTitle, DetailShell, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { getPurchaseOrder } from "@/server/queries/purchasing";
import { StatusBadge } from "@/components/status-badge";
import { PoActions, ReceiveForm } from "./actions";
import { LandedCostCard, SupplierCard } from "./planning-cards";
import { RecordTasks } from "@/components/record-tasks";
import { RecordNotes } from "@/components/record-notes";

export default async function PurchaseOrderPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "purchasing");
  const detail = await getPurchaseOrder(ctx, id);
  if (!detail) notFound();
  const { po, supplier, lines, backorders, payments, locations, charges } = detail;
  const t = await getTranslations("po_detail");
  const fmt = (m: number) => formatMoney(m, po.currency, ctx.locale);
  const canWrite = canDo(ctx.role, "receive_purchase_order");
  const receivable = ["confirmed", "in_transit", "partially_received"].includes(po.status);
  const paid = payments.reduce((s, p) => s + p.amountMinor, 0);
  const chargesTotal = charges.reduce((s, c) => s + c.amountMinor, 0);
  const hasLanded = lines.some((l) => l.landedUnitCostMinor !== null);
  const dt = (d: Date | null) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : null);
  return (
    <DetailShell
      back={
        <Link href={`/t/${tenant}/purchasing`} className="inline-flex items-center gap-1 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t("back")}
        </Link>
      }
      eyebrow={supplier.name}
      title={po.number}
      chips={
        <>
          <StatusBadge status={po.status} namespace="po_status" />
          {po.expectedAt && <Badge variant="outline">{t("expected", { date: formatDate(po.expectedAt, ctx.locale, ctx.tenant.timezone) })}</Badge>}
          {po.source === "auto" && <Badge variant="outline">{t("auto_draft")}</Badge>}
          {backorders.length > 0 && <Badge variant="info">{t("covers_orders", { n: new Set(backorders.map((b) => b.orderId)).size })}</Badge>}
        </>
      }
      actions={canWrite ? <PoActions slug={tenant} poId={po.id} status={po.status} transitions={PO_TRANSITIONS[po.status] ?? []} supplierId={supplier.id} balanceMinor={po.totalMinor - paid} /> : undefined}
      aside={
        <>
          <RecordTasks slug={tenant} type="purchase_order" id={po.id} label={po.number} />
          <RecordNotes slug={tenant} type="purchase_order" id={po.id} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("summary")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("total")}</span><span className="tabular">{fmt(po.totalMinor)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("paid")}</span><span className="tabular">{fmt(paid)}</span></div>
              <div className="flex justify-between font-medium"><span>{t("balance")}</span><span className="tabular">{fmt(po.totalMinor - paid)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("ordered")}</span><span>{formatDate(po.orderedAt, ctx.locale, ctx.tenant.timezone)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("received")}</span><span>{formatDate(po.receivedAt, ctx.locale, ctx.tenant.timezone)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("destination")}</span><span>{locations.find((l) => l.id === po.destinationLocationId)?.name ?? "—"}</span></div>
              {po.notes && <p className="pt-2 text-muted-foreground">{po.notes}</p>}
            </CardContent>
          </Card>
          <SupplierCard slug={tenant} poId={po.id} status={po.status} defaultEmail={po.sentToEmail ?? supplier.email} sentTo={po.sentToEmail} sentAt={dt(po.sentAt)} ackAt={dt(po.supplierAckAt)} ackNote={po.supplierAckNote} pdfHref={`/t/${tenant}/purchasing/${po.id}/pdf`} canWrite={canWrite} />
          <LandedCostCard slug={tenant} poId={po.id} canWrite={canWrite && po.status !== "received" && po.status !== "cancelled"} total={fmt(chargesTotal)} charges={charges.map((c) => ({ id: c.id, kind: c.kind, basis: c.basis, amount: fmt(c.amountMinor), note: c.note }))} />
          {backorders.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("waiting_orders")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {backorders.map((b, i) => (
                  <Link key={`${b.orderId}-${i}`} href={`/t/${tenant}/orders/${b.orderId}`} className="flex justify-between hover:underline">
                    <span>{b.orderName}</span>
                    <span className="text-muted-foreground">×{b.quantity} · {b.status}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {payments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("payments")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {payments.map((p) => (
                  <div key={p.id} className="flex justify-between">
                    <span className="text-muted-foreground">{formatDate(p.paidAt, ctx.locale, ctx.tenant.timezone)} · {p.method}</span>
                    <span className="tabular">{fmt(p.amountMinor)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("lines")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {canWrite && receivable ? (
            <ReceiveForm slug={tenant} poId={po.id} locations={locations.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault }))} defaultLocationId={po.destinationLocationId} lines={lines.map((l) => ({ id: l.id, label: `${l.productTitle ?? l.description ?? ""} · ${l.variantTitle ?? ""}`, sku: l.sku, quantity: l.quantity, receivedQuantity: l.receivedQuantity, unitCost: l.landedUnitCostMinor !== null ? `${fmt(l.unitCostMinor)} → ${fmt(l.landedUnitCostMinor)}` : fmt(l.unitCostMinor) }))} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("line.item")}</TableHead>
                  <TableHead className="text-right">{t("line.ordered")}</TableHead>
                  <TableHead className="text-right">{t("line.received")}</TableHead>
                  <TableHead className="text-right">{t("line.unit_cost")}</TableHead>
                  {hasLanded && <TableHead className="text-right">{t("line.landed")}</TableHead>}
                  <TableHead className="text-right">{t("line.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.productId ? <Link href={`/t/${tenant}/products/${l.productId}`} className="font-medium hover:underline">{l.productTitle}</Link> : <span className="font-medium">{l.description}</span>}
                      <p className="text-xs text-muted-foreground">{l.variantTitle} {l.sku ? `· ${l.sku}` : ""}</p>
                    </TableCell>
                    <TableCell className="text-right tabular">{l.quantity}</TableCell>
                    <TableCell className="text-right tabular">{l.receivedQuantity}</TableCell>
                    <TableCell className="text-right tabular">{fmt(l.unitCostMinor)}</TableCell>
                    {hasLanded && <TableCell className="text-right tabular">{l.landedUnitCostMinor !== null ? fmt(l.landedUnitCostMinor) : "—"}</TableCell>}
                    <TableCell className="text-right tabular">{fmt(l.unitCostMinor * l.quantity)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">{t("audit_hint", { at: formatDateTime(po.updatedAt, ctx.locale, ctx.tenant.timezone) })}</p>
    </DetailShell>
  );
}
