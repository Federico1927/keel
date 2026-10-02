import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ADDON_MODULES, PLAN_KEYS, PLATFORM_CURRENCY, TENANT_STATUSES } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { adminTenantList } from "@hullwise/services";
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { OpenAsSupportButton } from "./[id]/controls";
import { HealthBadge, LifecycleBadge, PaymentBadge } from "../_components/badges";
import { SortHead, flatParams, queryHref } from "../_components/table-query";

export default async function AdminTenantsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
      <form className="mb-4 grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]" method="get" action={base}>
        {f.status && <input type="hidden" name="status" value={f.status} />}
        {f.attention && <input type="hidden" name="attention" value="1" />}
        <input type="hidden" name="sort" value={f.sort} />
        <input type="hidden" name="dir" value={f.dir} />
        <div className="space-y-1.5">
          <Label htmlFor="t-q">{t("filters.search")}</Label>
          <Input id="t-q" name="q" defaultValue={f.q ?? ""} placeholder={t("tenants.search_placeholder")} autoComplete="off" />
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
            {ADDON_MODULES.map((a) => <option key={a} value={a}>{tm(`addon.${a.replace("addon.", "")}.name`)}</option>)}
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          {filtered && <Button variant="outline" asChild><Link href={base}>{t("filters.reset")}</Link></Button>}
        </div>
      </form>
      <p className="mb-2 text-sm text-muted-foreground" data-testid="tenant-count">{t("tenants.count", { shown: rows.length, total })}</p>
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState title={t("tenants.empty")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortHead label={t("tenants.columns.tenant")} column="name" {...sortProps} />
                  <SortHead label={t("tenants.columns.status")} column="status" {...sortProps} />
                  <SortHead label={t("tenants.columns.plan")} column="plan" {...sortProps} className="hidden md:table-cell" />
                  <SortHead label={t("tenants.columns.health")} column="health" {...sortProps} />
                  <SortHead label={t("tenants.columns.mrr")} column="mrr" {...sortProps} defaultDir="desc" className="hidden text-right lg:table-cell" />
                  <SortHead label={t("tenants.columns.orders30")} column="orders" {...sortProps} defaultDir="desc" className="hidden text-right lg:table-cell" />
                  <SortHead label={t("tenants.columns.last_login")} column="login" {...sortProps} defaultDir="desc" className="hidden md:table-cell" />
                  <TableHead>{t("tenants.columns.payment")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((x) => (
                  <TableRow key={x.id} data-testid="tenant-row" data-slug={x.slug}>
                    <TableCell>
                      <Link href={`/admin/tenants/${x.id}`} className="font-medium hover:underline">{x.name}</Link>
                      <div className="text-xs text-muted-foreground">{x.slug} · {x.country} · {x.currency}</div>
                      {x.addons.length > 0 && <div className="mt-1 hidden flex-wrap gap-1 md:flex">{x.addons.map((a) => <Badge key={a} variant="outline" className="font-mono text-[10px]">{a}</Badge>)}</div>}
                    </TableCell>
                    <TableCell>
                      <LifecycleBadge status={x.status} label={t(`tenants.status.${x.status}`)} />
                      {x.status === "trial" && x.trialEndsAt && <div className="text-xs text-muted-foreground">{t("tenants.trial_ends", { date: formatDate(x.trialEndsAt, locale, "UTC") })}</div>}
                      {x.statusReason && x.status !== "trial" && x.status !== "active" && <div className="text-xs text-muted-foreground">{t(`lifecycle.reasons.${x.statusReason}`)}</div>}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{t(`plans.${x.planKey}`)}</TableCell>
                    <TableCell>
                      <HealthBadge score={x.health.score} attention={x.health.needsAttention} title={x.health.factors.map((h) => `${t(`health.${h.key}`)} −${h.penalty}`).join(" · ")} />
                      {x.health.factors.length > 0 && <div className="hidden text-xs text-muted-foreground xl:block">{x.health.factors.map((h) => t(`health.${h.key}`)).join(", ")}</div>}
                    </TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{x.mrrMinor ? formatMoney(x.mrrMinor, PLATFORM_CURRENCY, locale) : "—"}</TableCell>
                    <TableCell className="hidden text-right tabular lg:table-cell">{formatNumber(x.ordersLast30, locale)}</TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{x.lastLoginAt ? formatDateTime(x.lastLoginAt, locale, "UTC") : "—"}</TableCell>
                    <TableCell>
                      <PaymentBadge health={x.payment} label={t(`payment.${x.payment}`)} />
                      {x.openMinor > 0 && <div className="text-xs text-muted-foreground tabular">{formatMoney(x.openMinor, PLATFORM_CURRENCY, locale)}</div>}
                    </TableCell>
                    <TableCell className="text-right"><OpenAsSupportButton tenantId={x.id} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
