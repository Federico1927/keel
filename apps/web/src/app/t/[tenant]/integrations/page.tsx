import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@keel/config";
import { formatDateTime, formatNumber } from "@keel/core";
import { integrationMode } from "@keel/integrations";
import { integrationOverview } from "@keel/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { ProviderActions, WebhookControls, WebhookRowAction } from "./controls";

const PROVIDERS = ["shopify", "meta", "google"] as const;
const SLOTS = ["messaging", "warehouse", "carrier"] as const;

export default async function IntegrationsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "integrations");
  const t = await getTranslations("integrations");
  const data = await ctx.run((tx) => integrationOverview({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const canManage = canDo(ctx.role, "manage_integrations");
  const globalMock = integrationMode() === "mock";
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const statusVariant = (s: string) => (s === "connected" || s === "ok" ? "success" : s === "error" ? "destructive" : s === "degraded" || s === "syncing" ? "warning" : "muted") as "success" | "destructive" | "warning" | "muted";
  const base = `/t/${tenant}/integrations`;
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={<><Link href={`${base}/tracking`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="tracking-link">{t("tracking")}</Link><Link href={`${base}/guide/shopify`} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t("guides")}</Link></>} />
      {globalMock && (
        <p className="mb-4 rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="mock-banner">{t("global_mock_banner")}</p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {PROVIDERS.map((p) => {
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
                {cfg.missingScopes && cfg.missingScopes.length > 0 && <p className="text-xs text-amber-700">{t("missing_scopes", { scopes: cfg.missingScopes.join(", ") })}</p>}
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
                <ProviderActions slug={tenant} provider={p} connected={connected} mock={mock} canManage={canManage} />
                <p className="text-xs"><Link href={`${base}/guide/${p}`} className="underline-offset-4 hover:underline">{t("open_guide")}</Link></p>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("slots_title")}</CardTitle>
          <CardDescription>{t("slots_description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3 text-sm">
          {SLOTS.map((s) => (
            <div key={s} className="rounded-md border p-3">
              <div className="flex items-center justify-between"><span className="font-medium">{t(`slots.${s}`)}</span><Badge variant="muted">{t("on_request")}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">{t(`slots_hint.${s}`)}</p>
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
                  <TableHead className="text-right">{t("columns.rows")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">{dt(r.startedAt)}</TableCell>
                    <TableCell className="text-xs"><span className="font-mono">{r.provider}/{r.objectType}</span> · {r.kind}{r.error && <div className="truncate text-destructive" title={r.error}>{r.error}</div>}</TableCell>
                    <TableCell><Badge variant={r.status === "success" ? "success" : r.status === "error" ? "destructive" : "warning"}>{t(`run_status.${r.status}`)}</Badge></TableCell>
                    <TableCell className="text-right tabular">{formatNumber(r.rowsWritten, ctx.locale)}</TableCell>
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
    </>
  );
}
