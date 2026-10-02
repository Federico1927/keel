import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ANALYTICS_PLATFORM_MIN_PLAN, GA4_SETUP, canDo, isAnalyticsPlatformInPlan } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { MOCK_GA4_PROPERTY_ID, ga4ServiceAccountEmail, ga4SetupErrorFromText, integrationMode } from "@hullwise/integrations";
import { and, desc, eq, schema } from "@hullwise/db";
import type { TenantContext } from "@/server/tenant";
import { IntegrationSetupError } from "@/components/integration-setup";
import { Ga4Controls } from "./ga4-controls";
import { IntegrationCard, IntegrationSheetStatus } from "@/components/integration-card";

/**
 * The GA4 card (#86) in the shared card structure (#90): status, property, the three meta rows; the
 * sheet holds the last day read, the readable last error, health, last run, property picker and the
 * self-setup. Locked when the plan does not include GA4.
 */
export async function Ga4Card({ ctx, openOnLoad = false }: { ctx: TenantContext; openOnLoad?: boolean }) {
  const t = await getTranslations("ga4.card");
  const ti = await getTranslations("integrations");
  const tp = await getTranslations("plans");
  if (!isAnalyticsPlatformInPlan(ctx.tenant.planKey)) return <IntegrationCard slug={ctx.tenant.slug} data={{ provider: "ga4", title: ti("providers.ga4"), status: "locked", statusLabel: ti("not_in_plan_badge"), modeLabel: null, subtitle: ti("not_in_plan", { plan: tp(ANALYTICS_PLATFORM_MIN_PLAN ?? "growth") }), lastSync: "—", lastSuccess: "—", lastError: null, connected: false, canManage: false, guideHref: null, simulations: [], testable: false, locked: true }} />;
  const { row, health, run } = await ctx.run(async (tx) => ({
    row: (await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4"))).limit(1))[0] ?? null,
    health: (await tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenant.id), eq(schema.integrationHealth.source, "ga4"))).limit(1))[0] ?? null,
    run: (await tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenant.id), eq(schema.syncRuns.provider, "ga4"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1))[0] ?? null,
  }));
  const connected = !!row && row.status !== "not_connected";
  const mock = integrationMode() === "mock" || !row || row.mode !== "live";
  const status = row?.status ?? "not_connected";
  const canManage = canDo(ctx.role, "manage_integrations");
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  // the last error in plain words with its fix (no access, wrong property id, API not reachable, …)
  const setup = connected ? ga4SetupErrorFromText(row?.lastError) : null;
  const cfg = (row?.config ?? {}) as { clientEmail?: string | null; auth?: string; serviceAccountEmail?: string | null };
  const email = ga4ServiceAccountEmail();
  const cursor = (run?.cursor ?? {}) as { window?: number; since?: string; until?: string };
  const sheet = (
    <>
      {connected && (
        <IntegrationSheetStatus
          rows={[
            { label: t("property"), value: t("property_line", { name: row?.externalAccountName ?? "—", id: row?.externalAccountId ?? "—" }) },
            { label: t("last_day"), value: health?.lastMetricDate ?? "—", testId: "ga4-last-day" },
            ...((cfg.clientEmail || cfg.auth === "platform") ? [{ label: t("service_account"), value: cfg.clientEmail ?? cfg.serviceAccountEmail ?? email ?? "—" }] : []),
            { label: ti("last_success"), value: dt(row?.lastSuccessAt) },
            { label: ti("last_error"), value: row?.lastError ?? "—", testId: "ga4-last-error", tone: row?.lastError ? ("error" as const) : undefined },
          ]}
          health={health ? [{ source: "ga4", status: health.status, statusLabel: ti(`health.${health.status}`) }] : []}
          actions={canManage ? ["resync", "disconnect"] : []}
        >
          {setup && <IntegrationSetupError guide={GA4_SETUP} code={setup} values={{ email: email ?? "", serviceAccountEmail: email ?? "" }} />}
          {run && <p className="text-xs text-muted-foreground" data-testid="ga4-last-run">{t("last_run", { kind: t(`kind.${run.kind}`), status: ti(`run_status.${run.status}`), rows: formatNumber(run.rowsWritten, ctx.locale), since: cursor.since ?? "—", until: cursor.until ?? "—" })}</p>}
          <p className="text-xs"><Link href={`/t/${ctx.tenant.slug}/analytics?tab=traffic`} className="underline-offset-4 hover:underline" data-testid="ga4-open-analytics">{t("open_analytics")}</Link></p>
        </IntegrationSheetStatus>
      )}
      <Ga4Controls slug={ctx.tenant.slug} connected={connected} mock={mock} canManage={canManage} propertyId={row?.externalAccountId ?? null} email={email} demoPropertyId={integrationMode() === "mock" ? MOCK_GA4_PROPERTY_ID : null} />
    </>
  );
  return <IntegrationCard slug={ctx.tenant.slug} sheet={sheet} data={{ provider: "ga4", title: ti("providers.ga4"), status, statusLabel: ti(`status.${status}`), modeLabel: mock ? ti("mode.mock") : ti("mode.live"), subtitle: connected ? t("property_line", { name: row?.externalAccountName ?? "—", id: row?.externalAccountId ?? "—" }) : t("not_connected_description"), lastSync: dt(row?.lastSyncAt), lastSuccess: dt(row?.lastSuccessAt), lastError: row?.lastError ?? null, connected, canManage, guideHref: `/t/${ctx.tenant.slug}/integrations/guide/ga4`, simulations: [], testable: connected && canManage, openOnLoad }} />;
}
