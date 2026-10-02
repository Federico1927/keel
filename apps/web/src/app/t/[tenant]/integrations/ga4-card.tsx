import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ANALYTICS_PLATFORM_MIN_PLAN, GA4_SETUP, canDo, isAnalyticsPlatformInPlan } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { MOCK_GA4_PROPERTY_ID, ga4ServiceAccountEmail, ga4SetupErrorFromText, integrationMode } from "@hullwise/integrations";
import { and, desc, eq, schema } from "@hullwise/db";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { IntegrationSetupError } from "@/components/integration-setup";
import { Ga4Controls } from "./ga4-controls";

/**
 * The GA4 card (#86): status and mode, property, last success and error with a readable hint, the
 * health source and the last runs (backfill progress), and the actions. Locked when the plan does not include GA4.
 */
export async function Ga4Card({ ctx }: { ctx: TenantContext }) {
  const t = await getTranslations("ga4.card");
  const ti = await getTranslations("integrations");
  const tp = await getTranslations("plans");
  if (!isAnalyticsPlatformInPlan(ctx.tenant.planKey)) return (
    <Card data-testid="provider-ga4" data-locked="true" className="border-dashed">
      <CardHeader>
        <div className="flex items-center justify-between gap-2"><CardTitle className="text-base">{ti("providers.ga4")}</CardTitle><Badge variant="muted">{ti("not_in_plan_badge")}</Badge></div>
        <CardDescription>{ti("not_in_plan", { plan: tp(ANALYTICS_PLATFORM_MIN_PLAN ?? "growth") })}</CardDescription>
      </CardHeader>
    </Card>
  );
  const { row, health, run } = await ctx.run(async (tx) => ({
    row: (await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "ga4"))).limit(1))[0] ?? null,
    health: (await tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenant.id), eq(schema.integrationHealth.source, "ga4"))).limit(1))[0] ?? null,
    run: (await tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenant.id), eq(schema.syncRuns.provider, "ga4"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1))[0] ?? null,
  }));
  const connected = !!row && row.status !== "not_connected";
  const mock = integrationMode() === "mock" || !row || row.mode !== "live";
  const status = row?.status ?? "not_connected";
  const variant = status === "connected" ? "success" : status === "error" ? "destructive" : "muted";
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  // the last error in plain words with its fix (no access, wrong property id, API not reachable, …)
  const setup = connected ? ga4SetupErrorFromText(row?.lastError) : null;
  const cfg = (row?.config ?? {}) as { clientEmail?: string | null; auth?: string; serviceAccountEmail?: string | null };
  const email = ga4ServiceAccountEmail();
  const cursor = (run?.cursor ?? {}) as { window?: number; since?: string; until?: string };
  return (
    <Card data-testid="provider-ga4" className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{ti("providers.ga4")}</CardTitle>
          <span className="flex gap-1"><Badge variant={variant} data-testid="ga4-status">{ti(`status.${status}`)}</Badge><Badge variant="outline">{mock ? ti("mode.mock") : ti("mode.live")}</Badge></span>
        </div>
        <CardDescription>{connected ? t("property_line", { name: row?.externalAccountName ?? "—", id: row?.externalAccountId ?? "—" }) : t("not_connected_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 [&_dd]:break-words">
          <dt className="text-muted-foreground">{ti("last_success")}</dt><dd>{dt(row?.lastSuccessAt)}</dd>
          <dt className="text-muted-foreground">{t("last_day")}</dt><dd data-testid="ga4-last-day">{health?.lastMetricDate ?? "—"}</dd>
          {connected && (cfg.clientEmail || cfg.auth === "platform") && <><dt className="text-muted-foreground">{t("service_account")}</dt><dd className="font-mono text-xs">{cfg.clientEmail ?? cfg.serviceAccountEmail ?? email ?? "—"}</dd></>}
          <dt className="text-muted-foreground">{ti("last_error")}</dt><dd className={row?.lastError ? "text-destructive" : ""} data-testid="ga4-last-error">{row?.lastError ?? "—"}</dd>
        </dl>
        {setup && <IntegrationSetupError guide={GA4_SETUP} code={setup} values={{ email: email ?? "", serviceAccountEmail: email ?? "" }} />}
        {run && (
          <p className="text-xs text-muted-foreground" data-testid="ga4-last-run">
            {t("last_run", { kind: t(`kind.${run.kind}`), status: ti(`run_status.${run.status}`), rows: formatNumber(run.rowsWritten, ctx.locale), since: cursor.since ?? "—", until: cursor.until ?? "—" })}
          </p>
        )}
        {health && <p className="flex items-center gap-2 text-xs"><span className="font-mono">ga4</span><Badge variant={health.status === "ok" ? "success" : health.status === "error" || health.status === "stale" ? "destructive" : "warning"}>{ti(`health.${health.status}`)}</Badge></p>}
        <Ga4Controls slug={ctx.tenant.slug} connected={connected} mock={mock} canManage={canDo(ctx.role, "manage_integrations")} propertyId={row?.externalAccountId ?? null} email={email} demoPropertyId={integrationMode() === "mock" ? MOCK_GA4_PROPERTY_ID : null} />
        <p className="flex flex-wrap gap-3 text-xs">
          <Link href={`/t/${ctx.tenant.slug}/integrations/guide/ga4`} className="underline-offset-4 hover:underline">{ti("open_guide")}</Link>
          {connected && <Link href={`/t/${ctx.tenant.slug}/analytics?tab=traffic`} className="underline-offset-4 hover:underline" data-testid="ga4-open-analytics">{t("open_analytics")}</Link>}
        </p>
      </CardContent>
    </Card>
  );
}
