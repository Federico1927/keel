import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@hullwise/core";
import { listMcpConnections, mcpAvailabilityFor, type McpConnectionRow } from "@hullwise/services";
import { Alert, AlertDescription, Badge, DataList } from "@hullwise/ui";
import { mcpServerUrl } from "@/server/mcp";
import { getTenantContext, type TenantContext } from "@/server/tenant";
import { CopyField } from "./copy-field";
import { CreateTokenForm, TokenActions } from "./connection-forms";
import { McpGuides } from "./guides";

export function tenantMcpAvailability(ctx: TenantContext) {
  return mcpAvailabilityFor({ planKey: ctx.tenant.planKey, status: ctx.tenant.status, settings: ctx.settings, mcpDisabledAt: ctx.tenant.mcpDisabledAt });
}

/** Table of MCP connections (OAuth clients and personal access tokens) with last use and revoke. */
export async function ConnectionsTable({ slug, rows, locale, timezone, showUser, viewerId, canRevokeOthers }: { slug: string; rows: McpConnectionRow[]; locale: string; timezone: string; showUser: boolean; viewerId: string; canRevokeOthers: boolean }) {
  const t = await getTranslations("mcp.connections");
  const tc = await getTranslations("common");
  if (rows.length === 0) return <p className="text-sm text-muted-foreground" data-testid="mcp-connections-table">{t("empty")}</p>;
  return (
    <DataList
      data-testid="mcp-connections-table"
      rows={rows}
      rowKey={(r) => r.id}
      rowProps={() => ({ "data-testid": "mcp-connection-row" })}
      columns={[
        { key: "connection", header: t("connection"), mobile: "title", cell: (r) => <><div className="font-medium">{r.clientName ?? r.name}</div><div className="flex flex-wrap items-center gap-1.5 text-xs font-normal text-muted-foreground"><Badge variant={r.kind === "oauth" ? "info" : "secondary"}>{t(`kind.${r.kind === "oauth" ? "oauth" : "pat"}`)}</Badge><span className="font-mono">{r.displayPrefix}…</span>{r.state !== "active" && <Badge variant="muted">{t(`state.${r.state}`)}</Badge>}</div></> },
        ...(showUser ? [{ key: "user", header: t("user"), mobile: "subtitle" as const, className: "text-sm", cell: (r: McpConnectionRow) => r.userName ?? r.userEmail }] : []),
        { key: "scopes", header: t("scopes"), label: "", className: "break-all font-mono text-xs", cell: (r) => r.scopes.join(" ") },
        { key: "last", header: t("last_used"), className: "whitespace-nowrap text-sm", cell: (r) => (r.lastUsedAt ? formatDateTime(r.lastUsedAt, locale, timezone) : t("never")) },
        { key: "expires", header: t("expires"), className: "whitespace-nowrap text-sm", cell: (r) => formatDateTime(r.kind === "oauth" && r.refreshExpiresAt ? r.refreshExpiresAt : r.expiresAt, locale, timezone) },
        { key: "actions", header: <span className="sr-only">{tc("actions")}</span>, mobile: "action", align: "right", cell: (r) => r.state === "active" && (r.userId === viewerId || canRevokeOthers) && <TokenActions slug={slug} tokenId={r.id} canRotate={r.kind === "pat" && r.userId === viewerId} /> },
      ]}
    />
  );
}

/**
 * "Connections" on the profile (#21): the person's own AI clients and personal access tokens for
 * this workspace, the server URL and how to connect. Every member has it; it only works when the
 * plan includes MCP and an owner switched it on.
 */
export async function McpConnectionsSection({ slug, locale }: { slug: string; locale: string }) {
  const ctx = await getTenantContext(slug);
  const t = await getTranslations("mcp.connections");
  const tu = await getTranslations("mcp.unavailable");
  const availability = tenantMcpAvailability(ctx);
  const rows = await ctx.run((tx) => listMcpConnections({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, { userId: ctx.user.id }));
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  return (
    <div className="space-y-4" data-testid="mcp-connections">
      {availability !== "ok" && (
        <Alert variant="info">
          <AlertDescription>
            {tu(availability)} {availability === "tenant_disabled" && isAdmin && <Link href={`/t/${slug}/settings/ai`} className="font-medium underline">{t("open_settings")}</Link>}
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("server_url")}</p>
        <CopyField value={mcpServerUrl()} testId="mcp-server-url" />
        <p className="text-xs text-muted-foreground">{t("server_url_hint")}</p>
      </div>
      <ConnectionsTable slug={slug} rows={rows} locale={locale} timezone={ctx.user.timeZone ?? ctx.tenant.timezone} showUser={false} viewerId={ctx.user.id} canRevokeOthers={false} />
      {availability === "ok" && !ctx.impersonation && <CreateTokenForm slug={slug} />}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">{t("how_to")}</summary>
        <div className="mt-3">
          <McpGuides serverUrl={mcpServerUrl()} />
        </div>
      </details>
    </div>
  );
}
