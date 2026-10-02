import { PLATFORM_CURRENCY, TENANT_STATUSES } from "@keel/config";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { desc, schema } from "@keel/db";
import { formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { churnedPastRetention, platformMetrics, tenantsOverview } from "@keel/services";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { BillingRunButton } from "./billing/controls";
import { HealthBadge, LifecycleBadge } from "./_components/badges";

export default async function AdminHome() {
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const [metrics, tenants, audit, pastRetention] = await Promise.all([platformMetrics(db), tenantsOverview(db), db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(12), churnedPastRetention(db)]);
  const money = (m: number) => formatMoney(m, PLATFORM_CURRENCY, locale);
  const attention = tenants.filter((x) => x.health.needsAttention).sort((a, b) => a.health.score - b.health.score);
  const byStatus = Object.fromEntries(TENANT_STATUSES.map((s) => [s, tenants.filter((x) => x.status === s).length]));
  return (
    <>
      <PageHeader eyebrow={t("console")} title={t("dashboard.title")} description={t("dashboard.description")} actions={<BillingRunButton />} />
      <form method="get" action="/admin/users" role="search" className="mb-6 flex max-w-xl gap-2">
        <Input name="q" type="search" placeholder={t("dashboard.find_user")} aria-label={t("dashboard.find_user")} autoComplete="off" data-testid="dashboard-user-search" />
        <Button type="submit" variant="outline">{t("dashboard.find")}</Button>
      </form>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("dashboard.mrr")} value={money(metrics.mrrMinor)} hint={t("dashboard.mrr_hint")} href="/admin/metrics" />
        <Stat label={t("dashboard.active_tenants")} value={formatNumber(metrics.tenants.active + metrics.tenants.pastDue, locale)} hint={t("dashboard.tenants_hint", { trial: metrics.tenants.trial, suspended: metrics.tenants.suspended })} href="/admin/tenants" />
        <Stat label={t("dashboard.open_invoices")} value={money(metrics.invoices.openMinor)} hint={t("dashboard.open_invoices_hint", { n: metrics.invoices.open, overdue: metrics.invoices.overdue })} href="/admin/billing?status=open" />
        <Stat label={t("dashboard.integration_errors")} value={formatNumber(metrics.integrationErrors, locale)} hint={t("dashboard.integration_errors_hint")} href="/admin/integrations" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-xs" data-testid="lifecycle-counts">
        {TENANT_STATUSES.map((s) => (
          <Link key={s} href={`/admin/tenants?status=${s}`} className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 hover:bg-muted"><LifecycleBadge status={s} label={t(`tenants.status.${s}`)} /> <span className="tabular">{formatNumber(byStatus[s] ?? 0, locale)}</span></Link>
        ))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="attention-card">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-base">{t("dashboard.attention")} <Link href="/admin/tenants?attention=1&sort=health" className="text-xs font-normal text-primary hover:underline">{t("dashboard.see_all")}</Link></CardTitle>
            <CardDescription>{t("dashboard.attention_description")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {attention.length === 0 ? <p className="px-6 pb-6 text-sm text-muted-foreground">{t("dashboard.attention_none")}</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>{t("tenants.columns.tenant")}</TableHead><TableHead>{t("tenants.columns.health")}</TableHead><TableHead>{t("dashboard.why")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {attention.slice(0, 8).map((x) => (
                    <TableRow key={x.id}>
                      <TableCell><Link href={`/admin/tenants/${x.id}`} className="font-medium hover:underline">{x.name}</Link> <LifecycleBadge status={x.status} label={t(`tenants.status.${x.status}`)} /></TableCell>
                      <TableCell><HealthBadge score={x.health.score} attention={x.health.needsAttention} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{x.health.factors.map((f) => t(`health.${f.key}`)).join(", ")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("dashboard.addons")}</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {metrics.addons.length === 0 ? <p className="text-muted-foreground">—</p> : (
              <ul className="space-y-1">{metrics.addons.map((a) => <li key={a.key} className="flex justify-between"><Link href={`/admin/tenants?addon=${a.key}`} className="font-mono text-xs hover:underline">{a.key}</Link><span className="tabular">{a.count}</span></li>)}</ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("dashboard.subscriptions", metrics.subscriptions)}</p>
            <p className="text-xs text-muted-foreground">{t("dashboard.paid_30", { amount: money(metrics.invoices.paidLast30Minor) })}</p>
            {pastRetention.length > 0 && (
              <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs" data-testid="past-retention">
                <p className="font-medium">{t("dashboard.past_retention", { n: pastRetention.length })}</p>
                <ul className="mt-1">{pastRetention.map((r) => <li key={r.id}><Link href={`/admin/tenants/${r.id}`} className="hover:underline">{r.name}</Link></li>)}</ul>
                <p className="mt-1 text-muted-foreground">{t("dashboard.past_retention_hint")}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center justify-between gap-2 text-base">{t("dashboard.recent_audit")} <Link href="/admin/audit" className="text-xs font-normal text-primary hover:underline">{t("dashboard.see_all")}</Link></CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground tabular">{formatDateTime(a.createdAt, locale, "UTC")}</span>
                <span className="font-mono text-xs">{a.action}</span>
                <Badge variant={a.actorType === "super_admin" || a.actorType === "impersonation" ? "platform" : "outline"}>{a.actorType}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
