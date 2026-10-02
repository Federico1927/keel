import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PAYOUT_STATUSES, formatDate, formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { listPayouts } from "@keel/services";
import { canDo } from "@keel/config";
import { Badge, Card, CardContent, EmptyState, PageHeader, Pagination, Select, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Button, Input, cn } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { SyncPayoutsButton } from "./sync-button";
import { PAYOUT_STATUS_VARIANT as STATUS_VARIANT } from "./status";


/** Payouts of the payment processor: each deposit with its gross, refunds, adjustments, fees and net. */
export default async function PayoutsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("payouts");
  const status = (PAYOUT_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined;
  const dateOk = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const filters = { status, from: dateOk(sp.from), to: dateOk(sp.to), page: Math.max(1, Number(sp.page ?? 1) || 1) };
  const data = await ctx.run((tx) => listPayouts({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, filters));
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const base = `/t/${tenant}/analytics/payouts`;
  const hrefFor = (page: number) => `${base}?${new URLSearchParams(Object.entries({ ...filters, page: String(page) }).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""))}`;
  const filtered = Boolean(filters.status || filters.from || filters.to);
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics?tab=pnl`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={canDo(ctx.role, "manage_integrations") ? <SyncPayoutsButton slug={tenant} /> : undefined} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("totals.gross")} value={money(data.totals.grossMinor)} />
        <Stat label={t("totals.refunds")} value={money(data.totals.refundsMinor)} />
        <Stat label={t("totals.adjustments")} value={money(data.totals.adjustmentsMinor)} />
        <Stat label={t("totals.fees")} value={money(data.totals.feeMinor)} />
        <Stat label={t("totals.net")} value={money(data.totals.netMinor)} hint={t("totals.count", { n: data.total })} />
      </div>
      <form method="get" className="mb-4 grid gap-2 sm:grid-cols-4" data-testid="payout-filters">
        <Select name="status" defaultValue={filters.status ?? ""} aria-label={t("filters.status")}>
          <option value="">{t("filters.all_statuses")}</option>
          {PAYOUT_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </Select>
        <Input type="date" name="from" defaultValue={filters.from ?? ""} aria-label={t("filters.from")} />
        <Input type="date" name="to" defaultValue={filters.to ?? ""} aria-label={t("filters.to")} />
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" size="sm">{t("filters.apply")}</Button>
          {filtered && <Button asChild variant="ghost" size="sm"><Link href={base}>{t("filters.clear")}</Link></Button>}
        </div>
      </form>
      {data.rows.length === 0 ? (
        <EmptyState title={filtered ? t("empty_filtered") : t("empty")} description={filtered ? undefined : t("empty_hint")} />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table data-testid="payouts-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.date")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("columns.transactions")}</TableHead>
                  <TableHead className="text-right">{t("columns.gross")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.refunds")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.adjustments")}</TableHead>
                  <TableHead className="text-right">{t("columns.fees")}</TableHead>
                  <TableHead className="text-right">{t("columns.net")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((p) => (
                  <TableRow key={p.id} data-testid="payout-row">
                    <TableCell><Link href={`${base}/${p.id}`} className="font-medium text-primary hover:underline">{formatDate(p.issuedAt, ctx.locale, ctx.tenant.timezone)}</Link></TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[p.status] ?? "muted"}>{t(`status.${p.status}`)}</Badge></TableCell>
                    <TableCell className="hidden text-right tabular sm:table-cell">{formatNumber(p.transactionCount, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{money(p.grossMinor)}</TableCell>
                    <TableCell className={cn("hidden text-right tabular md:table-cell", p.refundsMinor < 0 && "text-destructive")}>{money(p.refundsMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{money(p.adjustmentsMinor)}</TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">{money(-p.feeMinor)}</TableCell>
                    <TableCell className="text-right font-medium tabular">{money(p.netMinor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={hrefFor} summary={t("summary", { n: data.total })} />
      {data.lastRun && <p className="mt-2 text-xs text-muted-foreground" data-testid="payouts-last-sync">{data.lastRun.status === "error" ? t("last_sync_error", { error: data.lastRun.error ?? "" }) : t("last_sync", { at: formatDateTime(data.lastRun.finishedAt ?? data.lastRun.startedAt, ctx.locale, ctx.tenant.timezone) })}</p>}
    </>
  );
}
