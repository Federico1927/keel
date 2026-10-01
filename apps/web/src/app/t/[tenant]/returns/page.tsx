import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { formatDate, formatMoney, formatNumber } from "@keel/core";
import { listReturnReasons, listReturns } from "@keel/services";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { StatusBadge } from "@/components/status-badge";
import { ReturnFiltersBar } from "./filters";

export default async function ReturnsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "returns");
  const t = await getTranslations("returns");
  const filters = { q: sp.q?.trim() || undefined, status: sp.status || undefined, reason: sp.reason || undefined };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const { rows, total, pageSize, counts, reasons } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const list = await listReturns(s, { ...filters, page });
    const reasons = await listReturnReasons(s);
    return { ...list, reasons };
  });
  const base = `/t/${tenant}/returns`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) u.set(k, v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  const canWrite = canWritePage(ctx.role, "returns");
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap gap-2 text-sm">
            <Link href={`${base}/analytics`} className="rounded-md border px-3 py-1.5 hover:bg-muted">{t("analytics")}</Link>
            {canWrite && <Link href={`${base}/reasons`} className="rounded-md border px-3 py-1.5 hover:bg-muted">{t("reasons")}</Link>}
          </div>
        }
      />
      <ReturnFiltersBar basePath={base} filters={filters} counts={counts} reasons={reasons.map((r) => ({ code: r.code, label: r.label }))} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.return")}</TableHead>
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.reason")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.resolution")}</TableHead>
                  <TableHead className="text-right">{t("columns.amount")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.requested")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="return-row">
                    <TableCell>
                      <Link href={`${base}/${r.id}`} className="font-medium hover:underline">R-{r.number}</Link>
                      {r.outOfWindow && <Badge variant="warning" className="ml-2">{t("out_of_window")}</Badge>}
                      <div className="text-xs text-muted-foreground">{t("items_n", { n: formatNumber(r.items, ctx.locale) })}</div>
                    </TableCell>
                    <TableCell>
                      <Link href={`/t/${tenant}/orders/${r.orderId}`} className="hover:underline">{r.orderName}</Link>
                      <div className="truncate text-xs text-muted-foreground">{r.customerName}</div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{reasons.find((x) => x.code === r.reasonCode)?.label ?? r.reasonCode}</TableCell>
                    <TableCell className="hidden lg:table-cell">{t(`resolution.${r.resolution}`)}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(r.refundedAmountMinor ?? r.proposedAmountMinor, r.currency, ctx.locale)}</TableCell>
                    <TableCell><StatusBadge status={r.status} namespace="return_status" /></TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(r.requestedAt, ctx.locale, ctx.tenant.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}
