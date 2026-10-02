import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDate, formatDiscountValue, formatMoney, formatNumber, type DiscountState, type DiscountType } from "@keel/core";
import { latestPlatformWrites, listDiscountPools, listDiscounts } from "@keel/services";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Pagination, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { DiscountFiltersBar } from "./filters";
import { DiscountStateBadge } from "./state-badge";
import { PlatformWriteStatus } from "@/components/platform-write-status";

export default async function DiscountsPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
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
          <CardHeader className="flex-row items-center justify-between space-y-0">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.code")}</TableHead>
                  <TableHead>{t("columns.value")}</TableHead>
                  <TableHead>{t("columns.state")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.uses")}</TableHead>
                  <TableHead className="text-right">{t("columns.orders")}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t("columns.given")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.revenue")}</TableHead>
                  <TableHead className="text-right">{t("columns.margin")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.validity")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((d) => (
                  <TableRow key={d.id} data-testid="discount-row">
                    <TableCell>
                      <Link href={`${base}/${d.id}`} className="font-mono text-sm font-medium hover:underline">{d.code}</Link>
                      <div className="truncate text-xs text-muted-foreground">{d.title ?? d.poolTitle ?? ""}{d.source === "keel" && <Badge variant="outline" className="ml-1">Keel</Badge>}</div>
                    </TableCell>
                    <TableCell>{d.type === "free_shipping" ? t("free_shipping") : formatDiscountValue(d.type as DiscountType, d.value, money)}</TableCell>
                    <TableCell><DiscountStateBadge state={d.state} /></TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(d.usedCount, ctx.locale)}{d.usageLimit ? ` / ${formatNumber(d.usageLimit, ctx.locale)}` : ""}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(d.orders, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{money(d.discountGivenMinor)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{money(d.netRevenueMinor)}</TableCell>
                    <TableCell className={`text-right tabular ${d.marginMinor < 0 ? "text-destructive" : ""}`}>{money(d.marginMinor)}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{d.startsAt ? formatDate(d.startsAt, ctx.locale, ctx.tenant.timezone) : "—"} → {d.endsAt ? formatDate(d.endsAt, ctx.locale, ctx.tenant.timezone) : "∞"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.pool")}</TableHead>
                  <TableHead>{t("columns.value")}</TableHead>
                  <TableHead className="text-right">{t("columns.ready")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.assigned")}</TableHead>
                  <TableHead className="text-right">{t("columns.used")}</TableHead>
                  <TableHead>{t("columns.state")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pools.map((p) => (
                  <TableRow key={p.pool.id} data-testid="pool-row">
                    <TableCell><Link href={`${base}/pools/${p.pool.id}`} className="font-medium hover:underline">{p.pool.title}</Link><div className="text-xs text-muted-foreground">{p.pool.prefix}-******** · {t("pool_codes", { n: formatNumber(p.codes, ctx.locale) })}</div></TableCell>
                    <TableCell>{formatDiscountValue(p.pool.type as DiscountType, p.pool.value, money)}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(p.ready, ctx.locale)} / {formatNumber(p.pool.targetSize, ctx.locale)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{formatNumber(p.assigned, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(p.used, ctx.locale)}</TableCell>
                    <TableCell>
                      {p.pool.isActive ? <Badge variant={p.pool.status === "ready" ? "success" : "warning"}>{t(`pool_status.${p.pool.status}`)}</Badge> : <Badge variant="muted">{t("pool_status.inactive")}</Badge>}
                      <PlatformWriteStatus slug={tenant} write={poolWrites.get(p.pool.id)} canRetry={canCreate} className="ml-1" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
