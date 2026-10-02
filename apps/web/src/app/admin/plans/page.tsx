import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { OVERAGE, PLATFORM_CURRENCY } from "@keel/config";
import { formatMoney, formatNumber } from "@keel/core";
import { planUsage } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";

/** Plans, limits and add-on prices from @keel/config, with how many tenants use each (#48). Read-only: editing stays in code. */
export default async function AdminPlansPage() {
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
          <Table>
            <TableHeader><TableRow><TableHead>{t("plans_page.addon")}</TableHead><TableHead className="text-right">{t("plans_page.monthly")}</TableHead><TableHead>{t("plans_page.availability")}</TableHead><TableHead className="text-right">{t("plans_page.tenants")}</TableHead></TableRow></TableHeader>
            <TableBody>
              {usage.addons.map(({ module: m, tenants }) => (
                <TableRow key={m.key} data-testid="addon-row">
                  <TableCell><span className="font-medium">{tm(`addon.${m.key.replace("addon.", "")}.name`)}</span> <span className="font-mono text-xs text-muted-foreground">{m.key}</span></TableCell>
                  <TableCell className="text-right tabular">{money(m.monthlyPriceMinor)}</TableCell>
                  <TableCell><Badge variant={m.availability === "implemented" ? "success" : "muted"}>{t(`plans_page.availability_${m.availability}`)}</Badge></TableCell>
                  <TableCell className="text-right">{m.availability === "implemented" ? <Link href={`/admin/tenants?addon=${m.key}`} className="tabular hover:underline">{formatNumber(tenants, locale)}</Link> : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
