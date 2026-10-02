import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CHURN_RISKS, formatDate, formatMoney, formatNumber } from "@hullwise/core";
import { listCustomers, parseCustomerFilters } from "@hullwise/services";
import { Card, CardContent, DataList, EmptyState, PageHeader, Pagination } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CustomerTabs } from "./customer-tabs";
import { CustomerFiltersBar } from "./filters";
import { TierBadge } from "./tier-badge";
import { ChurnBadge } from "./churn-badge";
import { ListToolbar } from "@/components/lists/list-toolbar";

export default async function CustomersPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "customers");
  const t = await getTranslations("customers");
  const filters = { q: sp.q?.trim() || undefined, country: sp.country || undefined, tier: sp.tier || undefined, sort: sp.sort || undefined, marketing: sp.marketing || undefined, segment: sp.segment || undefined, churn: (CHURN_RISKS as readonly string[]).includes(sp.churn ?? "") ? sp.churn : undefined };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const { rows, total, pageSize, countries } = await ctx.run((tx) =>
    listCustomers({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { ...parseCustomerFilters(sp), page }),
  );
  const base = `/t/${tenant}/customers`;
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) u.set(k, v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<ListToolbar ctx={ctx} list="customers" basePath={base} />} />
      <CustomerTabs tenant={tenant} active="list" />
      <CustomerFiltersBar basePath={base} filters={filters} countries={countries} />
      {rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <DataList
              rows={rows}
              rowKey={(r) => r.customerId}
              rowProps={() => ({ "data-testid": "customer-row" })}
              columns={[
                { key: "customer", header: t("columns.customer"), mobile: "title", cell: (r) => <><Link href={`${base}/${r.customerId}`} className="font-medium hover:underline">{[r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || "—"}</Link><div className="truncate text-xs font-normal text-muted-foreground">{r.email}</div></> },
                { key: "tier", header: t("columns.tier"), mobile: "badge", cell: (r) => <TierBadge tier={r.tier} /> },
                { key: "country", header: t("columns.country"), cell: (r) => <>{r.country ?? "—"}{r.city ? ` · ${r.city}` : ""}</> },
                { key: "orders", header: t("columns.orders"), align: "right", className: "tabular", cell: (r) => formatNumber(r.ordersCount, ctx.locale) },
                { key: "total", header: t("columns.total_spent"), align: "right", className: "tabular", cell: (r) => money(r.totalSpentMinor) },
                { key: "aov", header: t("columns.aov"), align: "right", priority: 2, className: "tabular", cell: (r) => (r.aovMinor === null ? "—" : money(r.aovMinor)) },
                { key: "last", header: t("columns.last_order"), cell: (r) => (r.lastOrderAt ? formatDate(r.lastOrderAt, ctx.locale, ctx.tenant.timezone) : "—") },
                { key: "churn", header: t("columns.churn"), label: "", cell: (r) => <ChurnBadge risk={r.churnRisk} /> },
                { key: "marketing", header: t("columns.marketing"), priority: 2, cell: (r) => (r.acceptsMarketing ? t("yes") : t("no")) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={page} pageSize={pageSize} total={total} hrefFor={hrefFor} summary={t("pagination", { from: total === 0 ? 0 : (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total })} />
    </>
  );
}
