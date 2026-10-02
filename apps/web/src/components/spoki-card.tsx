import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SPOKI_SETUP, canDo } from "@hullwise/config";
import { formatDateTime } from "@hullwise/core";
import { integrationMode } from "@hullwise/integrations";
import { SPOKI_MODULE } from "@hullwise/addon-spoki";
import { and, eq, schema, sql } from "@hullwise/db";
import type { TenantContext } from "@/server/tenant";
import { spokiWebhookUrl } from "@/server/spoki-webhook";
import { mockSetupTriggers, resolveSetupValues } from "@/server/integration-setup";
import { CopyButton } from "@/app/t/[tenant]/cod/queue-extras";
import { SpokiConnection } from "@/app/t/[tenant]/whatsapp/settings/controls";
import { IntegrationCard, IntegrationSheetStatus } from "@/components/integration-card";

/**
 * The Spoki integration card (issue #9) in the shared card structure (#90): status, account, the three
 * meta rows; the sheet holds the webhook URL to paste in Spoki, the health sources, Resync and
 * Disconnect, and the self-setup. Only for tenants with `addon.whatsapp_spoki`.
 */
export async function SpokiCard({ ctx, openOnLoad = false }: { ctx: TenantContext; openOnLoad?: boolean }) {
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
  const dt = (d: Date | null | undefined) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : "—");
  const canManage = canDo(ctx.role, "manage_integrations");
  const slug = ctx.tenant.slug;
  const sheet = (
    <>
      {connected && (
        <IntegrationSheetStatus rows={[{ label: ti("card.account"), value: row?.externalAccountName ?? ti("no_account") }, { label: ti("last_success"), value: dt(row?.lastSuccessAt) }, { label: ti("last_error"), value: row?.lastError ?? "—", tone: row?.lastError ? "error" : undefined }]} health={health.map((h) => ({ source: h.source, status: h.status, statusLabel: ti(`health.${h.status}`) }))} actions={canManage ? ["resync", "disconnect"] : []}>
          {canManage && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("webhook")}</p>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="spoki-webhook-url">{spokiWebhookUrl(ctx.tenant.id)}</code><CopyButton text={spokiWebhookUrl(ctx.tenant.id)} label={t("copy")} /></div>
            </div>
          )}
          <p className="text-xs"><Link href={`/t/${slug}/whatsapp/settings`} className="underline-offset-4 hover:underline">{t("settings_link")}</Link></p>
        </IntegrationSheetStatus>
      )}
      {canManage && <SpokiConnection slug={slug} connected={connected} mock={mock} values={resolveSetupValues(SPOKI_SETUP, { tenantId: ctx.tenant.id, canSeeSecrets: canManage })} triggers={mockSetupTriggers("spoki")} guideHref={`/t/${slug}/integrations/guide/spoki`} />}
    </>
  );
  return <IntegrationCard slug={slug} sheet={sheet} data={{ provider: "spoki", title: ti("providers.spoki"), status, statusLabel: ti(`status.${status}`), modeLabel: mock ? ti("mode.mock") : ti("mode.live"), subtitle: connected ? (row?.externalAccountName ?? ti("no_account")) : ti("about.spoki"), lastSync: dt(row?.lastSyncAt), lastSuccess: dt(row?.lastSuccessAt), lastError: row?.lastError ?? null, connected, canManage, guideHref: `/t/${slug}/integrations/guide/spoki`, simulations: [], testable: connected && canManage, openOnLoad }} />;
}
