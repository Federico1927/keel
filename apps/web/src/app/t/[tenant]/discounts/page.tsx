import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { formatDate, formatDiscountValue, formatMoney, formatNumber, type DiscountState, type DiscountType } from "@hullwise/core";
import { latestPlatformWrites, listDiscountPools, listDiscounts } from "@hullwise/services";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader, Pagination } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { DiscountFiltersBar } from "./filters";
import { DiscountStateBadge } from "./state-badge";
import { PlatformWriteStatus } from "@/components/platform-write-status";

import { withIntl } from "@/i18n/intl-scope";
async function DiscountsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "discounts");
  const t = await getTranslations("discounts");
  const filters = { q: sp.q?.trim() || undefined, state: sp.state || undefined, pool: /^[0-9a-f-]{36}$/i.test(sp.pool ?? "") ? sp.pool : undefined };
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const { list, pools, poolWrites } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const pools = await listDiscountPools(s);
    return { list: await listDiscounts(s, at, { q: filters.q, state: (filters.state as DiscountState | undefined) ?? "all", poolId: filters.pool, hidePoolCodes: !filters.pool, page }), pools, poolWrites: await latestPlatformWrites(s, "discount_pool", pools.map((p) => p.pool.id)) };
  });
  const base = `/t/${tenant}/discounts`;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const hrefFor = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) u.set(k, v);
    u.set("page", String(p));
    return `${base}?${u}`;
  };
  const canCreate = canDo(ctx.role, "create_discount");
  const pool = filters.pool ? pools.find((p) => p.pool.id === filters.pool) : undefined;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={canCreate ? <Button asChild><Link href={`${base}/new`}>{t("new")}</Link></Button> : undefined} />
      {pool && (
        <Card className="mb-4">
          <CardHeader className="flex-col gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">{pool.pool.title}</CardTitle>
              <CardDescription>{t("pool_summary", { codes: formatNumber(pool.codes, ctx.locale), used: formatNumber(pool.used, ctx.locale), value: formatDiscountValue(pool.pool.type as DiscountType, pool.pool.value, money) })}</CardDescription>
            </div>
            <div className="flex gap-3 text-sm"><Link href={`${base}/pools/${pool.pool.id}`} className="hover:underline">{t("manage_pool")}</Link><Link href={base} className="hover:underline">{t("all_codes")}</Link></div>
          </CardHeader>
        </Card>
      )}
      <DiscountFiltersBar basePath={base} filters={filters} counts={list.stateCounts} />
      {list.rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} className="mt-4" />
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <DataList
              rows={list.rows}
              rowKey={(d) => d.id}
              rowProps={() => ({ "data-testid": "discount-row" })}
              columns={[
                { key: "code", header: t("columns.code"), mobile: "title", cell: (d) => <><Link href={`${base}/${d.id}`} className="font-mono text-sm font-medium hover:underline">{d.code}</Link><div className="truncate text-xs font-normal text-muted-foreground">{d.title ?? d.poolTitle ?? ""}{d.source === "hullwise" && <Badge variant="outline" className="ml-1">Hullwise</Badge>}</div></> },
                { key: "state", header: t("columns.state"), mobile: "badge", cell: (d) => <DiscountStateBadge state={d.state} /> },
                { key: "value", header: t("columns.value"), mobile: "subtitle", cell: (d) => <span className="max-md:text-foreground">{d.type === "free_shipping" ? t("free_shipping") : formatDiscountValue(d.type as DiscountType, d.value, money)}</span> },
                { key: "uses", header: t("columns.uses"), align: "right", className: "tabular", cell: (d) => <>{formatNumber(d.usedCount, ctx.locale)}{d.usageLimit ? ` / ${formatNumber(d.usageLimit, ctx.locale)}` : ""}</> },
                { key: "orders", header: t("columns.orders"), align: "right", className: "tabular", cell: (d) => formatNumber(d.orders, ctx.locale) },
                { key: "given", header: t("columns.given"), align: "right", priority: 2, className: "tabular", cell: (d) => money(d.discountGivenMinor) },
                { key: "revenue", header: t("columns.revenue"), align: "right", className: "tabular", cell: (d) => money(d.netRevenueMinor) },
                { key: "margin", header: t("columns.margin"), align: "right", className: "tabular", cell: (d) => <span className={d.marginMinor < 0 ? "text-destructive" : ""}>{money(d.marginMinor)}</span> },
                { key: "validity", header: t("columns.validity"), priority: 2, className: "text-xs text-muted-foreground", cell: (d) => <>{d.startsAt ? formatDate(d.startsAt, ctx.locale, ctx.tenant.timezone) : "—"} → {d.endsAt ? formatDate(d.endsAt, ctx.locale, ctx.tenant.timezone) : "∞"}</> },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={hrefFor} summary={t("pagination", { from: list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1, to: Math.min(list.page * list.pageSize, list.total), total: list.total })} />
      {!filters.pool && pools.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">{t("pools_title")}</CardTitle>
            <CardDescription>{t("pools_description")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <DataList
              rows={pools}
              rowKey={(p) => p.pool.id}
              rowProps={() => ({ "data-testid": "pool-row" })}
              columns={[
                { key: "pool", header: t("columns.pool"), mobile: "title", cell: (p) => <><Link href={`${base}/pools/${p.pool.id}`} className="font-medium hover:underline">{p.pool.title}</Link><div className="text-xs font-normal text-muted-foreground">{p.pool.prefix}-******** · {t("pool_codes", { n: formatNumber(p.codes, ctx.locale) })}</div></> },
                { key: "state", header: t("columns.state"), mobile: "badge", cell: (p) => <>{p.pool.isActive ? <Badge variant={p.pool.status === "ready" ? "success" : "warning"}>{t(`pool_status.${p.pool.status}`)}</Badge> : <Badge variant="muted">{t("pool_status.inactive")}</Badge>}<PlatformWriteStatus slug={tenant} write={poolWrites.get(p.pool.id)} canRetry={canCreate} className="ml-1" /></> },
                { key: "value", header: t("columns.value"), mobile: "subtitle", cell: (p) => <span className="max-md:text-foreground">{formatDiscountValue(p.pool.type as DiscountType, p.pool.value, money)}</span> },
                { key: "ready", header: t("columns.ready"), align: "right", className: "tabular", cell: (p) => <>{formatNumber(p.ready, ctx.locale)} / {formatNumber(p.pool.targetSize, ctx.locale)}</> },
                { key: "assigned", header: t("columns.assigned"), align: "right", className: "tabular", cell: (p) => formatNumber(p.assigned, ctx.locale) },
                { key: "used", header: t("columns.used"), align: "right", className: "tabular", cell: (p) => formatNumber(p.used, ctx.locale) },
              ]}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

export default withIntl(DiscountsPage, "app/t/[tenant]/discounts/page.tsx");
