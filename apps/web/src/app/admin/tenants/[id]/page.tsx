import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ADDON_MODULES, MODULES, PLATFORM_CURRENCY } from "@keel/config";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@keel/core";
import { tenantAdminDetail } from "@keel/services";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DetailShell,
  Stat,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import {
  AddonToggle,
  InvoiceActions,
  OpenAsSupportButton,
  PlanSelect,
  SendPasswordResetButton,
  SuspensionButton,
} from "./controls";

export default async function AdminTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await requireSuperAdmin();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await tenantAdminDetail(db, id);
  if (!d) notFound();
  const t = await getTranslations("admin");
  const tm = await getTranslations("modules");
  const locale = await getLocale();
  const money = (m: number, c = d.tenant.currency) => formatMoney(m, c, locale);
  const done = d.checklist.filter((c) => c.done).length;
  return (
    <DetailShell
      back={
        <Link href="/admin/tenants" className="hover:underline">
          ← {t("tenants.title")}
        </Link>
      }
      eyebrow={`${d.tenant.slug} · ${d.tenant.country} · ${d.tenant.currency} · ${d.tenant.timezone}`}
      title={d.tenant.name}
      chips={
        <>
          <Badge
            variant={
              d.tenant.status === "active"
                ? "success"
                : d.tenant.status === "suspended"
                  ? "destructive"
                  : "warning"
            }
          >
            {t(`tenants.status.${d.tenant.status}`)}
          </Badge>
          <Badge variant="outline">{t(`plans.${d.tenant.planKey}`)}</Badge>
          <Badge
            variant={
              d.payment.health === "ok"
                ? "success"
                : d.payment.health === "past_due"
                  ? "warning"
                  : d.payment.health === "suspended"
                    ? "destructive"
                    : "muted"
            }
          >
            {t(`payment.${d.payment.health}`)}
          </Badge>
        </>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          <OpenAsSupportButton tenantId={d.tenant.id} />
          <SuspensionButton tenantId={d.tenant.id} suspended={d.tenant.status === "suspended"} />
        </div>
      }
      aside={
        <div className="space-y-4">
          <Card data-testid="checklist">
            <CardHeader>
              <CardTitle className="text-base">{t("tenant.checklist")}</CardTitle>
              <CardDescription>
                {t("tenant.checklist_progress", { done, total: d.checklist.length })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {d.checklist.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2">
                    <span className={c.done ? "" : "text-muted-foreground"}>
                      {c.done ? "✓" : "○"} {t(`tenant.checklist_items.${c.key}`)}
                    </span>
                    {c.detail && <span className="text-xs text-muted-foreground">{c.key === "owner" && c.detail === "invited" ? t("tenant.owner_invited") : c.detail}</span>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("tenant.members")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {d.members.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="admin-member">
                    <span className="min-w-0 flex-1 truncate">{m.email}</span>
                    <Badge variant="outline">{m.role}</Badge>
                    <SendPasswordResetButton userId={m.id} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("tenants.columns.orders30")} value={formatNumber(d.ordersLast30, locale)} />
        <Stat
          label={t("tenant.open_balance")}
          value={money(d.payment.openMinor, d.subscription?.currency ?? PLATFORM_CURRENCY)}
          hint={
            d.payment.daysOverdue
              ? t("tenant.days_overdue", { n: d.payment.daysOverdue })
              : undefined
          }
        />
        <Stat
          label={t("tenant.suspend_after")}
          value={t("tenant.days_n", { n: d.tenant.suspendAfterDays })}
          hint={d.tenant.suspendedAt ? formatDate(d.tenant.suspendedAt, locale, "UTC") : undefined}
        />
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("tenant.plan_addons")}</CardTitle>
          <CardDescription>{t("tenant.plan_addons_description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 text-sm">
            <span>{t("tenants.columns.plan")}</span>
            <PlanSelect tenantId={d.tenant.id} planKey={d.tenant.planKey} />
          </div>
          <ul className="divide-y">
            {ADDON_MODULES.map((key) => {
              const def = MODULES[key];
              const row = d.addons.find((a) => a.moduleKey === key);
              const available = def.availability === "implemented";
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      {tm(`addon.${key.replace("addon.", "")}.name`)}
                    </span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{key}</span>
                    {!available && (
                      <Badge variant="muted" className="ml-2">
                        {t("tenant.on_request")}
                      </Badge>
                    )}
                    {def.monthlyPriceMinor && (
                      <Badge variant="outline" className="ml-2">
                        {money(def.monthlyPriceMinor, PLATFORM_CURRENCY)}/m
                      </Badge>
                    )}
                    {row && (
                      <div className="text-xs text-muted-foreground">
                        {row.isActive
                          ? t("tenant.activated_at", {
                              date: formatDate(row.activatedAt, locale, "UTC"),
                            })
                          : row.deactivatedAt
                            ? t("tenant.deactivated_at", {
                                date: formatDate(row.deactivatedAt, locale, "UTC"),
                              })
                            : ""}
                        {row.note ? ` · ${row.note}` : ""}
                      </div>
                    )}
                  </span>
                  <AddonToggle
                    tenantId={d.tenant.id}
                    moduleKey={key}
                    active={row?.isActive ?? false}
                    available={available}
                  />
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("tenant.integrations")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm sm:grid-cols-3">
            {d.integrations
              .filter((i) => ["shopify", "meta", "google"].includes(i.provider))
              .map((i) => (
                <li key={i.id} className="rounded-md border p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize">{i.provider}</span>
                    <Badge
                      variant={
                        i.status === "connected"
                          ? "success"
                          : i.status === "error"
                            ? "destructive"
                            : "muted"
                      }
                    >
                      {i.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {i.mode} ·{" "}
                    {i.lastSuccessAt ? formatDateTime(i.lastSuccessAt, locale, "UTC") : "—"}
                  </div>
                  {i.lastError && (
                    <div className="truncate text-xs text-destructive">{i.lastError}</div>
                  )}
                </li>
              ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("tenant.billing")}</CardTitle>
          <CardDescription>
            {d.subscription
              ? t("tenant.subscription_line", {
                  status: d.subscription.status,
                  provider: d.subscription.provider,
                  end: formatDate(d.subscription.currentPeriodEnd, locale, "UTC"),
                })
              : t("tenant.no_subscription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("billing.columns.number")}</TableHead>
                <TableHead>{t("billing.columns.kind")}</TableHead>
                <TableHead className="text-right">{t("billing.columns.amount")}</TableHead>
                <TableHead>{t("billing.columns.due")}</TableHead>
                <TableHead>{t("billing.columns.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.invoices.map((i) => (
                <TableRow key={i.id} data-testid="invoice-row">
                  <TableCell className="font-mono text-xs">{i.number}</TableCell>
                  <TableCell>{t(`billing.kind.${i.kind}`)}</TableCell>
                  <TableCell className="text-right tabular">
                    {money(i.amountMinor, i.currency)}
                  </TableCell>
                  <TableCell>{formatDate(i.dueAt, locale, "UTC")}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        i.status === "paid"
                          ? "success"
                          : i.status === "open"
                            ? i.dueAt < new Date()
                              ? "destructive"
                              : "warning"
                            : "muted"
                      }
                    >
                      {t(`billing.status.${i.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <InvoiceActions invoiceId={i.id} status={i.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("tenant.recent_audit")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {d.audit.map((a) => (
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
    </DetailShell>
  );
}
