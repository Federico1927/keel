import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { OVERAGE, PLATFORM_CURRENCY, displayedVersions, isAddonModule } from "@hullwise/config";
import { formatMoney, formatNumber } from "@hullwise/core";
import { planUsage } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";

import { withIntl } from "@/i18n/intl-scope";
/** Plans, limits and add-on prices from @hullwise/config, with how many tenants use each (#48). Read-only: editing stays in code. */
async function AdminPlansPage() {
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin");
  const tm = await getTranslations("modules");
  const locale = await getLocale();
  const usage = await planUsage(db);
  const money = (m: number | null) => (m === null ? "—" : formatMoney(m, PLATFORM_CURRENCY, locale));
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("plans_page.title")} description={t("plans_page.description")} />
      <Alert variant="info" className="mb-6"><AlertDescription>{t("plans_page.read_only")}</AlertDescription></Alert>
      <div className="grid gap-4 md:grid-cols-3">
        {usage.plans.map(({ plan, tenants, byStatus }) => (
          <Card key={plan.key} data-testid={`plan-${plan.key}`}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">{t(`plans.${plan.key}`)} <Link href={`/admin/tenants?plan=${plan.key}`} className="text-sm font-normal text-primary hover:underline" data-testid="plan-tenants">{t("plans_page.tenants_n", { n: tenants })}</Link></CardTitle>
              <CardDescription className="font-mono text-xs">{plan.key}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">{t("plans_page.monthly")}</dt><dd className="tabular">{money(plan.monthlyPriceMinor)}</dd>
                <dt className="text-muted-foreground">{t("plans_page.setup")}</dt><dd className="tabular">{money(plan.setupFeeMinor)}</dd>
                <dt className="text-muted-foreground">{t("plans_page.orders_limit")}</dt><dd className="tabular">{formatNumber(plan.maxOrdersPerMonth, locale)}</dd>
                <dt className="text-muted-foreground">{t("plans_page.users_limit")}</dt><dd>{plan.maxUsers === null ? t("plans_page.unlimited") : formatNumber(plan.maxUsers, locale)}</dd>
              </dl>
              {Object.keys(byStatus).length > 0 && <p className="mt-3 flex flex-wrap gap-1">{Object.entries(byStatus).map(([s, n]) => <Badge key={s} variant="outline">{t(`tenants.status.${s}`)} {n}</Badge>)}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("plans_page.overage", { price: money(OVERAGE.pricePerBlockMinor), orders: formatNumber(OVERAGE.blockOrders, locale) })}</p>
      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">{t("plans_page.addons")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <DataList
            rows={usage.addons}
            rowKey={({ module: m }) => m.key}
            rowProps={() => ({ "data-testid": "addon-row" })}
            columns={[
              { key: "addon", header: t("plans_page.addon"), mobile: "title", cell: ({ module: m }) => <><span className="font-medium">{tm(`addon.${m.key.replace("addon.", "")}.name`)}</span> <span className="break-all font-mono text-xs font-normal text-muted-foreground">{m.key}</span></> },
              { key: "monthly", header: t("plans_page.monthly"), align: "right", className: "tabular", cell: ({ module: m }) => money(m.monthlyPriceMinor) },
              { key: "availability", header: t("plans_page.availability"), mobile: "subtitle", cell: ({ module: m }) => (m.availability === "implemented" && isAddonModule(m.key) ? (
                <span className="flex flex-wrap gap-1">
                  {displayedVersions(m.key).map((v) => <Badge key={v.version} variant={v.status === "released" ? "success" : "warning"}>{t(`tenant.version_${v.status}`, { version: v.version })}</Badge>)}
                </span>
              ) : (
                <Badge variant="muted">{t(`plans_page.availability_${m.availability}`)}</Badge>
              )) },
              { key: "tenants", header: t("plans_page.tenants"), align: "right", cell: ({ module: m, tenants }) => (m.availability === "implemented" ? <Link href={`/admin/tenants?addon=${m.key}`} className="tabular hover:underline">{formatNumber(tenants, locale)}</Link> : "—") },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminPlansPage, "app/admin/plans/page.tsx");
