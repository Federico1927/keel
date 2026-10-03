import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WEBHOOK_EVENT_TYPES, canDo, isModuleInPlan } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { WEBHOOK_DELIVERY_STATUSES, listWebhookDeliveries, listWebhookEndpoints } from "@hullwise/services";
import { Badge, Button, Card, CardContent, DataList, EmptyState, Label, PageHeader, Select } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { RedeliverButton } from "@/components/developers/forms";
import { DELIVERY_STATUS_VARIANT } from "@/components/developers/status";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("developers.deliveries"))("title") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Webhook delivery log (#81): filters by endpoint, status and event, newest first, cursor pages, redelivery. */
async function DeliveriesPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "settings");
  if (!canDo(ctx.role, "manage_integrations") || !isModuleInPlan("core.api", ctx.tenant.planKey)) notFound();
  const t = await getTranslations("developers.deliveries");
  const td = await getTranslations("developers");
  const filters = { endpointId: one(sp.endpoint), status: one(sp.status), eventType: one(sp.event), cursor: one(sp.cursor) ?? null, limit: 50 };
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const [endpoints, log] = await ctx.run(async (tx) => [await listWebhookEndpoints({ ...s, tx }), await listWebhookDeliveries({ ...s, tx }, filters)] as const);
  const tz = ctx.user.timeZone ?? ctx.tenant.timezone;
  const base = `/t/${tenant}/settings/developers/deliveries`;
  const next = () => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ endpoint: filters.endpointId, status: filters.status, event: filters.eventType })) if (v) u.set(k, v);
    u.set("cursor", log.nextCursor!);
    return `${base}?${u}`;
  };
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/settings/developers`} className="hover:underline">← {td("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <form method="get" action={base} className="mb-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-4 sm:items-end" data-testid="delivery-filters">
        <div className="space-y-1.5">
          <Label htmlFor="f-endpoint">{t("filter_endpoint")}</Label>
          <Select id="f-endpoint" name="endpoint" defaultValue={filters.endpointId ?? ""}>
            <option value="">{t("all")}</option>
            {endpoints.map((e) => <option key={e.id} value={e.id}>{e.url}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-status">{t("filter_status")}</Label>
          <Select id="f-status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">{t("all")}</option>
            <option value="failed">{t("status_failed_any")}</option>
            {WEBHOOK_DELIVERY_STATUSES.map((x) => <option key={x} value={x}>{t(`status.${x}`)}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-event">{t("filter_event")}</Label>
          <Select id="f-event" name="event" defaultValue={filters.eventType ?? ""}>
            <option value="">{t("all")}</option>
            {[...WEBHOOK_EVENT_TYPES, "webhook.test"].map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        </div>
        <div className="flex gap-2">
          <Button type="submit" data-testid="delivery-filters-apply">{t("apply")}</Button>
          <Button asChild variant="ghost"><Link href={base}>{t("reset")}</Link></Button>
        </div>
      </form>
      {log.rows.length === 0 ? (
        <EmptyState title={t("empty_title")} description={t("empty_description")} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataList
              data-testid="webhook-deliveries"
              rows={log.rows}
              rowKey={(r) => r.id}
              rowProps={(r) => ({ "data-testid": "webhook-delivery-row", "data-status": r.status, "data-event": r.eventType })}
              columns={[
                { key: "event", header: t("col_event"), mobile: "title", cell: (r) => <><Link href={`${base}/${r.id}`} className="font-mono text-xs font-medium text-primary hover:underline">{r.eventType}</Link>{r.isTest && <span className="ml-1 text-xs text-muted-foreground">{t("test")}</span>}{r.redeliveryOf && <span className="ml-1 text-xs text-muted-foreground">{t("redelivery")}</span>}</> },
                { key: "status", header: t("col_status"), mobile: "badge", cell: (r) => <Badge variant={DELIVERY_STATUS_VARIANT[r.status] ?? "muted"}>{t(`status.${r.status}`)}</Badge> },
                { key: "endpoint", header: t("col_endpoint"), mobile: "subtitle", cell: (r) => <span className="break-all font-mono text-xs">{r.endpointUrl}</span> },
                { key: "when", header: t("col_when"), className: "text-sm", cell: (r) => formatDateTime(r.createdAt, ctx.locale, tz) },
                { key: "response", header: t("col_response"), className: "text-sm", cell: (r) => <>{r.responseCode ?? "—"}{r.lastError && r.status !== "succeeded" && <div className="text-xs text-muted-foreground">{r.lastError}</div>}</> },
                { key: "attempts", header: t("col_attempts"), align: "right", priority: 2, className: "text-sm", cell: (r) => <>{formatNumber(r.attempts, ctx.locale)}{r.durationMs !== null && <div className="text-xs text-muted-foreground">{formatNumber(r.durationMs, ctx.locale)} ms</div>}</> },
                { key: "next", header: t("col_next"), priority: 3, className: "text-sm", cell: (r) => (r.nextAttemptAt && r.status === "retrying" ? formatDateTime(r.nextAttemptAt, ctx.locale, tz) : "—") },
                { key: "actions", header: "", mobile: "action", align: "right", cell: (r) => (["succeeded", "dead", "cancelled"].includes(r.status) ? <RedeliverButton slug={tenant} deliveryId={r.id} /> : null) },
              ]}
            />
          </CardContent>
        </Card>
      )}
      {log.nextCursor && (
        <div className="mt-4 flex justify-end">
          <Button asChild variant="outline"><Link href={next()} data-testid="deliveries-older">{t("older")}</Link></Button>
        </div>
      )}
    </>
  );
}

export default withIntl(DeliveriesPage, "app/t/[tenant]/settings/developers/deliveries/page.tsx");
