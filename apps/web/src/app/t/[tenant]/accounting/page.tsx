import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { ACCOUNTING_LOG_STATUSES, accountingPushLog, getAccountingState } from "@hullwise/services";
import { Badge, Card, CardContent, DataList, EmptyState, PageHeader, Pagination, Stat, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { dayLabel } from "../analytics/daily-sales/shared";
import { DayActions, RunNowButton } from "./controls";
import { STATUS_VARIANT, reasonText } from "./shared";

/**
 * Push log of addon.accounting (#85): one row per day and journal version, newest first, with the
 * reasons a day waits, the error of a failed push and its next attempt, retry and re-push.
 * `requirePage` answers 404 when the add-on is off or the role cannot open it.
 */
export default async function AccountingLogPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "accounting");
  const t = await getTranslations("accounting");
  const status = (ACCOUNTING_LOG_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status : undefined;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const { log, state } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { log: await accountingPushLog(s, { status, page }), state: await getAccountingState(s) };
  });
  const canWrite = canWritePage(ctx.role, "accounting");
  const money = (m: number | null) => (m === null ? "—" : formatMoney(m, ctx.tenant.currency, ctx.locale));
  const dt = (d: Date | null) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const day = (d: string) => dayLabel(d, ctx.locale);
  const base = `/t/${tenant}/accounting`;
  const href = (p: Record<string, string | undefined>) => `${base}?${new URLSearchParams(Object.entries({ status, ...p }).filter((e): e is [string, string] => Boolean(e[1])))}`;
  const connected = !!state.integration && state.integration.status !== "not_connected";
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("log.title")} description={t("log.description")} actions={<div className="flex flex-wrap items-start gap-2">{canWrite && connected && <RunNowButton slug={tenant} />}<Link href={`${base}/settings`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-2.5" data-testid="accounting-settings-link">{t("log.settings_link")}</Link></div>} />
      {!connected && <p className="mb-4 rounded-md border border-dashed bg-muted/40 p-3 text-sm" data-testid="accounting-not-connected">{t("log.not_connected")} <Link href={`${base}/settings`} className="font-medium underline-offset-4 hover:underline">{t("log.settings_link")}</Link></p>}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="accounting-counts">
        {(["pushed", "waiting", "failed", "empty"] as const).map((k) => <Stat key={k} label={t(`statuses.${k}`)} value={formatNumber(log.counts[k] ?? 0, ctx.locale)} href={href({ status: k, page: undefined })} />)}
        <Stat label={t("log.last_pushed")} value={log.lastPushedDay ? day(log.lastPushedDay) : "—"} />
      </div>
      <nav className="mb-4 flex gap-1 overflow-x-auto text-sm" aria-label={t("log.filter")} data-testid="accounting-filters">
        {[undefined, ...ACCOUNTING_LOG_STATUSES].map((s) => (
          <Link key={s ?? "all"} href={href({ status: s, page: undefined })} aria-current={status === s ? "page" : undefined} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs pointer-coarse:py-2", status === s ? "bg-primary text-primary-foreground" : "bg-card")}>{s ? t(`statuses.${s}`) : t("log.all")}</Link>
        ))}
      </nav>
      {log.rows.length === 0 ? (
        <EmptyState title={status ? t("log.empty_filtered") : t("log.empty")} description={status ? undefined : t("log.empty_hint")} />
      ) : (
        <Card className="min-w-0">
          <CardContent className="p-0">
            <DataList
              data-testid="accounting-log"
              rows={log.rows}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-testid": "accounting-row", "data-day": r.day, "data-status": r.status, "data-version": String(r.version), className: r.current ? undefined : "text-muted-foreground" })}
              columns={[
                { key: "day", header: t("log.columns.day"), mobile: "title", className: "whitespace-nowrap", cell: (r) => <Link href={`${base}/${r.day}`} className="font-medium text-primary hover:underline">{day(r.day)}</Link> },
                { key: "status", header: t("log.columns.status"), mobile: "badge", cell: (r) => <span className="flex items-center gap-1"><Badge variant={STATUS_VARIANT[r.status] ?? "muted"}>{t(`statuses.${r.status}`)}</Badge>{r.version > 1 || !r.current ? <span className="text-xs text-muted-foreground">v{r.version}</span> : null}</span> },
                {
                  key: "detail",
                  header: t("log.columns.detail"),
                  mobile: "subtitle",
                  className: "min-w-0 text-xs",
                  cell: (r) => (
                    <div className="space-y-0.5" data-testid="accounting-detail">
                      {r.reasons.map((x, i) => <p key={i} className="text-warning">{reasonText(t, x, { locale: ctx.locale, timezone: ctx.tenant.timezone, currency: ctx.tenant.currency, day })}</p>)}
                      {r.status === "failed" && r.lastError && <p className="text-destructive">{r.lastError}</p>}
                      {r.status === "failed" && <p className="text-muted-foreground">{t("log.next_attempt", { at: dt(r.nextAttemptAt), n: r.attempts })}</p>}
                      {r.status === "pushed" && <p className="text-muted-foreground">{t("log.pushed_at", { at: dt(r.pushedAt), id: r.externalId ?? "" })}</p>}
                      {r.status === "voided" && <p className="text-muted-foreground">{t("log.voided_at", { at: dt(r.voidedAt) })}</p>}
                      {r.status === "empty" && <p className="text-muted-foreground">{t("log.empty_day")}</p>}
                    </div>
                  ),
                },
                { key: "total", header: t("log.columns.total"), align: "right", className: "tabular", cell: (r) => money(r.totalMinor) },
                { key: "net", header: t("log.columns.net"), align: "right", priority: 2, className: "tabular", cell: (r) => money(r.netMinor) },
                { key: "debit", header: t("log.columns.debit"), align: "right", priority: 3, className: "tabular", cell: (r) => money(r.debitMinor) },
                { key: "action", header: <span className="sr-only">{t("log.columns.action")}</span>, mobile: "action", align: "right", cell: (r) => canWrite && connected && r.current ? <DayActions slug={tenant} day={r.day} dayLabel={day(r.day)} status={r.status} version={r.version} /> : null },
              ]}
            />
          </CardContent>
        </Card>
      )}
      <Pagination className="mt-4" page={log.page} pageSize={log.pageSize} total={log.total} hrefFor={(p) => href({ page: String(p) })} summary={t("log.summary", { n: log.total })} />
    </>
  );
}
