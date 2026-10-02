import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PLATFORM_CURRENCY } from "@hullwise/config";
import { formatDate, formatMoney } from "@hullwise/core";
import { adminInvoiceList } from "@hullwise/services";
import { asc, schema } from "@hullwise/db";
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader, Pagination, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { BillingRunButton } from "./controls";
import { InvoiceActions } from "../tenants/[id]/controls";
import { SortHead, flatParams, queryHref } from "../_components/table-query";

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const now = new Date();
  const [list, tenants] = await Promise.all([adminInvoiceList(db, query, { now }), db.select({ id: schema.tenants.id, name: schema.tenants.name }).from(schema.tenants).orderBy(asc(schema.tenants.name))]);
  const f = list.filters;
  const base = "/admin/billing";
  const sortProps = { sort: f.sort, dir: f.dir, base, query };
  const filtered = Boolean(f.q || f.kind || f.tenantId || f.overdue);
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("billing.title")} description={t("billing.description")} actions={<><Button variant="outline" asChild><a href={queryHref(`${base}/export`, query, { page: undefined })} data-testid="export-invoices">{t("export_csv")}</a></Button><BillingRunButton /></>} />
      <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
        {["all", "open", "paid", "void"].map((s) => (
          <Link key={s} href={queryHref(base, query, { status: s === "all" ? undefined : s, page: undefined })} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", (f.status ?? "all") === s ? "bg-card shadow-sm" : "text-muted-foreground")}>{s === "all" ? t("billing.all") : t(`billing.status.${s}`)}</Link>
        ))}
      </div>
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]" method="get" action={base}>
        {f.status && <input type="hidden" name="status" value={f.status} />}
        <input type="hidden" name="sort" value={f.sort} />
        <input type="hidden" name="dir" value={f.dir} />
        <div className="space-y-1.5">
          <Label htmlFor="b-q">{t("filters.search")}</Label>
          <Input id="b-q" name="q" defaultValue={f.q ?? ""} placeholder={t("billing.search_placeholder")} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="b-kind">{t("billing.columns.kind")}</Label>
          <Select id="b-kind" name="kind" defaultValue={f.kind ?? ""}>
            <option value="">{t("filters.all")}</option>
            {(["setup", "subscription", "adjustment"] as const).map((k) => <option key={k} value={k}>{t(`billing.kind.${k}`)}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="b-tenant">{t("tenants.columns.tenant")}</Label>
          <Select id="b-tenant" name="tenant" defaultValue={f.tenantId ?? ""}>
            <option value="">{t("filters.all")}</option>
            {tenants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="b-overdue">{t("billing.due_filter")}</Label>
          <Select id="b-overdue" name="overdue" defaultValue={f.overdue ? "1" : ""}>
            <option value="">{t("filters.all")}</option>
            <option value="1">{t("billing.overdue_only")}</option>
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          {filtered && <Button variant="outline" asChild><Link href={queryHref(base, { status: f.status })}>{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      <Card>
        <CardContent className="p-0">
          {list.rows.length === 0 ? (
            <EmptyState title={t("billing.empty")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead label={t("billing.columns.number")} column="number" {...sortProps} />
                  <SortHead label={t("tenants.columns.tenant")} column="tenant" {...sortProps} />
                  <TableHead className="hidden md:table-cell">{t("billing.columns.kind")}</TableHead>
                  <SortHead label={t("billing.columns.amount")} column="amount" {...sortProps} defaultDir="desc" className="text-right" />
                  <SortHead label={t("billing.columns.issued")} column="issued" {...sortProps} defaultDir="desc" className="hidden md:table-cell" />
                  <SortHead label={t("billing.columns.due")} column="due" {...sortProps} defaultDir="desc" />
                  <TableHead>{t("billing.columns.status")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map(({ invoice: i, tenantName, tenantSlug }) => (
                  <TableRow key={i.id} data-testid="invoice-row">
                    <TableCell className="font-mono text-xs">{i.number}</TableCell>
                    <TableCell><Link href={`/admin/tenants/${i.tenantId}`} className="hover:underline">{tenantName}</Link><div className="text-xs text-muted-foreground">{tenantSlug}</div></TableCell>
                    <TableCell className="hidden md:table-cell">{t(`billing.kind.${i.kind}`)}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(i.amountMinor, i.currency, locale)}</TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(i.issuedAt, locale, "UTC")}</TableCell>
                    <TableCell>{formatDate(i.dueAt, locale, "UTC")}</TableCell>
                    <TableCell><Badge variant={i.status === "paid" ? "success" : i.status === "open" ? (i.dueAt < now ? "destructive" : "warning") : "muted"}>{t(`billing.status.${i.status}`)}</Badge></TableCell>
                    <TableCell><InvoiceActions invoiceId={i.id} status={i.status} provider={i.provider} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => queryHref(base, query, { page: String(p) })} summary={t("billing.summary", { from: list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1, to: Math.min(list.page * list.pageSize, list.total), total: list.total, amount: formatMoney(list.amountMinor, PLATFORM_CURRENCY, locale) })} />
    </>
  );
}
