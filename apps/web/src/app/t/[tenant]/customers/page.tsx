import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CHURN_RISKS, formatDate, formatMoney, formatNumber } from "@keel/core";
import { listCustomers, parseCustomerFilters } from "@keel/services";
import { Card, CardContent, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.customer")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.country")}</TableHead>
                  <TableHead className="text-right">{t("columns.orders")}</TableHead>
                  <TableHead className="text-right">{t("columns.total_spent")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.aov")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.last_order")}</TableHead>
                  <TableHead>{t("columns.tier")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.churn")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.marketing")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.customerId} data-testid="customer-row">
                    <TableCell>
                      <Link href={`${base}/${r.customerId}`} className="font-medium hover:underline">{[r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || "—"}</Link>
                      <div className="truncate text-xs text-muted-foreground">{r.email}</div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{r.country ?? "—"}{r.city ? ` · ${r.city}` : ""}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.ordersCount, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{money(r.totalSpentMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{r.aovMinor === null ? "—" : money(r.aovMinor)}</TableCell>
                    <TableCell className="hidden md:table-cell">{r.lastOrderAt ? formatDate(r.lastOrderAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                    <TableCell><TierBadge tier={r.tier} /></TableCell>
                    <TableCell className="hidden md:table-cell"><ChurnBadge risk={r.churnRisk} /></TableCell>
                    <TableCell className="hidden lg:table-cell">{r.acceptsMarketing ? t("yes") : t("no")}</TableCell>
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
