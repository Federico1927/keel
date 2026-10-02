import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDate, formatMoney, formatPercent } from "@hullwise/core";
import { and, eq, schema, sql } from "@hullwise/db";
import { recoveryQueue, subscriptionCapabilities } from "@hullwise/services";
import { Card, CardContent, EmptyState, PageHeader, Stat, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { RecoveryActions } from "../controls";
import { RiskBadge, SubscriptionTabs, svcOf } from "../shared";

import { withIntl } from "@/i18n/intl-scope";
/** Failed-payment recovery queue (addon.subscriptions): value at risk, the app's retry schedule, last contact, assignee; actions through the app. */
async function RecoveryPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ assigned?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "subscriptions");
  const t = await getTranslations("subscriptions");
  const assigned = sp.assigned === "me" || sp.assigned === "none" ? sp.assigned : undefined;
  const { q, caps, members } = await ctx.run(async (tx) => {
    const s = svcOf(ctx, tx);
    const members = await tx.select({ id: schema.users.id, name: sql<string>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.isActive, true))).orderBy(schema.users.name);
    return { q: await recoveryQueue(s, { assigned }), caps: await subscriptionCapabilities(s), members };
  });
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const date = (d: Date | null) => (d ? formatDate(d, ctx.locale, ctx.tenant.timezone) : "—");
  const canWrite = canWritePage(ctx.role, "subscriptions");
  const base = `/t/${tenant}/subscriptions`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("recovery.title")} description={t("recovery.description")} />
      <SubscriptionTabs tenant={tenant} active="recovery" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="recovery-kpis">
        <Stat label={t("recovery.value_at_risk")} value={money(q.valueAtRiskMinor)} hint={t("recovery.open", { n: q.rows.length })} />
        <Stat label={t("recovery.rate")} value={q.recoveryRate === null ? "—" : formatPercent(q.recoveryRate, ctx.locale)} hint={t("recovery.rate_hint", { recovered: q.recovered, lost: q.lost })} />
        <Stat label={t("recovery.recovered_30")} value={money(q.recoveredValue30Minor)} />
        <Stat label={t("recovery.lost")} value={String(q.lost)} hint={t("recovery.lost_hint")} href={`${base}/subscribers?kind=involuntary`} />
      </div>
      <div className="my-4 flex gap-1 rounded-md bg-muted p-1 text-sm">
        {([undefined, "me", "none"] as const).map((v) => <Link key={v ?? "all"} href={`${base}/recovery${v ? `?assigned=${v}` : ""}`} className={cn("flex-1 rounded-sm px-3 py-1.5 text-center", v === assigned ? "bg-card shadow-sm" : "text-muted-foreground")}>{t(`recovery.view_${v ?? "all"}`)}</Link>)}
      </div>
      {q.rows.length === 0 ? <EmptyState title={t("recovery.empty_title")} description={t("recovery.empty_description")} /> : (
        <ul className="space-y-2" data-testid="recovery-queue">
          {q.rows.map((r) => (
            <li key={r.contractId}>
              <Card data-testid="recovery-row">
                <CardContent className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2"><Link href={`${base}/subscribers/${r.contractId}`} className="font-medium hover:underline">{r.customerName ?? r.email ?? "—"}</Link><RiskBadge risk={r.churnRisk} /><span className="text-sm font-semibold tabular">{money(r.valueAtRiskMinor)}</span></div>
                    <p className="text-sm text-destructive">{t.has(`payment_errors.${r.lastErrorCode}`) ? t(`payment_errors.${r.lastErrorCode}`) : (r.lastErrorCode ?? "—")} · {t("recovery.failures", { n: r.failures })}</p>
                    <p className="text-xs text-muted-foreground">{[t("recovery.failing_since", { date: date(r.failingSince) }), r.nextRetryAt ? t("recovery.next_retry", { date: date(r.nextRetryAt) }) : t("recovery.no_retry"), t("recovery.last_contact", { date: date(r.lastContactAt) })].join(" · ")}</p>
                  </div>
                  <RecoveryActions slug={tenant} contractId={r.contractId} canWrite={canWrite} members={members} assignedTo={r.assignedTo} canSendLink={caps.canSendPaymentLink} />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default withIntl(RecoveryPage, "app/t/[tenant]/subscriptions/recovery/page.tsx");
