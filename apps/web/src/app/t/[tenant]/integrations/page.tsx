import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AD_ACCOUNT_LIMIT, adPlatformMinPlan, canDo, isAdPlatform, isAdPlatformInPlan, isPageEnabled } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { SUBSCRIPTION_PROVIDERS, integrationMode } from "@hullwise/integrations";
import { adAccountsOverview, integrationOverview, platformWritesOverview } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, DataList } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { ProviderActions, WebhookControls, WebhookRowAction } from "./controls";
import { GoogleWriteAccessToggle } from "./write-access";
import { MetaAdAccounts } from "./ad-accounts";
import { ProviderControls as SubscriptionProviderControls } from "../subscriptions/controls";
import { SpokiCard } from "@/components/spoki-card";
import { AccountingCard } from "@/components/accounting-card";

const PROVIDERS = ["shopify", "meta", "google", "tiktok", "anthropic", "address"] as const;
/** Per-account integrations activated by the Hullwise team: interface and mock in Hullwise, each with its activation guide. */
const SLOTS = ["messaging", "warehouse", "carrier", "payment_guarantee", "return_labels", "audiences"] as const;

export default async function IntegrationsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "integrations");
  const t = await getTranslations("integrations");
  const tw = await getTranslations("platform_writes");
  const tp = await getTranslations("plans");
  const { data, writes, metaAccounts } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { data: await integrationOverview(s), writes: await platformWritesOverview(s, { limit: 15 }), metaAccounts: await adAccountsOverview(s, "meta") };
  });
  const canManage = canDo(ctx.role, "manage_integrations");
  const globalMock = integrationMode() === "mock";
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const statusVariant = (s: string) => (s === "connected" || s === "ok" ? "success" : s === "error" || s === "stale" ? "destructive" : s === "degraded" || s === "idle" || s === "syncing" ? "warning" : "muted") as "success" | "destructive" | "warning" | "muted";
  const base = `/t/${tenant}/integrations`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<><Link href={`${base}/tracking`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-2.5" data-testid="tracking-link">{t("tracking")}</Link><Link href={`${base}/guide/shopify`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-2.5">{t("guides")}</Link></>} />
      {globalMock && (
        <p className="mb-4 rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="mock-banner">{t("global_mock_banner")}</p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {PROVIDERS.map((p) => {
          // an ad platform outside the plan (TikTok below Growth): a locked card, no actions, no guide
          if (isAdPlatform(p) && !isAdPlatformInPlan(p, ctx.tenant.planKey)) return (
            <Card key={p} data-testid={`provider-${p}`} data-locked="true" className="border-dashed">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{t(`providers.${p}`)}</CardTitle>
                  <Badge variant="muted">{t("not_in_plan_badge")}</Badge>
                </div>
                <CardDescription>{t("not_in_plan", { plan: tp(adPlatformMinPlan(p) ?? "growth") })}</CardDescription>
              </CardHeader>
            </Card>
          );
          const row = data.integrations.find((i) => i.provider === p);
          // a further Meta account's sources (`meta:<account>`) show on the accounts card instead
          const health = data.health.filter((h) => (h.source === p || h.source.startsWith(`${p}:`)) && !metaAccounts.some((a) => !a.isPrimary && h.source.startsWith(`${p}:${a.externalAccountId}`)));
          const connected = !!row && row.status !== "not_connected";
          const mock = globalMock || !row || row.mode !== "live";
          const cfg = (row?.config ?? {}) as { missingScopes?: string[] };
          return (
            <Card key={p} data-testid={`provider-${p}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{t(`providers.${p}`)}</CardTitle>
                  <span className="flex gap-1">
                    <Badge variant={statusVariant(row?.status ?? "not_connected")}>{t(`status.${row?.status ?? "not_connected"}`)}</Badge>
                    <Badge variant="outline">{mock ? t("mode.mock") : t("mode.live")}</Badge>
                  </span>
                </div>
                <CardDescription>{row?.externalAccountName ?? row?.externalAccountId ?? t("no_account")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 [&_dd]:break-words">
                  <dt className="text-muted-foreground">{t("last_sync")}</dt><dd>{dt(row?.lastSyncAt)}</dd>
                  <dt className="text-muted-foreground">{t("last_success")}</dt><dd>{dt(row?.lastSuccessAt)}</dd>
                  <dt className="text-muted-foreground">{t("last_error")}</dt><dd className={row?.lastError ? "text-destructive" : ""}>{row?.lastError ?? "—"}</dd>
                </dl>
                {cfg.missingScopes && cfg.missingScopes.length > 0 && <p className="text-xs text-warning">{t("missing_scopes", { scopes: cfg.missingScopes.join(", ") })}</p>}
                {health.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {health.map((h) => (
                      <li key={h.id} className="flex items-center justify-between gap-2">
                        <span className="font-mono">{h.source}</span>
                        <span className="flex items-center gap-2"><span className="text-muted-foreground">{t("rows_n", { n: formatNumber(h.rowsWrittenLast, ctx.locale) })}</span><Badge variant={statusVariant(h.status)}>{t(`health.${h.status}`)}</Badge></span>
                      </li>
                    ))}
                  </ul>
                )}
                {p === "google" && connected && <GoogleWriteAccessToggle slug={tenant} enabled={(row?.config as { writeAccess?: boolean } | undefined)?.writeAccess === true} canManage={canManage} />}
                <ProviderActions slug={tenant} provider={p} connected={connected} mock={mock} canManage={canManage} />
                <p className="text-xs"><Link href={`${base}/guide/${p}`} className="underline-offset-4 hover:underline">{t("open_guide")}</Link></p>
              </CardContent>
            </Card>
          );
        })}
        <SpokiCard ctx={ctx} />
        <AccountingCard ctx={ctx} />
      </div>
      {metaAccounts.length > 0 && <MetaAdAccounts slug={tenant} limit={AD_ACCOUNT_LIMIT} canManage={canManage} mock={globalMock || data.integrations.find((i) => i.provider === "meta")?.mode !== "live"} accounts={metaAccounts.map((a) => ({ id: a.id, externalId: a.externalAccountId, name: a.name, primary: a.isPrimary, status: a.status, mock: globalMock || a.mode !== "live", lastSync: dt(a.lastSyncAt), lastSuccess: dt(a.lastSuccessAt), lastError: a.lastError, campaigns: a.campaigns }))} />}
      {isPageEnabled("subscriptions", ctx.activeAddons) && (() => {
        // addon.subscriptions (#67): the store's subscription app (one of Shopify Subscriptions, Recharge, Loop)
        const rows = data.integrations.filter((i) => (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(i.provider));
        const row = rows.find((i) => i.status !== "not_connected") ?? rows[0];
        const health = row ? data.health.filter((h) => h.source === row.provider) : [];
        const connected = !!row && row.status !== "not_connected";
        const mock = globalMock || !row || row.mode !== "live";
        return (
          <Card className="mt-6" data-testid="provider-subscriptions">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{t("providers.subscriptions")}</CardTitle>
                <span className="flex gap-1"><Badge variant={statusVariant(row?.status ?? "not_connected")}>{t(`status.${row?.status ?? "not_connected"}`)}</Badge><Badge variant="outline">{mock ? t("mode.mock") : t("mode.live")}</Badge></span>
              </div>
              <CardDescription>{row ? t(`providers.${row.provider}`) : t("no_account")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-6 [&_dd]:break-words">
                <dt className="text-muted-foreground">{t("last_sync")}</dt><dd>{dt(row?.lastSyncAt)}</dd>
                <dt className="text-muted-foreground">{t("last_success")}</dt><dd>{dt(row?.lastSuccessAt)}</dd>
                <dt className="text-muted-foreground">{t("last_error")}</dt><dd className={row?.lastError ? "text-destructive" : ""}>{row?.lastError ?? health[0]?.lastError ?? "—"}</dd>
              </dl>
              {health.map((h) => <p key={h.id} className="flex items-center gap-2 text-xs"><span className="font-mono">{h.source}</span><Badge variant={statusVariant(h.status)}>{t(`health.${h.status}`)}</Badge><span className="text-muted-foreground">{t("rows_n", { n: formatNumber(h.rowsWrittenLast, ctx.locale) })}</span></p>)}
              <SubscriptionProviderControls slug={tenant} connected={connected} mock={mock} provider={row?.provider ?? null} canManage={canManage} />
              <p className="flex gap-3 text-xs"><Link href={`/t/${tenant}/subscriptions`} className="underline-offset-4 hover:underline">{t("open_subscriptions")}</Link><Link href={`${base}/guide/subscriptions`} className="underline-offset-4 hover:underline">{t("open_guide")}</Link></p>
            </CardContent>
          </Card>
        );
      })()}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("slots_title")}</CardTitle>
          <CardDescription>{t("slots_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          {SLOTS.map((s) => (
            <div key={s} className="rounded-md border p-3" data-testid={`slot-${s}`}>
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{t(`slots.${s}`)}</span><Badge variant="muted">{t("on_request")}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">{t(`slots_hint.${s}`)}</p>
              <p className="mt-2 text-xs"><Link href={`${base}/guide/${s}`} className="underline-offset-4 hover:underline">{t("open_guide")}</Link></p>
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("runs_title")}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <DataList
              rows={data.runs}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-testid": "sync-run-row", "data-kind": r.kind, "data-object": r.objectType })}
              columns={[
                { key: "run", header: t("columns.run"), mobile: "title", className: "min-w-0 text-xs max-md:font-normal", cell: (r) => <><span className="font-mono">{r.provider}/{r.objectType}</span> · {t.has(`run_kind.${r.kind}`) ? t(`run_kind.${r.kind}`) : r.kind}{r.error && <div className="truncate text-destructive" title={r.error}>{r.error}</div>}</> },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (r) => <Badge variant={r.status === "success" ? "success" : r.status === "error" ? "destructive" : "warning"}>{t(`run_status.${r.status}`)}</Badge> },
                { key: "when", header: t("columns.when"), mobile: "subtitle", className: "whitespace-nowrap text-xs", cell: (r) => dt(r.startedAt) },
                { key: "scanned", header: t("columns.scanned"), align: "right", className: "tabular", cell: (r) => formatNumber(r.rowsScanned, ctx.locale) },
                { key: "changed", header: t("columns.changed"), align: "right", className: "tabular", cell: (r) => formatNumber(r.rowsWritten, ctx.locale) },
                { key: "conflicts", header: t("columns.conflicts"), align: "right", priority: 2, className: "tabular", cell: (r) => <span className={r.conflicts ? "text-warning" : ""}>{formatNumber(r.conflicts, ctx.locale)}</span> },
                { key: "errors", header: t("columns.errors"), align: "right", priority: 2, className: "tabular", cell: (r) => <span className={r.errorCount ? "text-destructive" : ""}>{formatNumber(r.errorCount, ctx.locale)}</span> },
                { key: "duration", header: t("columns.duration"), align: "right", priority: 3, className: "whitespace-nowrap tabular", cell: (r) => (r.durationMs === null ? "—" : t("duration_s", { s: formatNumber(Math.round(r.durationMs / 100) / 10, ctx.locale) })) },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-col gap-2 space-y-0 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base">{t("webhooks_title")}</CardTitle>
              <CardDescription>{t("webhooks_description", { processed: formatNumber(data.webhookCounts.processed24h, ctx.locale), failed: formatNumber(data.webhookCounts.failed, ctx.locale), pending: formatNumber(data.webhookCounts.pending, ctx.locale) })}</CardDescription>
            </div>
            <WebhookControls slug={tenant} failed={data.webhookCounts.failed + data.webhookCounts.pending} canManage={canManage} />
          </CardHeader>
          <CardContent className="p-0">
            <DataList
              rows={data.webhooks}
              rowKey={(w) => w.id}
              rowProps={() => ({ "data-testid": "webhook-row" })}
              columns={[
                { key: "topic", header: t("columns.topic"), mobile: "title", className: "min-w-0 text-xs max-md:font-normal", cell: (w) => <><span className="font-mono">{w.topic}</span> · <span className="break-all">{w.externalId}</span>{w.lastError && <div className="truncate text-destructive" title={w.lastError}>{w.lastError}</div>}</> },
                { key: "status", header: t("columns.status"), mobile: "badge", cell: (w) => <><Badge variant={w.status === "processed" ? "success" : w.status === "failed" ? "destructive" : "warning"}>{t(`webhook_status.${w.status}`)}</Badge> <span className="text-xs text-muted-foreground">×{w.attempts}</span></> },
                { key: "when", header: t("columns.when"), mobile: "subtitle", className: "whitespace-nowrap text-xs", cell: (w) => dt(w.receivedAt) },
                { key: "action", header: <span className="sr-only">{t("columns.status")}</span>, mobile: "action", align: "right", cell: (w) => w.status !== "processed" && <WebhookRowAction slug={tenant} eventId={w.id} canManage={canManage} /> },
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6" data-testid="platform-writes">
        <CardHeader>
          <CardTitle className="text-base">{tw("title")}</CardTitle>
          <CardDescription>{tw("description", { pending: formatNumber(writes.counts.pending, ctx.locale), failed: formatNumber(writes.counts.failed, ctx.locale), succeeded: formatNumber(writes.counts.succeeded24h, ctx.locale) })}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {writes.rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{tw("empty")}</p>
          ) : (
            <DataList
              rows={writes.rows}
              rowKey={(w) => w.id}
              rowProps={(w) => ({ "data-testid": "platform-write-row", "data-status": w.status, "data-kind": w.kind })}
              columns={[
                {
                  key: "write",
                  header: tw("columns.write"),
                  mobile: "title",
                  className: "min-w-0 text-xs max-md:font-normal",
                  cell: (w) => (
                    <>
                      <span className="font-medium">{tw.has(`kinds.${w.kind.replace(/\./g, "_")}`) ? tw(`kinds.${w.kind.replace(/\./g, "_")}`) : w.kind}</span> <span className="font-mono text-muted-foreground">· {w.provider}</span>
                      {w.mode === "sync" && <span className="text-muted-foreground"> · {tw("immediate")}</span>}
                      <span className="text-muted-foreground"> · {tw("attempts", { n: w.attempts })}</span>
                      {w.status === "pending" && w.attempts > 0 && <span className="text-muted-foreground"> · {tw("next_attempt", { when: dt(w.nextAttemptAt) })}</span>}
                      {w.lastError && w.status !== "succeeded" && <div className="truncate text-destructive" title={w.lastError}>{w.lastError}</div>}
                    </>
                  ),
                },
                { key: "status", header: tw("columns.status"), mobile: "badge", cell: (w) => <PlatformWriteStatus slug={tenant} write={w} showSynced canRetry={canManage} /> },
                { key: "when", header: tw("columns.when"), mobile: "subtitle", className: "whitespace-nowrap text-xs", cell: (w) => dt(w.createdAt) },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
