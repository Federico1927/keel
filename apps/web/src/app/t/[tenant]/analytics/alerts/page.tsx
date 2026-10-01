import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { formatDateTime, displayName } from "@keel/core";
import { adminDb, eq, schema } from "@keel/db";
import { ALERT_METRIC_OPTIONS, integrationRow, listAlertRules, recentAlertEvents } from "@keel/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { AlertRuleControls, AlertRuleForm, RunAlertsButton, SlackWebhookForm } from "../advanced-controls";

type Cond = { kind: "threshold"; op: "lt" | "gt"; value: number; days: number } | { kind: "anomaly"; direction: string; sensitivity: number; baselineDays: number };

export default async function AlertsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "analytics");
  const t = await getTranslations("analytics.alerts");
  const canWrite = canWritePage(ctx.role, "analytics");
  const { rules, events, slack } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { rules: await listAlertRules(s), events: await recentAlertEvents(s), slack: await integrationRow(s, "slack") };
  });
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const describe = (c: Cond) => (c.kind === "threshold" ? t("describe_threshold", { op: t(`ops.${c.op}`), value: c.value, days: c.days }) : t("describe_anomaly", { direction: t(`directions.${c.direction}`), sensitivity: c.sensitivity, days: c.baselineDays }));
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/analytics`} className="hover:underline">← {t("back")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} actions={canWrite ? <RunAlertsButton slug={tenant} /> : undefined} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("rules")}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {rules.length === 0 ? <EmptyState title={t("no_rules")} /> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("name")}</TableHead>
                      <TableHead>{t("condition")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("channels_label")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("last_fired")}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((r) => (
                      <TableRow key={r.id} data-testid="alert-rule">
                        <TableCell className="font-medium">{r.name}{!r.isActive && <Badge variant="muted" className="ml-2">{t("inactive")}</Badge>}<div className="text-xs text-muted-foreground">{t(`metrics.${r.metric}`)}</div></TableCell>
                        <TableCell className="text-sm">{describe(r.condition as Cond)}</TableCell>
                        <TableCell className="hidden md:table-cell">{(r.channels as string[]).map((c) => <Badge key={c} variant="outline" className="mr-1">{t(`channels.${c}`)}</Badge>)}</TableCell>
                        <TableCell className="hidden text-xs lg:table-cell">{r.lastFiredAt ? formatDateTime(r.lastFiredAt, ctx.locale, ctx.tenant.timezone) : "—"}</TableCell>
                        <TableCell>{canWrite && <AlertRuleControls slug={tenant} id={r.id} active={r.isActive} />}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("events")}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {events.length === 0 ? <EmptyState title={t("no_events")} /> : (
                <ul className="divide-y text-sm" data-testid="alert-events">
                  {events.map(({ e, name, metric }) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                      <span><span className="font-medium">{name}</span> <span className="text-muted-foreground">· {t(`metrics.${metric}`)} · {t(`reasons.${e.reason}`)}</span></span>
                      <span className="text-xs text-muted-foreground">{t("value_vs_baseline", { value: e.value ?? "—", baseline: e.baseline ?? "—" })} · {Object.entries(e.delivered as Record<string, string>).map(([k, v]) => `${t(`channels.${k}`)}: ${v}`).join(" · ")} · {formatDateTime(e.firedAt, ctx.locale, ctx.tenant.timezone)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        {canWrite && (
          <div className="space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-base">{t("new_rule")}</CardTitle><CardDescription>{t("new_rule_help")}</CardDescription></CardHeader>
              <CardContent><AlertRuleForm slug={tenant} metrics={[...ALERT_METRIC_OPTIONS]} members={members.map((m) => ({ id: m.id, label: displayName(m) }))} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">{t("delivery")}</CardTitle><CardDescription>{t("delivery_help")}</CardDescription></CardHeader>
              <CardContent className="space-y-2">
                <SlackWebhookForm slug={tenant} connected={slack?.status === "connected"} />
                <p className="text-xs text-muted-foreground">{slack?.status === "connected" ? t(slack.mode === "live" ? "slack_live" : "slack_mock") : t("slack_none")}</p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
