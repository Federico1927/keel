import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDateTime } from "@keel/core";
import { listMcpConnections, mcpAvailabilityFor, type McpConnectionRow } from "@keel/services";
import { Alert, AlertDescription, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
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
  return (
    <Table data-testid="mcp-connections-table">
      <TableHeader>
        <TableRow>
          <TableHead>{t("connection")}</TableHead>
          {showUser && <TableHead>{t("user")}</TableHead>}
          <TableHead className="hidden md:table-cell">{t("scopes")}</TableHead>
          <TableHead>{t("last_used")}</TableHead>
          <TableHead className="hidden sm:table-cell">{t("expires")}</TableHead>
          <TableHead className="text-right"><span className="sr-only">{tc("actions")}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} data-testid="mcp-connection-row">
            <TableCell>
              <div className="font-medium">{r.clientName ?? r.name}</div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant={r.kind === "oauth" ? "info" : "secondary"}>{t(`kind.${r.kind === "oauth" ? "oauth" : "pat"}`)}</Badge>
                <span className="font-mono">{r.displayPrefix}…</span>
                {r.state !== "active" && <Badge variant="muted">{t(`state.${r.state}`)}</Badge>}
              </div>
            </TableCell>
            {showUser && <TableCell className="text-sm">{r.userName ?? r.userEmail}</TableCell>}
            <TableCell className="hidden font-mono text-xs md:table-cell">{r.scopes.join(" ")}</TableCell>
            <TableCell className="whitespace-nowrap text-sm">{r.lastUsedAt ? formatDateTime(r.lastUsedAt, locale, timezone) : t("never")}</TableCell>
            <TableCell className="hidden whitespace-nowrap text-sm sm:table-cell">{formatDateTime(r.kind === "oauth" && r.refreshExpiresAt ? r.refreshExpiresAt : r.expiresAt, locale, timezone)}</TableCell>
            <TableCell className="text-right">{r.state === "active" && (r.userId === viewerId || canRevokeOthers) && <TokenActions slug={slug} tokenId={r.id} canRotate={r.kind === "pat" && r.userId === viewerId} />}</TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={showUser ? 6 : 5} className="text-muted-foreground">{t("empty")}</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
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
