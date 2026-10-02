import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { ACCOUNTING_ADDON, accountingHealth, getAccountingState } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { AccountingConnection } from "@/app/t/[tenant]/accounting/controls";

/**
 * The accounting system card (addon.accounting, #85): status, mode, last success and readable error,
 * health of the pushes, chart of accounts, and the actions (connect, test, resync accounts). Only for
 * tenants with the add-on.
 */
export async function AccountingCard({ ctx, className }: { ctx: TenantContext; className?: string }) {
  if (!ctx.activeAddons.includes(ACCOUNTING_ADDON)) return null;
  const t = await getTranslations("accounting.connection");
  const ti = await getTranslations("integrations");
  const { state, health } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { state: await getAccountingState(s), health: await accountingHealth(s) };
  });
  const row = state.integration;
  const status = row?.status ?? "not_connected";
  const connected = status !== "not_connected";
  const mock = integrationMode() === "mock" || !row || row.mode !== "live";
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const variant = status === "connected" ? "success" : status === "error" ? "destructive" : "muted";
  return (
    <Card data-testid="provider-accounting" className={className ?? "min-w-0"}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{ti("providers.accounting")}</CardTitle>
          <span className="flex gap-1"><Badge variant={variant}>{ti(`status.${status}`)}</Badge><Badge variant="outline">{mock ? ti("mode.mock") : ti("mode.live")}</Badge></span>
        </div>
        <CardDescription>{row?.externalAccountName ?? ti("no_account")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 [&_dd]:break-words">
          <dt className="text-muted-foreground">{ti("last_success")}</dt><dd>{dt(row?.lastSuccessAt)}</dd>
          <dt className="text-muted-foreground">{ti("last_error")}</dt><dd className={row?.lastError ? "text-destructive" : ""} data-testid="accounting-last-error">{row?.lastError ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("accounts")}</dt><dd>{state.accounts.length ? t("accounts_value", { n: formatNumber(state.accounts.length, ctx.locale), at: dt(state.accountsSyncedAt) }) : "—"}</dd>
        </dl>
        {health.length > 0 && (
          <ul className="space-y-1 text-xs">
            {health.map((h) => <li key={h.id} className="flex min-w-0 items-center justify-between gap-2"><span className="shrink-0 font-mono">{h.source}</span><span className="flex min-w-0 items-center justify-end gap-2">{h.lastError && h.status !== "ok" && <span className="min-w-0 truncate text-destructive" title={h.lastError}>{h.lastError}</span>}<Badge variant={h.status === "ok" ? "success" : h.status === "error" || h.status === "stale" ? "destructive" : "warning"}>{ti(`health.${h.status}`)}</Badge></span></li>)}
          </ul>
        )}
        <AccountingConnection slug={ctx.tenant.slug} connected={connected} mock={mock} canManage={canDo(ctx.role, "manage_integrations")} />
        <p className="flex flex-wrap gap-3 text-xs">
          <Link href={`/t/${ctx.tenant.slug}/integrations/guide/accounting`} className="underline-offset-4 hover:underline">{ti("open_guide")}</Link>
          <Link href={`/t/${ctx.tenant.slug}/accounting`} className="underline-offset-4 hover:underline">{t("log_link")}</Link>
          <Link href={`/t/${ctx.tenant.slug}/accounting/settings`} className="underline-offset-4 hover:underline">{t("settings_link")}</Link>
        </p>
      </CardContent>
    </Card>
  );
}
