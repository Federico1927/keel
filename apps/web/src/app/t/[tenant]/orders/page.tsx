import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb, eq, schema } from "@hullwise/db";
import { formatDateTime, formatMoney, displayName } from "@hullwise/core";
import { Badge, Card, CardContent, DataList, EmptyState, PageHeader, Pagination, type DataListColumn } from "@hullwise/ui";
import { bulkActionsFor } from "@hullwise/config";
import { requirePage } from "@/server/tenant";
import { listOrders, orderDrillLabel, parseOrderFilters } from "@/server/queries/orders";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { BulkBar } from "@/components/lists/bulk-bar";
import { ListSelection, RowCheckbox, SelectAllCheckbox } from "@/components/lists/selection";
import { StatusBadge } from "@/components/status-badge";
import { OrderFiltersBar } from "./filters";

export default async function OrdersPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "orders");
  const t = await getTranslations("orders");
  const tp = await getTranslations("payment_methods");
  const filters = parseOrderFilters(sp);
  const { rows, total, counts, stockViews, page, pageSize } = await listOrders(ctx, filters);
  const drill = await orderDrillLabel(ctx, filters);
  const bulk = bulkActionsFor(ctx.role, "orders");
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const assignedIds = [...new Set(rows.map((r) => r.assignedTo).filter((x): x is string => Boolean(x)))];
  const assignees = assignedIds.length ? members.filter((m) => assignedIds.includes(m.id)) : [];
  const nameOf = (id: string | null) => (id ? (assignees.some((a) => a.id === id) ? displayName(assignees.find((a) => a.id === id)) : "—") : null);
  const base = `/t/${tenant}/orders`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") u.set(k, Array.isArray(v) ? v.join(",") : v);
    u.set("page", String(p));
    return `${base}?${u.toString()}`;
  };
  type Row = (typeof rows)[number];
  // one definition, a table from md up and a card per order on phones (#49)
  const columns: DataListColumn<Row>[] = [
    ...(bulk.length > 0 ? [{ key: "select", header: <SelectAllCheckbox />, mobile: "select" as const, headClassName: "w-8", cell: (o: Row) => <RowCheckbox id={o.id} label={o.name} /> }] : []),
    {
      key: "order",
      header: t("columns.order"),
      mobile: "title",
      cell: (o) => (
        <>
          <Link href={`${base}/${o.id}`} className="font-medium text-primary hover:underline">{o.name}</Link>
          <p className="text-xs font-normal text-muted-foreground">{formatDateTime(o.placedAt, ctx.locale, ctx.tenant.timezone)}</p>
        </>
      ),
    },
    {
      key: "customer",
      header: t("columns.customer"),
      mobile: "subtitle",
      cell: (o) => (
        <>
          <p className="truncate max-md:text-foreground">{o.customerName ?? "—"}</p>
          <p className="truncate text-xs text-muted-foreground">{o.shippingCountry} · {o.email}</p>
        </>
      ),
    },
    {
      key: "status",
      header: t("columns.status"),
      label: "",
      cell: (o) => (
        <>
          <StatusBadge status={o.status} />
          {o.statusSource === "manual" && <span className="ml-1 text-[10px] text-muted-foreground">{t("manual")}</span>}
          {o.platformTags.length > 0 && (
            <span className="mt-1 block space-x-1 max-md:mt-0 max-md:ml-1 max-md:inline">
              {o.platformTags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
              ))}
            </span>
          )}
        </>
      ),
    },
    {
      key: "payment",
      header: t("columns.payment"),
      label: "",
      cell: (o) => (
        <>
          <span className="text-sm max-md:text-xs md:block">{tp(o.paymentMethod)}</span> <StatusBadge status={o.paymentStatus} namespace="payment_status" className="text-[10px]" />
        </>
      ),
    },
    { key: "channel", header: t("columns.channel"), priority: 2, className: "text-sm text-muted-foreground", cell: (o) => o.sourceChannel },
    { key: "assigned", header: t("columns.assigned"), priority: 2, className: "text-sm text-muted-foreground", cell: (o) => nameOf(o.assignedTo) ?? "—" },
    { key: "total", header: t("columns.total"), mobile: "badge", align: "right", className: "tabular max-md:font-semibold", cell: (o) => formatMoney(o.totalMinor, o.currency, ctx.locale) },
  ];
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<ListToolbar ctx={ctx} list="orders" basePath={base} />} />
      <OrderFiltersBar basePath={base} filters={filters} counts={counts} stockViews={stockViews} members={members.map((m) => ({ id: m.id, name: displayName(m) }))} drill={drill} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <ListSelection ids={rows.map((o) => o.id)}>
        <Card className="mt-4">
          <CardContent className="p-0">
            <DataList columns={columns} rows={rows} rowKey={(o) => o.id} rowProps={() => ({ "data-testid": "order-row" })} />
          </CardContent>
        </Card>
        <BulkBar slug={tenant} list="orders" actions={bulk} members={members.map((m) => ({ id: m.id, name: m.name ?? m.email }))} />
        </ListSelection>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from, to, total })} />
    </>
  );
}
