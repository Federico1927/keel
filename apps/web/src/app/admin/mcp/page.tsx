import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { mcpUsageByTenant } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, DataList } from "@hullwise/ui";
import { requireSuperAdmin } from "@/server/admin";
import { KillSwitch } from "./kill-switch";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("admin.mcp"))("title") };
}

/** Console (#21): MCP usage per tenant over 30 days and the per-tenant kill switch. Super-admins only; every switch is audited. */
async function AdminMcpPage() {
  const { db } = await requireSuperAdmin();
  const t = await getTranslations("admin.mcp");
  const ta = await getTranslations("admin");
  const tu = await getTranslations("mcp.unavailable");
  const tp = await getTranslations("plans");
  const locale = await getLocale();
  const usage = await mcpUsageByTenant(db, { days: 30 });
  const sum = (k: "calls" | "errors" | "rateLimited" | "activeConnections") => usage.tenants.reduce((a, x) => a + x[k], 0);
  const n = (v: number) => formatNumber(v, locale);
  return (
    <>
      <PageHeader eyebrow={ta("console")} title={t("title")} description={t("description")} />
      {usage.platformDisabled && (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>{t("platform_disabled")}</AlertDescription>
        </Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={t("stat_calls")} value={n(sum("calls"))} />
        <Stat label={t("stat_errors")} value={n(sum("errors"))} />
        <Stat label={t("stat_rate_limited")} value={n(sum("rateLimited"))} />
        <Stat label={t("stat_connections")} value={n(sum("activeConnections"))} />
        <Stat label={t("stat_unknown_tokens")} value={n(usage.unknownTokenFailures)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("tenants_title")}</CardTitle>
          <CardDescription>{t("tenants_description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataList
            data-testid="admin-mcp-tenants"
            rows={usage.tenants}
            rowKey={(x) => x.tenantId}
            rowProps={() => ({ "data-testid": "admin-mcp-row" })}
            columns={[
              { key: "tenant", header: t("col_tenant"), mobile: "title", cell: (x) => <><Link href={`/admin/tenants/${x.tenantId}`} className="font-medium hover:underline">{x.name}</Link><div className="text-xs font-normal text-muted-foreground">{tp(x.planKey as "starter")}</div></> },
              { key: "status", header: t("col_status"), mobile: "badge", cell: (x) => <>
                <Badge variant={x.availability === "ok" ? "success" : x.availability === "killed" ? "destructive" : "muted"}>{t(`availability.${x.availability}`)}</Badge>
                {x.killedAt && <div className="mt-1 text-xs text-muted-foreground max-md:hidden">{formatDateTime(x.killedAt, locale, "UTC")}{x.killNote ? ` · ${x.killNote}` : ""}</div>}
                {x.availability !== "ok" && x.availability !== "killed" && <div className="mt-1 hidden text-xs text-muted-foreground lg:block">{tu(x.availability)}</div>}
              </> },
              { key: "killed", header: null, mobile: "subtitle", className: "text-xs md:hidden", headClassName: "md:hidden", cell: (x) => (x.killedAt ? `${formatDateTime(x.killedAt, locale, "UTC")}${x.killNote ? ` · ${x.killNote}` : ""}` : null) },
              { key: "calls", header: t("col_calls"), align: "right", cell: (x) => <>{n(x.calls)}{x.pendingProposals > 0 && <div className="text-xs text-muted-foreground max-md:inline max-md:before:content-['_·_']">{t("pending", { count: x.pendingProposals })}</div>}</> },
              { key: "errors", header: t("col_errors"), align: "right", priority: 2, cell: (x) => <>{n(x.errors)}<div className="text-xs text-muted-foreground max-md:inline max-md:before:content-['_·_']">{t("denied_rl", { denied: x.denied, limited: x.rateLimited })}</div></> },
              { key: "users", header: t("col_users"), align: "right", priority: 2, cell: (x) => n(x.users) },
              { key: "connections", header: t("col_connections"), align: "right", priority: 3, cell: (x) => n(x.activeConnections) },
              { key: "last_call", header: t("col_last_call"), priority: 3, className: "whitespace-nowrap text-sm", cell: (x) => (x.lastCallAt ? formatDateTime(x.lastCallAt, locale, "UTC") : "—") },
              { key: "kill", header: t("col_kill"), mobile: "action", align: "right", cell: (x) => (x.availability !== "plan" ? <KillSwitch tenantId={x.tenantId} killed={Boolean(x.killedAt)} /> : null) },
            ]}
          />
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AdminMcpPage, "app/admin/mcp/page.tsx");
