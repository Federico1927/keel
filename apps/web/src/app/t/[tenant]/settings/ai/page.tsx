import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MCP_LIMITS } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { listMcpConnections, mcpRecentActivity, pendingProposalCount } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { mcpServerUrl } from "@/server/mcp";
import { CopyField } from "@/components/mcp/copy-field";
import { ConnectionsTable, tenantMcpAvailability } from "@/components/mcp/connections";
import { McpGuides } from "@/components/mcp/guides";
import { McpSwitches } from "./switches";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("mcp.settings"))("title") };
}

/** Settings → AI & MCP (#21): the server URL, the switches, how to connect, every connection of the workspace and recent activity. Owners and admins. */
export default async function AiSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  const t = await getTranslations("mcp.settings");
  const tu = await getTranslations("mcp.unavailable");
  const ts = await getTranslations("settings");
  const availability = tenantMcpAvailability(ctx);
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const [connections, activity, pending] = await ctx.run(async (tx) => [await listMcpConnections({ ...s, tx }), await mcpRecentActivity({ ...s, tx }, { limit: 20 }), await pendingProposalCount({ ...s, tx })] as const);
  const tz = ctx.user.timeZone ?? ctx.tenant.timezone;
  const inPlan = availability !== "plan";
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/settings`} className="hover:underline">← {ts("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={pending > 0 ? <Button asChild variant="outline"><Link href={`/t/${tenant}/approvals`} data-testid="mcp-approvals-link">{t("approvals_link", { count: pending })}</Link></Button> : <Button asChild variant="ghost"><Link href={`/t/${tenant}/approvals`}>{t("approvals_link_empty")}</Link></Button>} />
      {availability !== "ok" && availability !== "tenant_disabled" && (
        <Alert variant={availability === "plan" ? "info" : "warning"} className="mb-4" data-testid="mcp-unavailable">
          <AlertDescription>{tu(availability)}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("server_title")}</CardTitle>
            <CardDescription>{t("server_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <CopyField value={mcpServerUrl()} testId="mcp-settings-server-url" />
            <p className="text-xs"><Link href={`/t/${tenant}/profile#connections`} className="font-medium text-primary hover:underline" data-testid="mcp-own-tokens-link">{t("own_tokens_link")}</Link></p>
            <McpSwitches slug={tenant} mcpEnabled={ctx.settings.mcpEnabled} mcpFullPii={ctx.settings.mcpFullPii} disabled={!inPlan} />
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>{t("rule_auth")}</li>
              <li>{t("rule_permissions")}</li>
              <li>{t("rule_writes")}</li>
              <li>{t("rule_limits", { perToken: MCP_LIMITS.perTokenPerMinute, perTenant: MCP_LIMITS.perTenantPerMinute })}</li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("guides_title")}</CardTitle>
            <CardDescription>{t("guides_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <McpGuides serverUrl={mcpServerUrl()} />
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t("connections_title")}</CardTitle>
            <CardDescription>{t("connections_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectionsTable slug={tenant} rows={connections} locale={ctx.locale} timezone={tz} showUser viewerId={ctx.user.id} canRevokeOthers />
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t("activity_title")}</CardTitle>
            <CardDescription>{t("activity_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t("stat_calls")} value={formatNumber(activity.counts.calls, ctx.locale)} />
              <Stat label={t("stat_errors")} value={formatNumber(activity.counts.errors, ctx.locale)} />
              <Stat label={t("stat_denied")} value={formatNumber(activity.counts.denied, ctx.locale)} />
              <Stat label={t("stat_rate_limited")} value={formatNumber(activity.counts.rateLimited, ctx.locale)} />
            </div>
            {activity.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="mcp-activity">{t("activity_empty")}</p>
            ) : (
              <DataList
                data-testid="mcp-activity"
                rows={activity.rows}
                rowKey={(r) => r.id}
                columns={[
                  { key: "tool", header: t("col_tool"), mobile: "title", className: "font-mono text-xs", cell: (r) => r.tool ?? r.method },
                  { key: "outcome", header: t("col_outcome"), mobile: "badge", cell: (r) => <Badge variant={r.outcome === "ok" ? "success" : r.outcome === "error" ? "destructive" : "warning"}>{t(`outcome.${r.outcome}`)}</Badge> },
                  { key: "when", header: t("col_when"), mobile: "subtitle", className: "whitespace-nowrap text-sm", cell: (r) => formatDateTime(r.createdAt, ctx.locale, tz) },
                  { key: "who", header: t("col_who"), label: "", className: "text-sm", cell: (r) => <>{r.userName ?? r.userEmail ?? "—"}{r.clientName && <span className="text-muted-foreground"> · {r.clientName}</span>}</> },
                  { key: "duration", header: t("col_duration"), align: "right", className: "text-sm", cell: (r) => `${formatNumber(r.durationMs, ctx.locale)} ms` },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
