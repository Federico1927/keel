import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { SPOKI_MODULE } from "@hullwise/addon-spoki";
import { and, eq, schema, sql } from "@hullwise/db";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import type { TenantContext } from "@/server/tenant";
import { spokiWebhookUrl } from "@/server/spoki-webhook";
import { CopyButton } from "@/app/t/[tenant]/cod/queue-extras";
import { SpokiConnection } from "@/app/t/[tenant]/whatsapp/settings/controls";

/**
 * The Spoki integration card (issue #9): status, mode, last success and error, health sources,
 * webhook URL to paste in Spoki, and the actions. Only for tenants with `addon.whatsapp_spoki`.
 */
export async function SpokiCard({ ctx }: { ctx: TenantContext }) {
  if (!ctx.activeAddons.includes(SPOKI_MODULE)) return null;
  const t = await getTranslations("whatsapp.connection");
  const ti = await getTranslations("integrations");
  const { row, health } = await ctx.run(async (tx) => ({
    row: (await tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki"))).limit(1))[0] ?? null,
    health: await tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenant.id), sql`${schema.integrationHealth.source} like 'spoki:%'`)).orderBy(schema.integrationHealth.source),
  }));
  const connected = !!row && row.status !== "not_connected";
  const mock = integrationMode() === "mock" || !row || row.mode !== "live";
  const status = row?.status ?? "not_connected";
  const variant = status === "connected" ? "success" : status === "error" ? "destructive" : "muted";
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const canManage = canDo(ctx.role, "manage_integrations");
  return (
    <Card data-testid="provider-spoki" className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{ti("providers.spoki")}</CardTitle>
          <span className="flex gap-1"><Badge variant={variant}>{ti(`status.${status}`)}</Badge><Badge variant="outline">{mock ? ti("mode.mock") : ti("mode.live")}</Badge></span>
        </div>
        <CardDescription>{row?.externalAccountName ?? ti("no_account")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{ti("last_success")}</dt><dd>{dt(row?.lastSuccessAt)}</dd>
          <dt className="text-muted-foreground">{ti("last_error")}</dt><dd className={row?.lastError ? "text-destructive" : ""}>{row?.lastError ?? "—"}</dd>
        </dl>
        {health.length > 0 && (
          <ul className="space-y-1 text-xs">
            {health.map((h) => <li key={h.id} className="flex items-center justify-between gap-2"><span className="font-mono">{h.source}</span><Badge variant={h.status === "ok" ? "success" : h.status === "error" || h.status === "stale" ? "destructive" : "warning"}>{ti(`health.${h.status}`)}</Badge></li>)}
          </ul>
        )}
        {canManage && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("webhook")}</p>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="spoki-webhook-url">{spokiWebhookUrl(ctx.tenant.id)}</code><CopyButton text={spokiWebhookUrl(ctx.tenant.id)} label={t("copy")} /></div>
          </div>
        )}
        <SpokiConnection slug={ctx.tenant.slug} connected={connected} mock={mock} canManage={canManage} />
        <p className="flex flex-wrap gap-3 text-xs">
          <Link href={`/t/${ctx.tenant.slug}/integrations/guide/spoki`} className="underline-offset-4 hover:underline">{ti("open_guide")}</Link>
          <Link href={`/t/${ctx.tenant.slug}/whatsapp/settings`} className="underline-offset-4 hover:underline">{t("settings_link")}</Link>
        </p>
      </CardContent>
    </Card>
  );
}
