import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { OPEN_STATUSES, formatDate, formatNumber, isBackorderOpen } from "@hullwise/core";
import { orderBackorders, orderLineStock } from "@hullwise/services";
import { canDo, canViewPage } from "@hullwise/config";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList } from "@hullwise/ui";
import type { Transaction } from "@hullwise/db";
import type { TenantContext } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { CancelWaitButton } from "./cancel-wait";

interface LineInfo {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  currentQuantity: number;
}

const svc = (ctx: TenantContext, tx: Transaction) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });

/** What the order waits for: per line the units, the purchase order, its supplier and ETA; "cancel wait" releases it. */
export async function BackorderCard({ ctx, orderId, lines }: { ctx: TenantContext; orderId: string; lines: LineInfo[] }) {
  const rows = await ctx.run((tx) => orderBackorders(svc(ctx, tx), orderId));
  if (!rows.length) return null;
  const t = await getTranslations("order_detail.backorders");
  const open = rows.filter((b) => isBackorderOpen(b.status));
  const closed = rows.filter((b) => !isBackorderOpen(b.status));
  const linkPo = canViewPage(ctx.role, "purchasing");
  const label = (lineId: string) => {
    const l = lines.find((x) => x.id === lineId);
    return l ? `${l.title}${l.variantTitle ? ` · ${l.variantTitle}` : ""}` : "—";
  };
  const date = (d: Date | null) => (d ? formatDate(d, ctx.locale, ctx.tenant.timezone) : t("no_eta"));
  return (
    <Card data-testid="backorder-card" className={open.length ? "border-warning/60" : undefined}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{open.length ? t("title_open") : t("title_closed")}</CardTitle>
          <CardDescription>{open.length ? t("description_open", { units: open.reduce((s, b) => s + b.quantity, 0) }) : t("description_closed")}</CardDescription>
        </div>
        {open.length > 0 && canDo(ctx.role, "change_order_state") && <CancelWaitButton slug={ctx.tenant.slug} orderId={orderId} />}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {open.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2" data-testid="backorder-row">
            <div className="min-w-0">
              <p className="truncate font-medium">{label(b.orderLineId)}</p>
              {b.po ? (
                <p className="text-xs text-muted-foreground">
                  {linkPo ? <Link href={`/t/${ctx.tenant.slug}/purchasing/${b.po.id}`} className="font-medium text-primary hover:underline" data-testid="backorder-po">{b.po.number}</Link> : <span data-testid="backorder-po">{b.po.number}</span>}
                  {" · "}{b.po.supplierName}{" · "}<span data-testid="backorder-eta">{t("eta", { date: date(b.po.expectedAt) })}</span>
                </p>
              ) : (
                <p className="text-xs text-warning">{t("no_po")}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {b.po && <StatusBadge status={b.po.status} namespace="po_status" className="text-[10px]" />}
              <Badge variant="warning" className="tabular">{t("units", { n: b.quantity })}</Badge>
            </div>
          </div>
        ))}
        {closed.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {closed.slice(0, 5).map((b) => (
              <li key={b.id} className="flex justify-between gap-2">
                <span className="truncate">{label(b.orderLineId)} · {t("units", { n: b.quantity })}</span>
                <span>{t(`closed_status.${b.status}`)}{b.resolvedAt ? ` · ${formatDate(b.resolvedAt, ctx.locale, ctx.tenant.timezone)}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Stock check per order line: available and committed over every location, incoming purchase orders (status, ETA), units waiting. */
export async function StockCheckCard({ ctx, orderId, status, lines }: { ctx: TenantContext; orderId: string; status: string; lines: LineInfo[] }) {
  if (!(OPEN_STATUSES as readonly string[]).includes(status)) return null;
  const stock = await ctx.run((tx) => orderLineStock(svc(ctx, tx), orderId));
  if (!stock.length) return null;
  const t = await getTranslations("order_detail.stock_check");
  const linkPo = canViewPage(ctx.role, "purchasing");
  const lineOf = (id: string) => lines.find((x) => x.id === id);
  const n = (v: number) => formatNumber(v, ctx.locale);
  return (
    <Card data-testid="stock-check-card">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <DataList
          rows={stock}
          rowKey={(s) => s.lineId}
          rowProps={() => ({ "data-testid": "stock-check-row" })}
          columns={[
            { key: "line", header: t("line"), mobile: "title", cell: (s) => { const l = lineOf(s.lineId); return <><p className="font-medium">{l?.title ?? "—"}</p><p className="text-xs font-normal text-muted-foreground">{l?.variantTitle} {l?.sku ? `· ${l.sku}` : ""}</p>{s.backordered > 0 && <Badge variant="warning" className="mt-1 text-[10px]">{t("waiting", { n: s.backordered })}</Badge>}</>; } },
            { key: "ordered", header: t("ordered"), align: "right", className: "tabular", cell: (s) => n(lineOf(s.lineId)?.currentQuantity ?? 0) },
            { key: "available", header: t("available"), align: "right", cell: (s) => <span className={`tabular font-medium ${s.available < (lineOf(s.lineId)?.currentQuantity ?? 0) ? "text-destructive" : ""}`} data-testid="stock-check-available">{n(s.available)}</span> },
            { key: "committed", header: t("committed"), align: "right", className: "tabular text-muted-foreground", cell: (s) => n(s.committed) },
            {
              key: "incoming",
              header: t("incoming"),
              mobile: "action",
              className: "text-xs",
              cell: (s) => s.pos.length === 0 ? <span className="text-muted-foreground">—</span> : (
                <ul className="space-y-0.5">
                  {s.pos.slice(0, 3).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-1">
                      <span className="tabular">+{n(p.remaining)}</span>
                      {linkPo ? <Link href={`/t/${ctx.tenant.slug}/purchasing/${p.id}`} className="text-primary hover:underline">{p.number}</Link> : <span>{p.number}</span>}
                      <StatusBadge status={p.status} namespace="po_status" className="text-[10px]" />
                      <span className="text-muted-foreground">{p.expectedAt ? formatDate(p.expectedAt, ctx.locale, ctx.tenant.timezone) : t("no_eta")}</span>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}
