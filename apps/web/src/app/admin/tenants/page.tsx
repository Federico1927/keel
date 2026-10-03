import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ADDON_MODULES, MODULES, PLAN_KEYS, PLATFORM_CURRENCY, TENANT_STATUSES, canActivateAddon } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { adminTenantList } from "@hullwise/services";
import { Badge, Button, Card, CardContent, DataList, EmptyState, Input, Label, PageHeader, Select } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { OpenAsSupportButton } from "./[id]/controls";
import { HealthBadge, LifecycleBadge, PaymentBadge } from "../_components/badges";
import { flatParams, queryHref, sortColumn, type SortOption } from "../_components/table-query";
import { ADMIN_FILTER_FORM, AdminFilters, type AdminFilterChip } from "../_components/admin-filters";

import { withIntl } from "@/i18n/intl-scope";
async function AdminTenantsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await requireSuperAdmin();
  const query = flatParams(await searchParams);
  const t = await getTranslations("admin");
  const tm = await getTranslations("modules");
  const locale = await getLocale();
  const { filters: f, rows, total } = await adminTenantList(db, query);
  const base = "/admin/tenants";
  const sortProps = { sort: f.sort, dir: f.dir, base, query };
  const exportHref = queryHref(`${base}/export`, query, { page: undefined });
  const filtered = Boolean(f.q || f.status || f.plan || f.payment || f.addon || f.attention);
  const sorts: SortOption[] = [
    { label: t("tenants.columns.tenant"), column: "name" },
    { label: t("tenants.columns.status"), column: "status" },
    { label: t("tenants.columns.plan"), column: "plan" },
    { label: t("tenants.columns.health"), column: "health" },
    { label: t("tenants.columns.mrr"), column: "mrr", defaultDir: "desc" },
    { label: t("tenants.columns.orders30"), column: "orders", defaultDir: "desc" },
    { label: t("tenants.columns.last_login"), column: "login", defaultDir: "desc" },
  ];
  // filters inside the phone sheet, as removable chips (the status chips above stay on every width)
  const chips: AdminFilterChip[] = [
    ...(f.q ? [{ key: "q", label: `“${f.q}”`, href: queryHref(base, query, { q: undefined, page: undefined }) }] : []),
    ...(f.plan ? [{ key: "plan", label: t(`plans.${f.plan}`), href: queryHref(base, query, { plan: undefined, page: undefined }) }] : []),
    ...(f.payment ? [{ key: "payment", label: t(`payment.${f.payment}`), href: queryHref(base, query, { payment: undefined, page: undefined }) }] : []),
    ...(f.addon ? [{ key: "addon", label: tm(`addon.${f.addon.replace("addon.", "")}.name`), href: queryHref(base, query, { addon: undefined, page: undefined }) }] : []),
  ];
  return (
    <>
      <PageHeader
        eyebrow={t("console")}
        title={t("tenants.title")}
        description={t("tenants.description")}
        actions={
          <>
            <Button variant="outline" asChild><a href={exportHref} data-testid="export-tenants">{t("export_csv")}</a></Button>
            <Button asChild><Link href="/admin/tenants/new">{t("tenants.new")}</Link></Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Link href={queryHref(base, query, { attention: f.attention ? undefined : "1" })} className={`rounded-full border px-3 py-1 ${f.attention ? "bg-destructive text-destructive-foreground" : "bg-card hover:bg-muted"}`} data-testid="filter-attention">{t("tenants.needs_attention")}</Link>
        {TENANT_STATUSES.map((s) => (
          <Link key={s} href={queryHref(base, query, { status: f.status === s ? undefined : s })} className={`rounded-full border px-3 py-1 ${f.status === s ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}>{t(`tenants.status.${s}`)}</Link>
        ))}
      </div>
      <AdminFilters chips={chips} sorts={{ props: sortProps, options: sorts }}>
        <form id={ADMIN_FILTER_FORM} className="grid gap-3 rounded-lg border bg-card p-3 max-md:border-0 max-md:p-0 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]" method="get" action={base}>
          {f.status && <input type="hidden" name="status" value={f.status} />}
          {f.attention && <input type="hidden" name="attention" value="1" />}
          <input type="hidden" name="sort" value={f.sort} />
          <input type="hidden" name="dir" value={f.dir} />
          <div className="space-y-1.5">
            <Label htmlFor="t-q">{t("filters.search")}</Label>
            <Input id="t-q" name="q" type="search" defaultValue={f.q ?? ""} placeholder={t("tenants.search_placeholder")} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-plan">{t("tenants.columns.plan")}</Label>
            <Select id="t-plan" name="plan" defaultValue={f.plan ?? ""}>
              <option value="">{t("filters.all")}</option>
              {PLAN_KEYS.map((p) => <option key={p} value={p}>{t(`plans.${p}`)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-payment">{t("tenants.columns.payment")}</Label>
            <Select id="t-payment" name="payment" defaultValue={f.payment ?? ""}>
              <option value="">{t("filters.all")}</option>
              {(["ok", "past_due", "suspended", "none"] as const).map((p) => <option key={p} value={p}>{t(`payment.${p}`)}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-addon">{t("tenants.columns.addons")}</Label>
            <Select id="t-addon" name="addon" defaultValue={f.addon ?? ""}>
              <option value="">{t("filters.all")}</option>
              {ADDON_MODULES.map((a) => <option key={a} value={a}>{tm(`addon.${a.replace("addon.", "")}.name`)}{MODULES[a].availability === "implemented" && !canActivateAddon(a) ? ` · ${t("tenant.in_development")}` : ""}</option>)}
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="max-md:hidden">{t("filters.apply")}</Button>
            {filtered && <Button variant="outline" asChild><Link href={base}>{t("filters.reset")}</Link></Button>}
          </div>
        </form>
      </AdminFilters>
      <p className="mb-2 text-sm text-muted-foreground" data-testid="tenant-count">{t("tenants.count", { shown: rows.length, total })}</p>
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState title={t("tenants.empty")} />
          ) : (
            <DataList
              rows={rows}
              rowKey={(x) => x.id}
              rowProps={(x) => ({ "data-testid": "tenant-row", "data-slug": x.slug })}
              columns={[
                { key: "name", ...sortColumn(sortProps, sorts[0]!), mobile: "title", cell: (x) => <>
                  <Link href={`/admin/tenants/${x.id}`} className="font-medium hover:underline">{x.name}</Link>
                  <div className="text-xs font-normal text-muted-foreground">{x.slug} · {x.country} · {x.currency}</div>
                  {x.addons.length > 0 && <div className="mt-1 hidden flex-wrap gap-1 md:flex">{x.addons.map((a) => <Badge key={a} variant="outline" className="font-mono text-[10px]">{a}</Badge>)}</div>}
                </> },
                { key: "status", ...sortColumn(sortProps, sorts[1]!), mobile: "badge", cell: (x) => <>
                  <LifecycleBadge status={x.status} label={t(`tenants.status.${x.status}`)} />
                  {x.status === "trial" && x.trialEndsAt && <div className="text-xs text-muted-foreground max-md:hidden">{t("tenants.trial_ends", { date: formatDate(x.trialEndsAt, locale, "UTC") })}</div>}
                  {x.statusReason && x.status !== "trial" && x.status !== "active" && <div className="text-xs text-muted-foreground max-md:hidden">{t(`lifecycle.reasons.${x.statusReason}`)}</div>}
                </> },
                { key: "plan", ...sortColumn(sortProps, sorts[2]!), priority: 2, cell: (x) => t(`plans.${x.planKey}`) },
                { key: "health", ...sortColumn(sortProps, sorts[3]!), cell: (x) => <>
                  <HealthBadge score={x.health.score} attention={x.health.needsAttention} title={x.health.factors.map((h) => `${t(`health.${h.key}`)} −${h.penalty}`).join(" · ")} />
                  {x.health.factors.length > 0 && <div className="hidden text-xs text-muted-foreground xl:block">{x.health.factors.map((h) => t(`health.${h.key}`)).join(", ")}</div>}
                </> },
                { key: "mrr", ...sortColumn(sortProps, sorts[4]!), align: "right", priority: 2, className: "tabular", cell: (x) => (x.mrrMinor ? formatMoney(x.mrrMinor, PLATFORM_CURRENCY, locale) : "—") },
                { key: "orders", ...sortColumn(sortProps, sorts[5]!), align: "right", priority: 3, className: "tabular", cell: (x) => formatNumber(x.ordersLast30, locale) },
                { key: "login", ...sortColumn(sortProps, sorts[6]!), priority: 3, className: "text-xs", cell: (x) => (x.lastLoginAt ? formatDateTime(x.lastLoginAt, locale, "UTC") : "—") },
                { key: "payment", header: t("tenants.columns.payment"), label: "", cell: (x) => <span className="inline-flex flex-wrap items-center gap-x-2 md:block">
                  <PaymentBadge health={x.payment} label={t(`payment.${x.payment}`)} />
                  {x.openMinor > 0 && <span className="block text-xs text-muted-foreground tabular max-md:inline">{formatMoney(x.openMinor, PLATFORM_CURRENCY, locale)}</span>}
                </span> },
                { key: "actions", header: <span className="sr-only">{t("tenant.open_as_support")}</span>, mobile: "action", align: "right", cell: (x) => <OpenAsSupportButton tenantId={x.id} /> },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminTenantsPage, "app/admin/tenants/page.tsx");
