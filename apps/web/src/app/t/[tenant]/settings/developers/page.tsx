import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { API_LIMITS, canDo, isModuleInPlan } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { apiAvailabilityFor, apiRecentActivity, listApiTokens, listWebhookEndpoints } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { apiBaseUrl } from "@/server/api-docs";
import { CopyField } from "@/components/mcp/copy-field";
import { ApiTokenActions, CreateApiTokenForm, CreateWebhookForm, WebhookEndpointActions } from "@/components/developers/forms";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("developers"))("title") };
}

const STATE_VARIANT = { active: "success", expired: "muted", revoked: "muted" } as const;

/**
 * Settings → Developers (#81): the REST API base URL, API tokens, webhook endpoints and recent API
 * calls. Owners and admins (the page needs `settings`, the actions `manage_integrations`); the API is
 * from Growth, like MCP: below it the page explains the plan and offers nothing.
 */
async function DevelopersPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  if (!canDo(ctx.role, "manage_integrations")) notFound();
  const t = await getTranslations("developers");
  const ts = await getTranslations("settings");
  const inPlan = isModuleInPlan("core.api", ctx.tenant.planKey);
  const availability = apiAvailabilityFor({ planKey: ctx.tenant.planKey, status: ctx.tenant.status, mcpDisabledAt: ctx.tenant.mcpDisabledAt });
  const tz = ctx.user.timeZone ?? ctx.tenant.timezone;
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const [tokens, endpoints, activity] = inPlan ? await ctx.run(async (tx) => [await listApiTokens({ ...s, tx }), await listWebhookEndpoints({ ...s, tx }), await apiRecentActivity({ ...s, tx }, { limit: 15 })] as const) : [[], [], null];
  const when = (d: Date | null) => (d ? formatDateTime(d, ctx.locale, tz) : "—");
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/settings`} className="hover:underline">← {ts("title")}</Link></p>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={inPlan && (
          <>
            <Button asChild variant="outline"><Link href={`/t/${tenant}/settings/developers/deliveries`} data-testid="webhook-deliveries-link">{t("deliveries_link")}</Link></Button>
            <Button asChild variant="outline"><Link href={`/t/${tenant}/settings/developers/docs`} data-testid="api-docs-link">{t("docs_link")}</Link></Button>
          </>
        )}
      />
      {availability !== "ok" && (
        <Alert variant={availability === "plan" ? "info" : "warning"} className="mb-4" data-testid="api-unavailable">
          <AlertDescription>{t(`unavailable.${availability}`)}</AlertDescription>
        </Alert>
      )}
      {inPlan && (
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("base_title")}</CardTitle>
              <CardDescription>{t("base_description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <CopyField value={apiBaseUrl()} testId="api-base-url" />
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>{t("rule_auth")}</li>
                <li>{t("rule_permissions")}</li>
                <li>{t("rule_limits", { perToken: API_LIMITS.perTokenPerMinute, perTenant: API_LIMITS.perTenantPerMinute })}</li>
                <li>{t("rule_pii")}</li>
              </ul>
            </CardContent>
          </Card>

          <Card id="tokens">
            <CardHeader>
              <CardTitle>{t("tokens.title")}</CardTitle>
              <CardDescription>{t("tokens.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CreateApiTokenForm slug={tenant} />
              {tokens.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("tokens.empty")}</p>
              ) : (
                <DataList
                  data-testid="api-tokens"
                  rows={tokens}
                  rowKey={(r) => r.id}
                  rowProps={() => ({ "data-testid": "api-token-row" })}
                  columns={[
                    { key: "name", header: t("tokens.col_name"), mobile: "title", cell: (r) => <>{r.name}<div className="font-mono text-xs font-normal text-muted-foreground">{r.displayPrefix}…</div></> },
                    { key: "state", header: t("tokens.col_state"), mobile: "badge", cell: (r) => <Badge variant={STATE_VARIANT[r.state]}>{t(`tokens.state.${r.state}`)}</Badge> },
                    { key: "scopes", header: t("tokens.col_scopes"), mobile: "subtitle", cell: (r) => <span className="font-mono text-xs">{r.scopes.join(" ")}</span> },
                    { key: "owner", header: t("tokens.col_owner"), priority: 2, className: "text-sm", cell: (r) => r.userName ?? r.userEmail },
                    { key: "used", header: t("tokens.col_last_used"), className: "text-sm", cell: (r) => when(r.lastUsedAt) },
                    { key: "expires", header: t("tokens.col_expires"), priority: 3, className: "text-sm", cell: (r) => when(r.expiresAt) },
                    { key: "actions", header: "", mobile: "action", align: "right", cell: (r) => (r.state === "active" ? <ApiTokenActions slug={tenant} tokenId={r.id} canRotate={r.userId === ctx.user.id} /> : null) },
                  ]}
                />
              )}
            </CardContent>
          </Card>

          <Card id="webhooks">
            <CardHeader>
              <CardTitle>{t("webhooks.title")}</CardTitle>
              <CardDescription>{t("webhooks.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CreateWebhookForm slug={tenant} />
              {endpoints.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("webhooks.empty")}</p>
              ) : (
                <DataList
                  data-testid="webhook-endpoints"
                  rows={endpoints}
                  rowKey={(r) => r.id}
                  rowProps={(r) => ({ "data-testid": "webhook-endpoint-row", "data-url": r.url })}
                  columns={[
                    { key: "url", header: t("webhooks.col_url"), mobile: "title", cell: (r) => <><Link href={`/t/${tenant}/settings/developers/deliveries?endpoint=${r.id}`} className="break-all font-mono text-xs hover:underline">{r.url}</Link>{r.description && <div className="text-xs font-normal text-muted-foreground">{r.description}</div>}</> },
                    { key: "state", header: t("webhooks.col_state"), mobile: "badge", cell: (r) => <Badge variant={r.isActive ? "success" : "muted"}>{r.isActive ? t("webhooks.active") : t("webhooks.paused")}</Badge> },
                    { key: "events", header: t("webhooks.col_events"), mobile: "subtitle", cell: (r) => <span className="font-mono text-xs">{r.eventTypes.join(" ")}</span> },
                    { key: "health", header: t("webhooks.col_24h"), className: "text-sm", cell: (r) => t("webhooks.health", { ok: r.succeeded24h, failed: r.failed24h }) },
                    { key: "secret", header: t("webhooks.col_secret"), priority: 2, cell: (r) => <><span className="font-mono text-xs">{r.secretPrefix}…</span>{r.previousSecretExpiresAt && <div className="text-xs text-muted-foreground">{t("webhooks.grace", { when: when(r.previousSecretExpiresAt) })}</div>}</> },
                    { key: "actions", header: "", mobile: "action", align: "right", cell: (r) => <WebhookEndpointActions slug={tenant} endpointId={r.id} isActive={r.isActive} /> },
                  ]}
                />
              )}
            </CardContent>
          </Card>

          {activity && (
            <Card>
              <CardHeader>
                <CardTitle>{t("activity.title")}</CardTitle>
                <CardDescription>{t("activity.description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label={t("activity.calls")} value={formatNumber(activity.counts.calls, ctx.locale)} />
                  <Stat label={t("activity.errors")} value={formatNumber(activity.counts.errors, ctx.locale)} />
                  <Stat label={t("activity.denied")} value={formatNumber(activity.counts.denied, ctx.locale)} />
                  <Stat label={t("activity.rate_limited")} value={formatNumber(activity.counts.rateLimited, ctx.locale)} />
                </div>
                {activity.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>
                ) : (
                  <DataList
                    data-testid="api-activity"
                    rows={activity.rows}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: "route", header: t("activity.col_route"), mobile: "title", cell: (r) => <span className="font-mono text-xs">{r.method} {r.route}</span> },
                      { key: "status", header: t("activity.col_status"), mobile: "badge", cell: (r) => <Badge variant={r.status < 300 ? "success" : r.status >= 500 ? "destructive" : "warning"}>{r.status}</Badge> },
                      { key: "when", header: t("activity.col_when"), mobile: "subtitle", className: "text-sm", cell: (r) => formatDateTime(r.createdAt, ctx.locale, tz) },
                      { key: "token", header: t("activity.col_token"), className: "text-sm", cell: (r) => r.tokenName ?? "—" },
                      { key: "duration", header: t("activity.col_duration"), align: "right", priority: 2, className: "text-sm", cell: (r) => `${formatNumber(r.durationMs, ctx.locale)} ms` },
                    ]}
                  />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

export default withIntl(DevelopersPage, "app/t/[tenant]/settings/developers/page.tsx");
