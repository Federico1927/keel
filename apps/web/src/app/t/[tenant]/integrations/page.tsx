import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adPlatformMinPlan, canDo, isAdPlatform, isAdPlatformInPlan, isPageEnabled } from "@hullwise/config";
import { formatDate, formatDateTime, formatNumber } from "@hullwise/core";
import { SUBSCRIPTION_PROVIDERS, integrationMode } from "@hullwise/integrations";
import { integrationOverview, platformWritesOverview } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { PlatformWriteStatus } from "@/components/platform-write-status";
import { ProviderActions, WebhookControls, WebhookRowAction } from "./controls";
import { GoogleWriteAccessToggle } from "./write-access";
import { ProviderControls as SubscriptionProviderControls } from "../subscriptions/controls";

const PROVIDERS = ["shopify", "meta", "google", "tiktok", "anthropic", "address"] as const;
/** Per-account integrations activated by the Hullwise team: interface and mock in Hullwise, each with its activation guide. */
const SLOTS = ["messaging", "warehouse", "carrier", "payment_guarantee", "return_labels", "audiences"] as const;

export default async function IntegrationsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "integrations");
  const t = await getTranslations("integrations");
  const tw = await getTranslations("platform_writes");
  const tp = await getTranslations("plans");
  const { data, writes } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { data: await integrationOverview(s), writes: await platformWritesOverview(s, { limit: 15 }) };
  });
  const canManage = canDo(ctx.role, "manage_integrations");
  const globalMock = integrationMode() === "mock";
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const statusVariant = (s: string) => (s === "connected" || s === "ok" ? "success" : s === "error" || s === "stale" ? "destructive" : s === "degraded" || s === "idle" || s === "syncing" ? "warning" : "muted") as "success" | "destructive" | "warning" | "muted";
  const base = `/t/${tenant}/integrations`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<><Link href={`${base}/tracking`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tracking-link">{t("tracking")}</Link><Link href={`${base}/guide/shopify`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t("guides")}</Link></>} />
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
          const health = data.health.filter((h) => h.source === p || h.source.startsWith(`${p}:`));
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
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
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
                {p === "shopify" && data.historyImport.state !== "not_started" && (() => {
                  // the first import of the store's order history (issue #87)
                  const h = data.historyImport;
                  const day = (d: Date | null) => (d ? formatDate(d, ctx.locale, ctx.tenant.timezone) : "—");
                  return (
                    <div className="space-y-1 rounded-md border p-2 text-xs" data-testid="history-import" data-state={h.state}>
                      <p className="flex items-center justify-between gap-2"><span className="font-medium">{t("history_import.title")}</span><Badge variant={h.state === "done" ? "success" : h.state === "error" ? "destructive" : "warning"}>{t(`history_import.state.${h.state}`)}</Badge></p>
                      <p className="text-muted-foreground">{t("history_import.detail", { n: formatNumber(h.ordersImported, ctx.locale), since: h.since ? day(h.since) : t("history_import.all_orders"), oldest: day(h.oldestOrderAt) })}</p>
                      {h.state !== "done" && <p className="text-muted-foreground">{t("history_import.incomplete_hint")}</p>}
                      {h.error && <p className="text-destructive">{h.error}</p>}
                    </div>
                  );
                })()}
                {p === "google" && connected && <GoogleWriteAccessToggle slug={tenant} enabled={(row?.config as { writeAccess?: boolean } | undefined)?.writeAccess === true} canManage={canManage} />}
                <ProviderActions slug={tenant} provider={p} connected={connected} mock={mock} canManage={canManage} />
                <p className="text-xs"><Link href={`${base}/guide/${p}`} className="underline-offset-4 hover:underline">{t("open_guide")}</Link></p>
              </CardContent>
            </Card>
          );
        })}
      </div>
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
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-6">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.when")}</TableHead>
                  <TableHead>{t("columns.run")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("columns.scanned")}</TableHead>
                  <TableHead className="text-right">{t("columns.changed")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.conflicts")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("columns.errors")}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t("columns.duration")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.runs.map((r) => (
                  <TableRow key={r.id} data-testid="sync-run-row" data-kind={r.kind} data-object={r.objectType}>
                    <TableCell className="whitespace-nowrap text-xs">{dt(r.startedAt)}</TableCell>
                    <TableCell className="text-xs"><span className="font-mono">{r.provider}/{r.objectType}</span> · {t.has(`run_kind.${r.kind}`) ? t(`run_kind.${r.kind}`) : r.kind}{r.error && <div className="truncate text-destructive" title={r.error}>{r.error}</div>}</TableCell>
                    <TableCell><Badge variant={r.status === "success" ? "success" : r.status === "error" ? "destructive" : "warning"}>{t(`run_status.${r.status}`)}</Badge></TableCell>
                    <TableCell className="hidden text-right tabular sm:table-cell">{formatNumber(r.rowsScanned, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.rowsWritten, ctx.locale)}</TableCell>
                    <TableCell className={`hidden text-right tabular md:table-cell ${r.conflicts ? "text-warning" : ""}`}>{formatNumber(r.conflicts, ctx.locale)}</TableCell>
                    <TableCell className={`hidden text-right tabular md:table-cell ${r.errorCount ? "text-destructive" : ""}`}>{formatNumber(r.errorCount, ctx.locale)}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-right tabular sm:table-cell">{r.durationMs === null ? "—" : t("duration_s", { s: formatNumber(Math.round(r.durationMs / 100) / 10, ctx.locale) })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">{t("webhooks_title")}</CardTitle>
              <CardDescription>{t("webhooks_description", { processed: formatNumber(data.webhookCounts.processed24h, ctx.locale), failed: formatNumber(data.webhookCounts.failed, ctx.locale), pending: formatNumber(data.webhookCounts.pending, ctx.locale) })}</CardDescription>
            </div>
            <WebhookControls slug={tenant} failed={data.webhookCounts.failed + data.webhookCounts.pending} canManage={canManage} />
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.when")}</TableHead>
                  <TableHead>{t("columns.topic")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.webhooks.map((w) => (
                  <TableRow key={w.id} data-testid="webhook-row">
                    <TableCell className="whitespace-nowrap text-xs">{dt(w.receivedAt)}</TableCell>
                    <TableCell className="text-xs"><span className="font-mono">{w.topic}</span> · {w.externalId}{w.lastError && <div className="truncate text-destructive" title={w.lastError}>{w.lastError}</div>}</TableCell>
                    <TableCell><Badge variant={w.status === "processed" ? "success" : w.status === "failed" ? "destructive" : "warning"}>{t(`webhook_status.${w.status}`)}</Badge> <span className="text-xs text-muted-foreground">×{w.attempts}</span></TableCell>
                    <TableCell className="text-right">{w.status !== "processed" && <WebhookRowAction slug={tenant} eventId={w.id} canManage={canManage} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tw("columns.when")}</TableHead>
                  <TableHead>{tw("columns.write")}</TableHead>
                  <TableHead>{tw("columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {writes.rows.map((w) => (
                  <TableRow key={w.id} data-testid="platform-write-row" data-status={w.status} data-kind={w.kind}>
                    <TableCell className="whitespace-nowrap text-xs">{dt(w.createdAt)}</TableCell>
                    <TableCell className="text-xs">
                      <span className="font-medium">{tw.has(`kinds.${w.kind.replace(/\./g, "_")}`) ? tw(`kinds.${w.kind.replace(/\./g, "_")}`) : w.kind}</span> <span className="font-mono text-muted-foreground">· {w.provider}</span>
                      {w.mode === "sync" && <span className="text-muted-foreground"> · {tw("immediate")}</span>}
                      <span className="text-muted-foreground"> · {tw("attempts", { n: w.attempts })}</span>
                      {w.status === "pending" && w.attempts > 0 && <span className="text-muted-foreground"> · {tw("next_attempt", { when: dt(w.nextAttemptAt) })}</span>}
                      {w.lastError && w.status !== "succeeded" && <div className="truncate text-destructive" title={w.lastError}>{w.lastError}</div>}
                    </TableCell>
                    <TableCell><PlatformWriteStatus slug={tenant} write={w} showSynced canRetry={canManage} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
