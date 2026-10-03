import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDateTime, formatMoney, type AccountingWaitReason, type DailyJournal } from "@hullwise/core";
import { accountingJournalDetail, accountingReconciliation, getAccountingState } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, EmptyState, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant } from "@/server/analytics";
import { dayHref, dayLabel, rateText } from "../../analytics/daily-sales/shared";
import { DayActions } from "../controls";
import { STATUS_VARIANT, reasonText } from "../shared";

import { withIntl } from "@/i18n/intl-scope";
/** One day of the push log (#85): every journal version with its lines, as pushed (or as it would be pushed). */
async function AccountingDayPage({ params }: { params: Promise<{ tenant: string; day: string }> }) {
  const { tenant, day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) notFound();
  const ctx = await requirePage(tenant, "accounting");
  const t = await getTranslations("accounting");
  const tds = await getTranslations("daily_sales");
  const rate = (k: string) => rateText(k, ctx.locale, (v) => tds("rate_label", v));
  const { rows, state, recon } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { rows: await accountingJournalDetail(s, day), state: await getAccountingState(s), recon: await accountingReconciliation(s, analyticsTenant(ctx), { days: [day] }) };
  });
  const money = (m: number) => formatMoney(m, ctx.tenant.currency, ctx.locale);
  const dt = (d: Date | null) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const label = dayLabel(day, ctx.locale, { dateStyle: "full" });
  const connected = !!state.integration && state.integration.status !== "not_connected";
  const drift = recon.drifts[0] ?? null;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/accounting`} className="hover:underline">← {t("log.title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("day.title", { day: label })} description={t("day.description")} actions={<Link href={dayHref(tenant, day)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-2.5">{t("day.summary_link")}</Link>} />
      {drift && (
        <Card className="mb-6 min-w-0 border-warning" data-testid="journal-drift">
          <CardHeader>
            <CardTitle className="text-base">{t("reconcile.day_title")}</CardTitle>
            <CardDescription>{t("reconcile.day_description", { version: drift.version, difference: `${drift.differenceMinor > 0 ? "+" : ""}${money(drift.differenceMinor)}` })}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <DataList
              rows={drift.lines}
              rowKey={(l) => `${l.line}|${l.rateKey ?? ""}|${l.accountCode}`}
              columns={[
                { key: "account", header: t("day.columns.account"), mobile: "title", className: "font-mono", cell: (l) => l.accountCode },
                { key: "line", header: t("day.columns.description"), mobile: "subtitle", cell: (l) => `${t(`settings.lines.${l.line}`)}${l.rateKey ? ` · ${rate(l.rateKey)}` : ""}` },
                { key: "pushed", header: t("reconcile.columns.pushed"), align: "right", className: "tabular", cell: (l) => money(Math.abs(l.pushedMinor)) },
                { key: "now", header: t("reconcile.columns.now"), align: "right", className: "tabular font-medium", cell: (l) => money(Math.abs(l.currentMinor)) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      {rows.length === 0 ? <EmptyState title={t("day.empty")} /> : (
        <div className="space-y-6">
          {rows.map((r, i) => {
            const j = r.journal as Partial<DailyJournal>;
            return (
              <Card key={r.id} className="min-w-0" data-testid="journal-version" data-status={r.status}>
                <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">{t("day.version", { v: r.version })}<Badge variant={STATUS_VARIANT[r.status] ?? "muted"}>{t(`statuses.${r.status}`)}</Badge></CardTitle>
                    <CardDescription className="break-words">{j.reference ?? ""}{r.externalId ? ` · ${r.externalId}` : ""}{r.pushedAt ? ` · ${t("log.pushed_at", { at: dt(r.pushedAt), id: "" })}` : ""}{r.note ? ` · ${r.note}` : ""}</CardDescription>
                    {(r.reasons as AccountingWaitReason[]).map((x, k) => <p key={k} className="mt-1 text-xs text-warning">{reasonText(t, x, { locale: ctx.locale, timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, day: (d) => dayLabel(d, ctx.locale), rate })}</p>)}
                    {r.status === "failed" && r.lastError && <p className="mt-1 text-xs text-destructive">{r.lastError}</p>}
                  </div>
                  {i === 0 && canWritePage(ctx.role, "accounting") && connected && <DayActions slug={tenant} day={day} dayLabel={dayLabel(day, ctx.locale)} status={r.status} version={r.version} />}
                </CardHeader>
                <CardContent className="p-0">
                  {(j.lines ?? []).length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("log.empty_day")}</p> : (
                    <DataList
                      data-testid="journal-lines"
                      rows={j.lines ?? []}
                      rowKey={(l, k) => `${k}`}
                      columns={[
                        { key: "account", header: t("day.columns.account"), mobile: "title", className: "font-mono", cell: (l) => l.accountCode },
                        { key: "description", header: t("day.columns.description"), mobile: "subtitle", cell: (l) => (t.has(`settings.lines.${l.line}`) ? `${t(`settings.lines.${l.line}`)}${l.rateKey ? ` · ${rate(l.rateKey)}` : ""}` : l.description) },
                        { key: "debit", header: t("day.columns.debit"), align: "right", className: "tabular", cell: (l) => (l.debitMinor ? money(l.debitMinor) : "") },
                        { key: "credit", header: t("day.columns.credit"), align: "right", className: "tabular", cell: (l) => (l.creditMinor ? money(l.creditMinor) : "") },
                      ]}
                      footer={{ account: t("day.totals"), debit: money(r.debitMinor), credit: money(r.creditMinor) }}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

export default withIntl(AccountingDayPage, "app/t/[tenant]/accounting/[day]/page.tsx");
