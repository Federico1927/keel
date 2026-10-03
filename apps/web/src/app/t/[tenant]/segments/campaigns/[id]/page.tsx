import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { getTranslations } from "next-intl/server";
import { canDo, canViewPage, canWritePage } from "@hullwise/config";
import { CAMPAIGN_EXCLUSION_REASONS, canApproveCampaign, effectiveSendStart, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, type CampaignExclusionReason } from "@hullwise/core";
import { adminDb, and, eq, schema } from "@hullwise/db";
import { campaignRecipients, listSegments, retentionCampaignDetail, sendWindowOf } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, DetailShell, Pagination, Stat, cn } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { campaignDeliveryFor, kickCampaigns } from "@/server/campaigns";
import { CampaignForm } from "../campaign-form";
import { UpliftBadge } from "../uplift-badge";
import { CampaignStatusBadge } from "../status-badge";
import { LiveRefresh, SendPanel } from "./send-panel";

import { withIntl } from "@/i18n/intl-scope";
const RECIPIENTS_PAGE = 25;

async function RetentionCampaignPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ group?: string; rpage?: string }> }) {
  const { tenant, id } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "customer_campaigns");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations("retention");
  const tco = await getTranslations("common");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const s = { tenantId: ctx.tenant.id, actor: { type: "user" as const, userId: ctx.user.id } };
  const detail = await ctx.run((tx) => retentionCampaignDetail({ ...s, tx }, at, id));
  if (!detail) notFound();
  const { campaign: c, segment, results, progress, people } = detail;
  const delivery = (await campaignDeliveryFor(ctx))[c.channel] ?? "simulated";
  const canWrite = canWritePage(ctx.role, "customer_campaigns");
  const isAuthor = [c.createdBy, c.submittedBy].includes(ctx.user.id);
  const canApprove = canApproveCampaign({ roleCanApprove: canDo(ctx.role, "approve_customer_campaign"), isOwner: ctx.role === "owner", isAuthor });
  const delivering = c.status === "sending" || (c.status === "active" && progress.pending > 0);
  // without a worker, the queue moves on page loads (the page refreshes itself while sending)
  if (delivering || c.status === "scheduled") after(() => kickCampaigns(ctx));
  const window = sendWindowOf({ timezone: ctx.tenant.timezone, settings: ctx.settings });
  const windowLabel = `${String(window.startHour).padStart(2, "0")}:00–${String(window.endHour).padStart(2, "0")}:00 (${ctx.tenant.timezone})`;
  const members = canWrite && c.channel === "email" ? (await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenant.id), eq(schema.tenantMemberships.isActive, true))).orderBy(schema.users.email)).map((u) => ({ id: u.id, label: u.name ? `${u.name} · ${u.email}` : u.email })).sort((a, b) => (a.id === ctx.user.id ? -1 : b.id === ctx.user.id ? 1 : 0)) : [];
  const money = (m: number | null | undefined) => (m === null || m === undefined ? "—" : formatMoney(Math.round(m), ctx.tenant.currency, ctx.locale));
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatPercent(v, ctx.locale, 1));
  const when = (d: Date | null) => (d ? formatDateTime(d, ctx.locale, ctx.tenant.timezone) : null);
  const back = <Link href={`/t/${tenant}/segments/campaigns`} className="hover:underline">← {t("tabs.campaigns")}</Link>;
  const chips = (
    <>
      <CampaignStatusBadge status={c.status} label={t(`status.${c.status}`)} />
      <Badge variant="muted">{t(`channels.${c.channel}`)}</Badge>
      {c.kind === "sequence" && <Badge variant="outline">{t("kinds.sequence")}</Badge>}
      {c.discountCode && <Badge variant="outline" className="font-mono">{c.discountCode}</Badge>}
      {delivery !== "external" && <Badge variant={delivery === "spoki_live" ? "info" : "warning"} data-testid="campaign-delivery">{t(`delivery.${delivery}`)}</Badge>}
    </>
  );
  const actions = <SendPanel slug={tenant} campaignId={c.id} locale={ctx.locale} status={c.status} kind={c.kind} channel={c.channel} canWrite={canWrite} canApprove={canApprove} members={members} windowLabel={windowLabel} />;
  const startsAt = c.status === "scheduled" && c.scheduledAt ? effectiveSendStart(c.scheduledAt, new Date(), window) : null;
  const steps: { key: string; who: string | null; at: string | null }[] = [
    { key: "created", who: people.createdBy, at: when(c.createdAt) },
    ...(c.testSentAt ? [{ key: "tested", who: people.testSentBy, at: when(c.testSentAt) }] : []),
    ...(c.submittedAt ? [{ key: "submitted", who: people.submittedBy, at: when(c.submittedAt) }] : []),
    ...(c.approvedAt ? [{ key: "approved", who: people.approvedBy, at: when(c.approvedAt) }] : []),
    ...(c.scheduledAt && c.kind !== "sequence" ? [{ key: "scheduled", who: people.scheduledBy, at: when(c.scheduledAt) }] : []),
    ...(c.sentAt ? [{ key: c.kind === "sequence" ? "activated" : "started", who: null, at: when(c.sentAt) }] : []),
    ...(c.completedAt ? [{ key: "completed", who: null, at: when(c.completedAt) }] : []),
  ];
  const exclusions = c.exclusionCounts as Partial<Record<CampaignExclusionReason, number>>;
  const workflow = (
    <Card data-testid="campaign-workflow">
      <CardHeader><CardTitle className="text-base">{t("workflow.title")}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ol className="space-y-1">
          {steps.map((x) => (
            <li key={x.key} className="flex justify-between gap-2"><span>{t(`workflow.steps.${x.key}`)}{x.who && <span className="text-muted-foreground"> · {x.who}</span>}</span><span className="shrink-0 text-xs text-muted-foreground tabular">{x.at}</span></li>
          ))}
        </ol>
        {c.status === "pending_approval" && <p className="text-xs text-muted-foreground" data-testid="approval-hint">{canApprove ? t("workflow.approval_you") : isAuthor ? t("workflow.approval_waiting") : t("workflow.approval_others")}</p>}
        {startsAt && <p className="text-xs" data-testid="starts-at">{t("workflow.starts_at", { at: when(startsAt) ?? "", window: windowLabel })}</p>}
        {c.reviewNote && <p className="rounded-md bg-muted p-2 text-xs">{t("workflow.review_note", { note: c.reviewNote })}</p>}
      </CardContent>
    </Card>
  );

  if (c.status === "draft" || c.status === "pending_approval" || c.status === "approved" || c.status === "scheduled") {
    const editable = c.status === "draft" && canWrite;
    const segments = editable ? (await ctx.run((tx) => listSegments({ ...s, tx }))).map((x) => ({ id: x.id, name: x.name, holdoutPercentage: x.holdoutPercentage, lastCount: x.lastCount })) : [];
    return (
      <DetailShell back={back} eyebrow={ctx.tenant.name} title={c.name} chips={chips} primaryActions={actions} aside={workflow}>
        {c.status === "draft" && c.reviewNote && <Alert className="mb-4" data-testid="sent-back"><AlertDescription>{t("workflow.sent_back", { note: c.reviewNote })}</AlertDescription></Alert>}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t(`stage.${c.status}.title`)}</CardTitle>
            <CardDescription>{t(`stage.${c.status}.description`)}</CardDescription>
          </CardHeader>
          <CardContent>
            {editable ? (
              <CampaignForm slug={tenant} segments={segments} currency={ctx.tenant.currency} delivery={await campaignDeliveryFor(ctx)} values={{ id: c.id, name: c.name, segmentId: c.segmentId ?? "", channel: c.channel, kind: c.kind, message: c.message, discountCode: c.discountCode, costPerMessageMinor: c.costPerMessageMinor, attributionDays: c.attributionDays, excludeOpenOrders: c.excludeOpenOrders }} />
            ) : (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">{t("fields.segment")}</dt><dd>{segment ? <Link className="hover:underline" href={`/t/${tenant}/segments/${segment.id}`}>{segment.name}</Link> : t("segment_deleted")}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("fields.attribution_days")}</dt><dd className="tabular">{c.attributionDays}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{t("fields.message")}</dt><dd className="whitespace-pre-wrap rounded-md bg-muted p-2" data-testid="campaign-message">{c.message || "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t("fields.exclude_open_orders")}</dt><dd>{c.excludeOpenOrders ? tco("yes") : tco("no")}</dd></div>
              </dl>
            )}
          </CardContent>
        </Card>
      </DetailShell>
    );
  }

  const r = results?.report;
  const done = progress.total - progress.pending;
  const group = sp.group === "treated" || sp.group === "holdout" ? sp.group : null;
  const rpage = Math.max(1, Number(sp.rpage) || 1);
  const recipients = await ctx.run((tx) => campaignRecipients({ ...s, tx }, c.id, { group, limit: RECIPIENTS_PAGE, offset: (rpage - 1) * RECIPIENTS_PAGE }));
  const canCustomers = canViewPage(ctx.role, "customers");
  const recipientsHref = (q: { group?: string | null; rpage?: number }) => {
    const u = new URLSearchParams();
    const g = q.group === undefined ? group : q.group;
    if (g) u.set("group", g);
    if ((q.rpage ?? 1) > 1) u.set("rpage", String(q.rpage));
    const qs = u.toString();
    return `/t/${tenant}/segments/campaigns/${c.id}${qs ? `?${qs}` : ""}#recipients`;
  };
  const recipientsCard = (
    <Card className="mt-6" id="recipients" data-testid="campaign-recipients">
      <CardHeader className="space-y-3">
        <div>
          <CardTitle className="text-base">{t("recipients.title")}</CardTitle>
          <CardDescription>{t("recipients.description", { days: c.attributionDays })}</CardDescription>
        </div>
        <div className="flex gap-1 rounded-md bg-muted p-1 text-sm" data-testid="recipient-filters">
          {([null, "treated", "holdout"] as const).map((g) => (
            <Link key={g ?? "all"} href={recipientsHref({ group: g, rpage: 1 })} scroll={false} className={cn("flex-1 rounded-sm px-2 py-1 text-center", group === g ? "bg-card shadow-sm" : "text-muted-foreground")} data-testid={`recipients-${g ?? "all"}`}>
              {g ? t(`group.${g}`) : t("recipients.all")} <span className="tabular text-xs">{formatNumber(g ? (recipients.byGroup[g] ?? 0) : Object.values(recipients.byGroup).reduce((a, n) => a + n, 0), ctx.locale)}</span>
            </Link>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {recipients.rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t("recipients.empty")}</p>
        ) : (
          <DataList
            rows={recipients.rows}
            rowKey={(x) => x.customerId}
            rowProps={(x) => ({ "data-testid": "recipient-row", "data-group": x.group })}
            columns={[
              { key: "customer", header: t("recipients.customer"), mobile: "title", cell: (x) => <>{canCustomers ? <Link href={`/t/${tenant}/customers/${x.customerId}`} className="font-medium hover:underline">{x.name ?? x.email ?? x.phone ?? "—"}</Link> : <span className="font-medium">{x.name ?? "—"}</span>}<div className="truncate text-xs font-normal text-muted-foreground">{c.channel === "email" ? (x.email ?? "—") : (x.phone ?? "—")}</div></> },
              { key: "group", header: t("recipients.group"), mobile: "badge", cell: (x) => <Badge variant={x.group === "holdout" ? "warning" : "muted"}>{t(`group.${x.group}`)}</Badge> },
              { key: "status", header: t("recipients.status"), cell: (x) => <span title={x.error ?? undefined}>{t(`exposure.${x.status}`)}</span> },
              { key: "at", header: t("recipients.exposed"), priority: 2, className: "tabular text-xs text-muted-foreground", cell: (x) => formatDateTime(x.sentAt ?? x.exposedAt, ctx.locale, ctx.tenant.timezone) },
              { key: "orders", header: t("recipients.orders"), align: "right", className: "tabular", cell: (x) => (x.orders > 0 ? <Badge variant="success">{formatNumber(x.orders, ctx.locale)}</Badge> : "—") },
            ]}
          />
        )}
        <div className="p-4"><Pagination page={rpage} pageSize={RECIPIENTS_PAGE} total={recipients.total} hrefFor={(p) => recipientsHref({ rpage: p })} summary={t("recipients.summary", { n: formatNumber(recipients.total, ctx.locale) })} /></div>
      </CardContent>
    </Card>
  );
  return (
    <DetailShell
      back={back}
      eyebrow={segment ? segment.name : t("segment_deleted")}
      title={c.name}
      chips={chips}
      primaryActions={canWrite && (c.status === "active" || c.status === "paused") ? actions : undefined}
      aside={
        <div className="space-y-4">
          <LiveRefresh active={delivering} />
          <Card data-testid="delivery-progress">
            <CardHeader><CardTitle className="text-base">{t("delivery_title")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>{c.kind === "sequence" ? t("activated_on", { at: when(c.sentAt) ?? "—" }) : t("sent_on", { at: when(c.sentAt) ?? "—" })}</p>
              {c.channel !== "manual" && progress.total > 0 && (
                <div>
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{progress.pending > 0 ? t("progress.sending") : t("progress.done")}</span><span className="tabular" data-testid="progress-count">{formatNumber(done, ctx.locale)} / {formatNumber(progress.total, ctx.locale)}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={done}>
                    <div className="h-full bg-primary transition-all" style={{ width: `${progress.total ? Math.round((done / progress.total) * 100) : 0}%` }} />
                  </div>
                  {c.status === "sending" && progress.pending > 0 && <p className="mt-1 text-xs text-muted-foreground">{t("progress.throttle", { n: formatNumber(ctx.settings.campaignThrottlePerMinute[c.channel as "email" | "sms" | "whatsapp"] ?? 0, ctx.locale), window: windowLabel })}</p>}
                </div>
              )}
              {detail.exposureStatus.map((x) => (
                <div key={`${x.group}-${x.status}`} className="flex justify-between gap-2"><span className="text-muted-foreground">{t(`exposure.${x.status}`)}</span><span className="tabular">{formatNumber(x.n, ctx.locale)}</span></div>
              ))}
              {c.message && <p className="mt-2 rounded-md bg-muted p-2 text-xs">{c.message}</p>}
            </CardContent>
          </Card>
          {Object.values(exclusions).some((v) => (v ?? 0) > 0) && (
            <Card data-testid="exclusions-card">
              <CardHeader><CardTitle className="text-base">{c.kind === "sequence" ? t("exclusions.waiting_title") : t("exclusions.left_out_title")}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                {CAMPAIGN_EXCLUSION_REASONS.filter((k) => k !== "holdout" && (exclusions[k] ?? 0) > 0).map((k) => (
                  <div key={k} className="flex justify-between gap-2"><span className="text-muted-foreground">{t(`exclusions.${k}`)}</span><span className="tabular">{formatNumber(exclusions[k] ?? 0, ctx.locale)}</span></div>
                ))}
              </CardContent>
            </Card>
          )}
          {workflow}
          <Card>
            <CardHeader><CardTitle className="text-base">{t("method_title")}</CardTitle></CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">{t("method_note", { days: c.attributionDays })}</p></CardContent>
          </Card>
        </div>
      }
    >
      {!results || !r ? null : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <UpliftBadge results={results} locale={ctx.locale} />
            <span className="text-sm text-muted-foreground">{results.windowOpen ? t("window_open", { at: formatDate(results.windowEndsAt, ctx.locale, ctx.tenant.timezone) }) : t("window_closed", { at: formatDate(results.windowEndsAt, ctx.locale, ctx.tenant.timezone) })}</span>
          </div>
          {!r.measurable && <Alert className="mb-4"><AlertDescription>{t("no_holdout_result")}</AlertDescription></Alert>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t("kpi.uplift")} value={r.conversion ? `${r.conversion.diff >= 0 ? "+" : ""}${formatNumber(r.conversion.diff * 100, ctx.locale, { maximumFractionDigits: 1 })} pt` : "—"} hint={r.conversion?.pValue != null ? t("kpi.p_value", { p: formatNumber(r.conversion.pValue, ctx.locale, { maximumFractionDigits: 3 }) }) : undefined} />
            <Stat label={t("kpi.incremental_orders")} value={r.incrementalOrders === null ? "—" : formatNumber(r.incrementalOrders, ctx.locale, { maximumFractionDigits: 0 })} />
            <Stat label={t("kpi.incremental_margin")} value={money(r.incrementalMarginMinor)} hint={r.incrementalMarginCi95 ? t("kpi.ci", { lo: money(r.incrementalMarginCi95[0]), hi: money(r.incrementalMarginCi95[1]) }) : undefined} />
            <Stat label={t("kpi.net")} value={money(r.netIncrementalMarginMinor)} hint={t("kpi.cost", { cost: money(r.costMinor), roi: r.roi === null ? "—" : formatNumber(r.roi, ctx.locale, { maximumFractionDigits: 1 }) })} />
          </div>
          <Card className="mt-6" data-testid="groups-table">
            <CardHeader>
              <CardTitle className="text-base">{t("groups_title")}</CardTitle>
              <CardDescription>{t("groups_description", { days: c.attributionDays })}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <DataList
                rows={["treated", "holdout"] as const}
                rowKey={(g) => g}
                columns={[
                  { key: "group", header: <span className="sr-only">{t("groups_title")}</span>, mobile: "title", className: "font-medium", cell: (g) => t(`group.${g}`) },
                  { key: "customers", header: t("columns.customers"), align: "right", className: "tabular", cell: (g) => formatNumber(r[g].customers, ctx.locale) },
                  { key: "converted", header: t("columns.converted"), align: "right", className: "tabular", cell: (g) => formatNumber(r[g].converters, ctx.locale) },
                  { key: "rate", header: t("columns.rate"), mobile: "badge", align: "right", className: "tabular", cell: (g) => pct(r[g].conversionRate) },
                  { key: "revenue", header: t("columns.revenue_pc"), align: "right", className: "tabular", cell: (g) => money(r[g].revenuePerCustomerMinor) },
                  { key: "margin", header: t("columns.margin_pc"), align: "right", className: "tabular", cell: (g) => money(r[g].marginPerCustomerMinor) },
                ]}
              />
            </CardContent>
          </Card>
          {c.discountCode && <p className="mt-3 text-sm text-muted-foreground">{t("code_redemptions", { n: results.codeRedemptions, code: c.discountCode })}</p>}
        </>
      )}
      {recipientsCard}
    </DetailShell>
  );
}

export default withIntl(RetentionCampaignPage, "app/t/[tenant]/segments/campaigns/[id]/page.tsx");
