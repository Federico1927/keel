import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb, eq, schema } from "@keel/db";
import { formatDateTime, formatMoney } from "@keel/core";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { bulkActionsFor } from "@keel/config";
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
  const { rows, total, counts, page, pageSize } = await listOrders(ctx, filters);
  const drill = await orderDrillLabel(ctx, filters);
  const bulk = bulkActionsFor(ctx.role, "orders");
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const assignedIds = [...new Set(rows.map((r) => r.assignedTo).filter((x): x is string => Boolean(x)))];
  const assignees = assignedIds.length ? members.filter((m) => assignedIds.includes(m.id)) : [];
  const nameOf = (id: string | null) => (id ? (assignees.find((a) => a.id === id)?.name ?? "—") : null);
  const base = `/t/${tenant}/orders`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") u.set(k, Array.isArray(v) ? v.join(",") : v);
    u.set("page", String(p));
    return `${base}?${u.toString()}`;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<ListToolbar ctx={ctx} list="orders" basePath={base} />} />
      <OrderFiltersBar basePath={base} filters={filters} counts={counts} members={members.map((m) => ({ id: m.id, name: m.name ?? m.email }))} drill={drill} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <ListSelection ids={rows.map((o) => o.id)}>
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {bulk.length > 0 && <TableHead className="w-8"><SelectAllCheckbox /></TableHead>}
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead>{t("columns.customer")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.payment")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.channel")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.assigned")}</TableHead>
                  <TableHead className="text-right">{t("columns.total")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id}>
                    {bulk.length > 0 && <TableCell><RowCheckbox id={o.id} label={o.name} /></TableCell>}
                    <TableCell>
                      <Link href={`${base}/${o.id}`} className="font-medium text-primary hover:underline">
                        {o.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{formatDateTime(o.placedAt, ctx.locale, ctx.tenant.timezone)}</p>
                    </TableCell>
                    <TableCell>
                      <p className="truncate">{o.customerName ?? "—"}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {o.shippingCountry} · {o.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                      {o.statusSource === "manual" && <span className="ml-1 text-[10px] text-muted-foreground">{t("manual")}</span>}
                      {o.platformTags.length > 0 && (
                        <span className="mt-1 block space-x-1">
                          {o.platformTags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-[10px]">
                              {tag}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <p className="text-sm">{tp(o.paymentMethod)}</p>
                      <StatusBadge status={o.paymentStatus} namespace="payment_status" className="text-[10px]" />
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{o.sourceChannel}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{nameOf(o.assignedTo) ?? "—"}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(o.totalMinor, o.currency, ctx.locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <BulkBar slug={tenant} list="orders" actions={bulk} members={members.map((m) => ({ id: m.id, name: m.name ?? m.email }))} />
        </ListSelection>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from, to, total })} />
    </>
  );
}
