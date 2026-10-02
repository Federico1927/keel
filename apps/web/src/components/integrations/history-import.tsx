import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, formatNumber } from "@hullwise/core";
import { historyImportStatus, type HistoryImportStatus } from "@hullwise/services";
import type { TenantContext } from "@/server/tenant";
import { Badge } from "@hullwise/ui";

const VARIANT = { not_started: "muted", running: "warning", paused: "warning", done: "success", error: "destructive" } as const;

/** History import progress (#87): state, orders imported, oldest order, window; `action` renders next to it (Continue import). */
export async function HistoryImportProgress({ status, locale, timezone, action }: { status: HistoryImportStatus; locale: string; timezone: string; action?: React.ReactNode }) {
  const t = await getTranslations("history_import");
  return (
    <div className="space-y-2 rounded-md border p-3 text-xs" data-testid="history-import" data-state={status.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t("title")}</span>
        <Badge variant={VARIANT[status.state]} data-testid="history-import-state">{t(`state.${status.state}`)}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("orders_imported")}</dt><dd className="tabular" data-testid="history-import-orders">{formatNumber(status.ordersImported, locale)}</dd>
        <dt className="text-muted-foreground">{t("oldest_order")}</dt><dd>{status.oldestOrderAt ? formatDate(status.oldestOrderAt, locale, timezone) : "—"}</dd>
        <dt className="text-muted-foreground">{t("window")}</dt><dd>{status.months ? t("window_months", { n: status.months }) : t("window_all")}</dd>
      </dl>
      {status.error && <p className="text-destructive" data-testid="history-import-error">{t("failed", { error: status.error })}</p>}
      {status.state === "paused" && <p className="text-muted-foreground">{t("paused_hint")}</p>}
      {action}
    </div>
  );
}

/** Dashboard banner while the history import runs: numbers before its end are partial. */
export async function HistoryImportBanner({ status, slug, locale }: { status: HistoryImportStatus; slug: string; locale: string }) {
  if (!status.inProgress) return null;
  const t = await getTranslations("history_import");
  return (
    <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="history-import-banner" role="status">
      {t("banner", { n: formatNumber(status.ordersImported, locale) })} <Link href={`/t/${slug}/integrations`} className="underline underline-offset-4">{t("banner_link")}</Link>
    </p>
  );
}

/** The banner for a tenant page: reads the import status in the tenant's transaction. */
export async function TenantHistoryImportBanner({ ctx }: { ctx: TenantContext }) {
  const status = await ctx.run((tx) => historyImportStatus({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  return <HistoryImportBanner status={status} slug={ctx.tenant.slug} locale={ctx.locale} />;
}
