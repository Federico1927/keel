import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ADDON_MODULES, CHURN_RETENTION_DAYS, MODULES, PLATFORM_CURRENCY, isTenantStatus } from "@keel/config";
import { LIFECYCLE_TRANSITIONS, formatDate, formatDateTime, formatMoney, formatNumber } from "@keel/core";
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
import { toBrand } from "@/server/branding";
import { LifecycleBadge, PaymentBadge } from "../../_components/badges";
import {
  AddonToggle,
  InvoiceActions,
  LifecycleControl,
  OpenAsSupportButton,
  PlanSelect,
  SendPasswordResetButton,
  TrialEndControl,
} from "./controls";
import { SubscriptionCard } from "./subscription-card";

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
  const status = isTenantStatus(d.tenant.status) ? d.tenant.status : "active";
  const brand = toBrand(d.tenant.slug, d.branding);
  const blocked = status === "suspended" || status === "churned";
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
          <LifecycleBadge status={status} label={t(`tenants.status.${status}`)} />
          <Badge variant="outline">{t(`plans.${d.tenant.planKey}`)}</Badge>
          <PaymentBadge health={d.payment.health} label={t(`payment.${d.payment.health}`)} />
        </>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          <OpenAsSupportButton tenantId={d.tenant.id} />
          <LifecycleControl tenantId={d.tenant.id} allowed={LIFECYCLE_TRANSITIONS[status]} />
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
                    <Link href={`/admin/users/${m.id}`} className="min-w-0 flex-1 truncate hover:underline">{m.email}</Link>
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
      <Card className="mb-6" data-testid="lifecycle-card">
        <CardHeader>
          <CardTitle className="text-base">{t("lifecycle.title")}</CardTitle>
          <CardDescription>{t("lifecycle.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {blocked && <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive" data-testid="lifecycle-blocked">{t("lifecycle.blocked_now")}</p>}
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t("lifecycle.current")}</dt>
            <dd className="flex flex-wrap items-center gap-2"><LifecycleBadge status={status} label={t(`tenants.status.${status}`)} />{d.tenant.statusChangedAt && <span className="text-xs text-muted-foreground">{t("lifecycle.since", { date: formatDateTime(d.tenant.statusChangedAt, locale, "UTC") })}</span>}</dd>
            {d.tenant.statusReason && <><dt className="text-muted-foreground">{t("lifecycle.reason")}</dt><dd data-testid="lifecycle-reason-current">{t(`lifecycle.reasons.${d.tenant.statusReason}`)}{d.tenant.statusNote ? ` — ${d.tenant.statusNote}` : ""}</dd></>}
            <dt className="text-muted-foreground">{t("lifecycle.trial_end")}</dt>
            <dd>{status === "trial" ? <TrialEndControl tenantId={d.tenant.id} value={d.tenant.trialEndsAt ? d.tenant.trialEndsAt.toISOString().slice(0, 10) : ""} /> : d.tenant.trialEndsAt ? formatDate(d.tenant.trialEndsAt, locale, "UTC") : "—"}</dd>
            {d.retainedUntil && <><dt className="text-muted-foreground">{t("lifecycle.retained_until")}</dt><dd data-testid="retained-until">{formatDate(d.retainedUntil, locale, "UTC")} <span className="text-xs text-muted-foreground">{t("lifecycle.retention_hint", { days: CHURN_RETENTION_DAYS })}</span></dd></>}
          </dl>
          {d.lifecycle.length > 0 && (
            <ol className="space-y-1.5 border-l pl-4" data-testid="lifecycle-history">
              {d.lifecycle.map(({ event: e, actorEmail }) => (
                <li key={e.id} className="text-xs">
                  <span className="text-muted-foreground tabular">{formatDateTime(e.createdAt, locale, "UTC")}</span>{" "}
                  <span className="font-medium">{e.fromStatus && e.fromStatus !== e.toStatus ? `${t(`tenants.status.${e.fromStatus}`)} → ` : ""}{t(`tenants.status.${e.toStatus}`)}</span>{" "}
                  · {t(`lifecycle.reasons.${e.reason}`)}{e.note ? ` — ${e.note}` : ""} · {t(`plans.${e.planKey}`)} {formatMoney(e.monthlyMinor, PLATFORM_CURRENCY, locale)}/m · <span className="text-muted-foreground">{actorEmail ?? t("lifecycle.system")}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
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
          <CardTitle className="flex items-center justify-between gap-2 text-base">{t("tenant.integrations")} <Link href={`/admin/integrations?tenant=${d.tenant.id}`} className="text-xs font-normal text-primary hover:underline">{t("tenant.integration_issues")}</Link></CardTitle>
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
      <Card className="mt-6" data-testid="branding-card">
        <CardHeader>
          <CardTitle className="text-base">{t("tenant.branding")}</CardTitle>
          <CardDescription>{t("tenant.branding_description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-6 text-sm">
          <span className="flex items-center gap-2">
            <span className="h-8 w-8 rounded-md border" style={{ background: brand.light.primary }} aria-hidden />
            <span><span className="block font-mono text-xs">{brand.brandColor ?? t("tenant.brand_default")}</span>{brand.light.adjusted && <span className="block text-xs text-muted-foreground">{t("tenant.brand_adjusted", { color: brand.light.primary })}</span>}</span>
          </span>
          {brand.logoLight ? <span className="light rounded-md border bg-card p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={brand.logoLight} alt={t("tenant.logo_light")} className="h-8 w-auto" /></span> : <span className="text-xs text-muted-foreground">{t("tenant.no_logo")}</span>}
          {d.branding.logoDark && brand.logoDark && <span className="dark rounded-md border bg-card p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={brand.logoDark} alt={t("tenant.logo_dark")} className="h-8 w-auto" /></span>}
          {d.branding.updatedAt && <span className="text-xs text-muted-foreground">{t("tenant.brand_updated", { date: formatDate(d.branding.updatedAt, locale, "UTC") })}</span>}
        </CardContent>
      </Card>
      <SubscriptionCard db={db} tenantId={d.tenant.id} planKey={d.tenant.planKey} />
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
                    <InvoiceActions invoiceId={i.id} status={i.status} provider={i.provider} />
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
