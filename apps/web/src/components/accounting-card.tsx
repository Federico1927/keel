import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { ACCOUNTING_ADDON, accountingHealth, getAccountingState } from "@hullwise/services";
import type { TenantContext } from "@/server/tenant";
import { CARD_SIMULATIONS } from "@/server/integration-setup";
import { AccountingConnection } from "@/app/t/[tenant]/accounting/controls";
import { IntegrationCard, IntegrationSheetStatus } from "@/components/integration-card";

/**
 * The accounting system card (addon.accounting, #85) in the shared card structure (#90): status,
 * system, the three meta rows, Test connection on the card; the sheet holds the chart of accounts,
 * the health of the pushes, Resync and the connect path. Only for tenants with the add-on.
 */
export async function AccountingCard({ ctx }: { ctx: TenantContext }) {
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
  const canManage = canDo(ctx.role, "manage_integrations");
  const slug = ctx.tenant.slug;
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const sheet = (
    <>
      {connected && (
        <IntegrationSheetStatus
          rows={[{ label: ti("card.account"), value: row?.externalAccountName ?? ti("no_account") }, { label: ti("last_success"), value: dt(row?.lastSuccessAt) }, { label: ti("last_error"), value: row?.lastError ?? "—", testId: "accounting-last-error", tone: row?.lastError ? "error" : undefined }, { label: t("accounts"), value: state.accounts.length ? t("accounts_value", { n: formatNumber(state.accounts.length, ctx.locale), at: dt(state.accountsSyncedAt) }) : "—" }]}
          health={health.map((h) => ({ source: h.source, status: h.status, statusLabel: ti(`health.${h.status}`), detail: h.status !== "ok" ? h.lastError : null }))}
          actions={canManage ? ["resync"] : []}
        >
          <p className="flex flex-wrap gap-3 text-xs">
            <Link href={`/t/${slug}/accounting`} className="underline-offset-4 hover:underline">{t("log_link")}</Link>
            <Link href={`/t/${slug}/accounting/settings`} className="underline-offset-4 hover:underline">{t("settings_link")}</Link>
          </p>
        </IntegrationSheetStatus>
      )}
      {!connected && <AccountingConnection slug={slug} mock={mock} canManage={canManage} />}
    </>
  );
  return <IntegrationCard slug={slug} sheet={sheet} data={{ provider: "accounting", title: ti("providers.accounting"), status, statusLabel: ti(`status.${status}`), modeLabel: mock ? ti("mode.mock") : ti("mode.live"), subtitle: connected ? (row?.externalAccountName ?? ti("no_account")) : ti("about.accounting"), lastSync: dt(row?.lastSyncAt), lastSuccess: dt(row?.lastSuccessAt), lastError: row?.lastError ?? null, connected, canManage, guideHref: `/t/${slug}/integrations/guide/accounting`, simulations: connected && mock ? (CARD_SIMULATIONS.accounting ?? []) : [], testable: connected && canManage }} />;
}
