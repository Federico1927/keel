import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PLATFORM_CURRENCY } from "@hullwise/config";
import { formatDate, formatMoney } from "@hullwise/core";
import { adminInvoiceList } from "@hullwise/services";
import { asc, schema } from "@hullwise/db";
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader, Pagination, Select, DataList, cn } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { BillingRunButton } from "./controls";
import { InvoiceActions } from "../tenants/[id]/controls";
import { flatParams, queryHref, sortColumn, type SortOption } from "../_components/table-query";
import { ADMIN_FILTER_FORM, AdminFilters, type AdminFilterChip } from "../_components/admin-filters";

import { withIntl } from "@/i18n/intl-scope";
const KINDS = ["setup", "subscription", "adjustment"] as const;

async function AdminBillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const sorts: SortOption[] = [
    { label: t("billing.columns.number"), column: "number" },
    { label: t("tenants.columns.tenant"), column: "tenant" },
    { label: t("billing.columns.amount"), column: "amount", defaultDir: "desc" },
    { label: t("billing.columns.issued"), column: "issued", defaultDir: "desc" },
    { label: t("billing.columns.due"), column: "due", defaultDir: "desc" },
  ];
  const drop = (k: string) => queryHref(base, query, { [k]: undefined, page: undefined });
  const chips: AdminFilterChip[] = [
    ...(f.q ? [{ key: "q", label: `“${f.q}”`, href: drop("q") }] : []),
    ...(f.kind ? [{ key: "kind", label: t(`billing.kind.${f.kind}`), href: drop("kind") }] : []),
    ...(f.tenantId ? [{ key: "tenant", label: tenants.find((x) => x.id === f.tenantId)?.name ?? t("tenants.columns.tenant"), href: drop("tenant") }] : []),
    ...(f.overdue ? [{ key: "overdue", label: t("billing.overdue_only"), href: drop("overdue") }] : []),
  ];
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("billing.title")} description={t("billing.description")} actions={<><Button variant="outline" asChild><a href={queryHref(`${base}/export`, query, { page: undefined })} data-testid="export-invoices">{t("export_csv")}</a></Button><BillingRunButton /></>} />
      <div className="mb-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
        {["all", "open", "paid", "void"].map((s) => (
          <Link key={s} href={queryHref(base, query, { status: s === "all" ? undefined : s, page: undefined })} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", (f.status ?? "all") === s ? "bg-card shadow-sm" : "text-muted-foreground")}>{s === "all" ? t("billing.all") : t(`billing.status.${s}`)}</Link>
        ))}
      </div>
      <AdminFilters chips={chips} sorts={{ props: sortProps, options: sorts, defaultSort: "issued" }}>
        <form id={ADMIN_FILTER_FORM} className="grid gap-3 rounded-lg border bg-card p-3 max-md:border-0 max-md:p-0 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]" method="get" action={base}>
          {f.status && <input type="hidden" name="status" value={f.status} />}
          <input type="hidden" name="sort" value={f.sort} />
          <input type="hidden" name="dir" value={f.dir} />
          <div className="space-y-1.5">
            <Label htmlFor="b-q">{t("filters.search")}</Label>
            <Input id="b-q" name="q" type="search" defaultValue={f.q ?? ""} placeholder={t("billing.search_placeholder")} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="b-kind">{t("billing.columns.kind")}</Label>
            <Select id="b-kind" name="kind" defaultValue={f.kind ?? ""}>
              <option value="">{t("filters.all")}</option>
              {KINDS.map((k) => <option key={k} value={k}>{t(`billing.kind.${k}`)}</option>)}
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
            <Button type="submit" className="max-md:hidden">{t("filters.apply")}</Button>
            {filtered && <Button variant="outline" asChild><Link href={queryHref(base, { status: f.status })}>{t("filters.reset")}</Link></Button>}
          </div>
        </form>
      </AdminFilters>
      <Card>
        <CardContent className="p-0">
          {list.rows.length === 0 ? (
            <EmptyState title={t("billing.empty")} />
          ) : (
            <DataList
              rows={list.rows}
              rowKey={(r) => r.invoice.id}
              rowProps={() => ({ "data-testid": "invoice-row" })}
              columns={[
                { key: "number", ...sortColumn(sortProps, sorts[0]!), mobile: "subtitle", className: "font-mono text-xs", cell: ({ invoice: i }) => i.number },
                { key: "tenant", ...sortColumn(sortProps, sorts[1]!), mobile: "title", cell: ({ invoice: i, tenantName, tenantSlug }) => <><Link href={`/admin/tenants/${i.tenantId}`} className="hover:underline">{tenantName}</Link><div className="text-xs font-normal text-muted-foreground">{tenantSlug}</div></> },
                { key: "kind", header: t("billing.columns.kind"), priority: 2, cell: ({ invoice: i }) => t(`billing.kind.${i.kind}`) },
                { key: "amount", ...sortColumn(sortProps, sorts[2]!), align: "right", className: "tabular", cell: ({ invoice: i }) => formatMoney(i.amountMinor, i.currency, locale) },
                { key: "issued", ...sortColumn(sortProps, sorts[3]!), priority: 2, cell: ({ invoice: i }) => formatDate(i.issuedAt, locale, "UTC") },
                { key: "due", ...sortColumn(sortProps, sorts[4]!), cell: ({ invoice: i }) => formatDate(i.dueAt, locale, "UTC") },
                { key: "status", header: t("billing.columns.status"), mobile: "badge", cell: ({ invoice: i }) => <Badge variant={i.status === "paid" ? "success" : i.status === "open" ? (i.dueAt < now ? "destructive" : "warning") : "muted"}>{t(`billing.status.${i.status}`)}</Badge> },
                { key: "actions", header: <span className="sr-only">{t("billing.columns.status")}</span>, mobile: "action", cell: ({ invoice: i }) => <InvoiceActions invoiceId={i.id} status={i.status} provider={i.provider} /> },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Pagination className="mt-4" page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => queryHref(base, query, { page: String(p) })} summary={t("billing.summary", { from: list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1, to: Math.min(list.page * list.pageSize, list.total), total: list.total, amount: formatMoney(list.amountMinor, PLATFORM_CURRENCY, locale) })} />
    </>
  );
}

export default withIntl(AdminBillingPage, "app/admin/billing/page.tsx");
