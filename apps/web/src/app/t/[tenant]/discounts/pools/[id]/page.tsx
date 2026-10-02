import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo, canExportList } from "@hullwise/config";
import { formatDate, formatDiscountValue, formatMoney, formatNumber, POOL_CODE_STATUSES, type DiscountType, type PoolCodeStatus } from "@hullwise/core";
import { latestPlatformWrites, listPoolCodes, poolSummaries } from "@hullwise/services";
import { and, asc, eq, schema } from "@hullwise/db";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DetailShell, EmptyState, Pagination, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { AssignForm, PoolActiveToggle, ReleaseButton, TopUpForm } from "./controls";

const STATUS_VARIANT: Record<PoolCodeStatus, "success" | "info" | "muted"> = { available: "success", assigned: "info", redeemed: "muted" };

export default async function DiscountPoolPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant, id } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "discounts");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("discount_pool");
  const td = await getTranslations("discounts");
  const status = sp.status === "inactive" || (POOL_CODE_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as PoolCodeStatus | "inactive") : undefined;
  const q = sp.q?.trim() || undefined;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const canWrite = canDo(ctx.role, "create_discount");
  const data = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    const [summary] = await poolSummaries(s, [id]);
    if (!summary) return null;
    const codes = await listPoolCodes(s, id, { status, q, page });
    const writes = await latestPlatformWrites(s, "discount_pool", [id]);
    const codeWrites = await latestPlatformWrites(s, "discount", codes.rows.map((r) => r.id));
    const campaigns = canWrite ? await tx.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenant.id), eq(schema.campaigns.status, "active"))).orderBy(asc(schema.campaigns.name)).limit(200) : [];
    return { summary, codes, poolWrite: writes.get(id), codeWrites, campaigns };
  });
  if (!data) notFound();
  const { summary, codes, poolWrite, codeWrites, campaigns } = data;
  const pool = summary.pool;
  const base = `/t/${tenant}/discounts/pools/${id}`;
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, q, ...patch })) if (v) u.set(k, v);
    return u.size ? `?${u}` : "";
  };
  const chips: { key: PoolCodeStatus | "inactive" | undefined; label: string; n: number }[] = [
    { key: undefined, label: t("all"), n: summary.codes },
    { key: "available", label: t("status.available"), n: summary.available },
    { key: "assigned", label: t("status.assigned"), n: summary.assigned },
    { key: "redeemed", label: t("status.redeemed"), n: summary.redeemed },
    { key: "inactive", label: t("inactive"), n: summary.inactive },
  ];
  return (
    <DetailShell
      back={<Link href={`/t/${tenant}/discounts`} className="hover:underline">← {td("title")}</Link>}
      eyebrow={t("eyebrow")}
      title={pool.title}
      chips={
        <>
          <Badge variant={pool.isActive ? "success" : "muted"} data-testid="pool-state">{pool.isActive ? t("active") : t("inactive")}</Badge>
          <Badge variant="outline">{formatDiscountValue(pool.type as DiscountType, pool.value, money)}</Badge>
          {pool.status === "partial" && <Badge variant="warning">{td("pool_status.partial")}</Badge>}
          <span data-testid="pool-sync"><PlatformWriteStatus slug={tenant} write={poolWrite} canRetry={canWrite} showError /></span>
        </>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          {canExportList(ctx.role, "discounts") && <a href={`${base}/export${qs({})}`} className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-muted" data-testid="pool-export">{t("export")}</a>}
          {canWrite && <PoolActiveToggle slug={tenant} poolId={id} isActive={pool.isActive} />}
        </div>
      }
      aside={
        canWrite && pool.isActive ? (
          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-base">{t("top_up_title")}</CardTitle><CardDescription>{t("top_up_description")}</CardDescription></CardHeader>
              <CardContent><TopUpForm slug={tenant} poolId={id} ready={summary.ready} target={pool.targetSize} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">{t("assign_title")}</CardTitle><CardDescription>{t("assign_description")}</CardDescription></CardHeader>
              <CardContent><AssignForm slug={tenant} poolId={id} campaigns={campaigns} /></CardContent>
            </Card>
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="pool-counts">
        <Stat label={t("kpi.ready")} value={formatNumber(summary.ready, ctx.locale)} hint={t("kpi.target", { n: formatNumber(pool.targetSize, ctx.locale) })} />
        <Stat label={t("status.assigned")} value={formatNumber(summary.assigned, ctx.locale)} />
        <Stat label={t("status.redeemed")} value={formatNumber(summary.redeemed, ctx.locale)} />
        <Stat label={t("kpi.validity")} value={pool.endsAt ? formatDate(pool.endsAt, ctx.locale, ctx.tenant.timezone) : "∞"} hint={pool.startsAt ? t("kpi.from", { date: formatDate(pool.startsAt, ctx.locale, ctx.tenant.timezone) }) : undefined} />
      </div>
      <div className="mt-6 flex flex-wrap gap-2 text-xs">
        {chips.map((c) => (
          <Link key={c.key ?? "all"} href={`${base}${qs({ status: c.key, page: undefined })}`} className={cn("rounded-full border px-3 py-1", status === c.key ? "bg-primary text-primary-foreground" : "bg-card")} data-testid={`pool-filter-${c.key ?? "all"}`}>
            {c.label} <span className="tabular opacity-70">{formatNumber(c.n, ctx.locale)}</span>
          </Link>
        ))}
        <form className="ml-auto" action={base}>
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder={t("search_placeholder")} aria-label={t("search_placeholder")} className="h-7 rounded-md border bg-card px-2 text-xs" />
        </form>
      </div>
      {codes.rows.length === 0 ? (
        <EmptyState title={t("empty")} className="mt-4" />
      ) : (
        <Card className="mt-3">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.code")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("columns.assigned_to")}</TableHead>
                  <TableHead>{t("columns.order")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("columns.redeemed_at")}</TableHead>
                  {canWrite && <TableHead className="w-0" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.rows.map((c) => (
                  <TableRow key={c.id} data-testid="pool-code-row">
                    <TableCell>
                      <Link href={`/t/${tenant}/discounts/${c.id}`} className="font-mono text-sm hover:underline">{c.code}</Link>
                      <PlatformWriteStatus slug={tenant} write={codeWrites.get(c.id)} canRetry={canWrite} className="ml-2" />
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[c.status]} data-testid="pool-code-status">{t(`status.${c.status}`)}</Badge>
                      {!c.isActive && <Badge variant="outline" className="ml-1">{t("inactive")}</Badge>}
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">
                      {c.assignedCustomerId ? <Link href={`/t/${tenant}/customers/${c.assignedCustomerId}`} className="hover:underline">{c.assignedCustomerName ?? c.assignedCustomerEmail}</Link> : c.assignedCampaignId ? <Link href={`/t/${tenant}/campaigns/${c.assignedCampaignId}`} className="hover:underline">{c.assignedCampaignName}</Link> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>{c.redeemedOrderId ? <Link href={`/t/${tenant}/orders/${c.redeemedOrderId}`} className="font-medium hover:underline" data-testid="pool-code-order">{c.redeemedOrderName}</Link> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{c.redeemedAt ? formatDate(c.redeemedAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                    {canWrite && <TableCell>{c.status === "assigned" && <ReleaseButton slug={tenant} poolId={id} discountId={c.id} />}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={codes.page} pageSize={codes.pageSize} total={codes.total} hrefFor={(p) => `${base}${qs({ page: String(p) })}`} summary={td("pagination", { from: codes.total === 0 ? 0 : (codes.page - 1) * codes.pageSize + 1, to: Math.min(codes.page * codes.pageSize, codes.total), total: codes.total })} />
    </DetailShell>
  );
}
