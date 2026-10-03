import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WEBHOOK_HEADERS, canDo, isModuleInPlan } from "@hullwise/config";
import { formatDateTime, formatNumber } from "@hullwise/core";
import { webhookDeliveryDetail } from "@hullwise/services";
import { Badge, Card, CardContent, CardHeader, CardTitle, DataList, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { RedeliverButton } from "@/components/developers/forms";
import { DELIVERY_STATUS_VARIANT } from "@/components/developers/status";

import { withIntl } from "@/i18n/intl-scope";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("developers.deliveries"))("detail_title") };
}

/** One webhook delivery (#81): the payload as sent, the headers it carried, every attempt and a redelivery button. */
async function DeliveryPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "settings");
  if (!canDo(ctx.role, "manage_integrations") || !isModuleInPlan("core.api", ctx.tenant.planKey)) notFound();
  const t = await getTranslations("developers.deliveries");
  const d = await ctx.run((tx) => webhookDeliveryDetail({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id));
  if (!d) notFound();
  const tz = ctx.user.timeZone ?? ctx.tenant.timezone;
  const finished = ["succeeded", "dead", "cancelled"].includes(d.status);
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/settings/developers/deliveries`} className="hover:underline">← {t("title")}</Link></p>
      <PageHeader eyebrow={d.endpointUrl} title={d.eventType} description={t("detail_description", { when: formatDateTime(d.createdAt, ctx.locale, tz) })} actions={finished ? <RedeliverButton slug={tenant} deliveryId={d.id} /> : undefined} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("summary")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm" data-testid="delivery-summary">
              <dt className="text-muted-foreground">{t("col_status")}</dt>
              <dd><Badge variant={DELIVERY_STATUS_VARIANT[d.status] ?? "muted"}>{t(`status.${d.status}`)}</Badge>{d.lastError && d.status !== "succeeded" && <span className="ml-2 text-xs text-muted-foreground">{d.lastError}</span>}</dd>
              <dt className="text-muted-foreground">{WEBHOOK_HEADERS.id}</dt>
              <dd className="break-all font-mono text-xs">{d.id}</dd>
              <dt className="text-muted-foreground">{t("event_id")}</dt>
              <dd className="break-all font-mono text-xs">{d.eventId}</dd>
              <dt className="text-muted-foreground">{t("col_attempts")}</dt>
              <dd>{formatNumber(d.attempts, ctx.locale)}</dd>
              {d.nextAttemptAt && d.status === "retrying" && (<><dt className="text-muted-foreground">{t("col_next")}</dt><dd>{formatDateTime(d.nextAttemptAt, ctx.locale, tz)}</dd></>)}
              {d.deliveredAt && (<><dt className="text-muted-foreground">{t("delivered_at")}</dt><dd>{formatDateTime(d.deliveredAt, ctx.locale, tz)}</dd></>)}
              {d.responseExcerpt && (<><dt className="text-muted-foreground">{t("response_excerpt")}</dt><dd className="break-all font-mono text-xs">{d.responseExcerpt}</dd></>)}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("attempts")}</CardTitle></CardHeader>
          <CardContent className="p-0">
            {d.attemptLog.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t("no_attempts")}</p>
            ) : (
              <DataList
                data-testid="delivery-attempts"
                rows={[...d.attemptLog].reverse()}
                rowKey={(a, i) => `${a.at}-${i}`}
                columns={[
                  { key: "at", header: t("col_when"), mobile: "title", className: "text-sm", cell: (a) => formatDateTime(a.at, ctx.locale, tz) },
                  { key: "code", header: t("col_response"), mobile: "badge", cell: (a) => <Badge variant={a.code !== null && a.code < 300 ? "success" : "destructive"}>{a.code ?? "—"}</Badge> },
                  { key: "error", header: t("col_error"), mobile: "subtitle", className: "text-xs text-muted-foreground", cell: (a) => a.error ?? "" },
                  { key: "ms", header: t("col_duration"), align: "right", className: "text-sm", cell: (a) => `${formatNumber(a.durationMs, ctx.locale)} ms` },
                ]}
              />
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">{t("payload")}</CardTitle></CardHeader>
          <CardContent>
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="delivery-payload">{JSON.stringify(d.payload, null, 2)}</pre>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default withIntl(DeliveryPage, "app/t/[tenant]/settings/developers/deliveries/[id]/page.tsx");
