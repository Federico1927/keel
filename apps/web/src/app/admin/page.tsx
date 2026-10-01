import { PLATFORM_CURRENCY } from "@keel/config";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { desc, schema } from "@keel/db";
import { formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { platformMetrics, tenantsOverview } from "@keel/services";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { getLocale } from "next-intl/server";
import { BillingRunButton } from "./billing/controls";

export default async function AdminHome() {
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const [metrics, tenants, audit] = await Promise.all([
    platformMetrics(db),
    tenantsOverview(db),
    db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(12),
  ]);
  const money = (m: number) => formatMoney(m, PLATFORM_CURRENCY, locale);
  return (
    <>
      <PageHeader
        eyebrow={t("console")}
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        actions={<BillingRunButton />}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t("dashboard.mrr")}
          value={money(metrics.mrrMinor)}
          hint={t("dashboard.mrr_hint")}
        />
        <Stat
          label={t("dashboard.active_tenants")}
          value={formatNumber(metrics.tenants.active, locale)}
          hint={t("dashboard.tenants_hint", {
            trial: metrics.tenants.trial,
            suspended: metrics.tenants.suspended,
          })}
          href="/admin/tenants"
        />
        <Stat
          label={t("dashboard.open_invoices")}
          value={money(metrics.invoices.openMinor)}
          hint={t("dashboard.open_invoices_hint", {
            n: metrics.invoices.open,
            overdue: metrics.invoices.overdue,
          })}
          href="/admin/billing?status=open"
        />
        <Stat
          label={t("dashboard.integration_errors")}
          value={formatNumber(metrics.integrationErrors, locale)}
          hint={t("dashboard.integration_errors_hint")}
        />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard.addons")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {metrics.addons.length === 0 ? (
              <p className="text-muted-foreground">—</p>
            ) : (
              <ul className="space-y-1">
                {metrics.addons.map((a) => (
                  <li key={a.key} className="flex justify-between">
                    <span className="font-mono text-xs">{a.key}</span>
                    <span className="tabular">{a.count}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {t("dashboard.subscriptions", metrics.subscriptions)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("dashboard.paid_30", { amount: money(metrics.invoices.paidLast30Minor) })}
            </p>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard.tenants")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tenants.columns.tenant")}</TableHead>
                  <TableHead>{t("tenants.columns.plan")}</TableHead>
                  <TableHead className="text-right">{t("tenants.columns.orders30")}</TableHead>
                  <TableHead>{t("tenants.columns.payment")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.slice(0, 8).map((x) => (
                  <TableRow key={x.id}>
                    <TableCell>
                      <Link href={`/admin/tenants/${x.id}`} className="font-medium hover:underline">
                        {x.name}
                      </Link>{" "}
                      <Badge
                        variant={
                          x.status === "active"
                            ? "success"
                            : x.status === "suspended"
                              ? "destructive"
                              : "warning"
                        }
                      >
                        {t(`tenants.status.${x.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{t(`plans.${x.planKey}`)}</TableCell>
                    <TableCell className="text-right tabular">
                      {formatNumber(x.ordersLast30, locale)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          x.payment === "ok"
                            ? "success"
                            : x.payment === "past_due"
                              ? "warning"
                              : x.payment === "suspended"
                                ? "destructive"
                                : "muted"
                        }
                      >
                        {t(`payment.${x.payment}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard.recent_audit")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground tabular">
                  {formatDateTime(a.createdAt, locale, "UTC")}
                </span>
                <span className="font-mono text-xs">{a.action}</span>
                <Badge variant="outline">{a.actorType}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
