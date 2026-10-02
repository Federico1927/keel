import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDateTime, formatNumber } from "@keel/core";
import { mcpUsageByTenant } from "@keel/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Stat, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requireSuperAdmin } from "@/server/admin";
import { KillSwitch } from "./kill-switch";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("admin.mcp"))("title") };
}

/** Console (#21): MCP usage per tenant over 30 days and the per-tenant kill switch. Super-admins only; every switch is audited. */
export default async function AdminMcpPage() {
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
        <CardContent>
          <Table data-testid="admin-mcp-tenants">
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_tenant")}</TableHead>
                <TableHead>{t("col_status")}</TableHead>
                <TableHead className="text-right">{t("col_calls")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("col_errors")}</TableHead>
                <TableHead className="hidden text-right lg:table-cell">{t("col_users")}</TableHead>
                <TableHead className="hidden text-right lg:table-cell">{t("col_connections")}</TableHead>
                <TableHead className="hidden xl:table-cell">{t("col_last_call")}</TableHead>
                <TableHead className="text-right">{t("col_kill")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.tenants.map((x) => (
                <TableRow key={x.tenantId} data-testid="admin-mcp-row">
                  <TableCell>
                    <Link href={`/admin/tenants/${x.tenantId}`} className="font-medium hover:underline">{x.name}</Link>
                    <div className="text-xs text-muted-foreground">{tp(x.planKey as "starter")}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={x.availability === "ok" ? "success" : x.availability === "killed" ? "destructive" : "muted"}>{t(`availability.${x.availability}`)}</Badge>
                    {x.killedAt && <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(x.killedAt, locale, "UTC")}{x.killNote ? ` · ${x.killNote}` : ""}</div>}
                    {x.availability !== "ok" && x.availability !== "killed" && <div className="mt-1 hidden text-xs text-muted-foreground lg:block">{tu(x.availability)}</div>}
                  </TableCell>
                  <TableCell className="text-right">{n(x.calls)}{x.pendingProposals > 0 && <div className="text-xs text-muted-foreground">{t("pending", { count: x.pendingProposals })}</div>}</TableCell>
                  <TableCell className="hidden text-right md:table-cell">{n(x.errors)}<div className="text-xs text-muted-foreground">{t("denied_rl", { denied: x.denied, limited: x.rateLimited })}</div></TableCell>
                  <TableCell className="hidden text-right lg:table-cell">{n(x.users)}</TableCell>
                  <TableCell className="hidden text-right lg:table-cell">{n(x.activeConnections)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-sm xl:table-cell">{x.lastCallAt ? formatDateTime(x.lastCallAt, locale, "UTC") : "—"}</TableCell>
                  <TableCell className="text-right">{x.availability !== "plan" && <KillSwitch tenantId={x.tenantId} killed={Boolean(x.killedAt)} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
