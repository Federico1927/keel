import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatDate, formatDateTime, displayName } from "@hullwise/core";
import { adminDb, eq, schema } from "@hullwise/db";
import { SCORE_FACTORS, TAG_WRITE_EVENTS, TEMPLATE_VARIABLES, carrierImportSummary, getCodSettings, listCapacity, listRiskyRecipients } from "@hullwise/addon-cod";
import { codMessagingWebhookUrl } from "@/server/cod-webhook";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader } from "@hullwise/ui";
import { WideTable } from "@/components/mobile/wide-table";
import { requirePage } from "@/server/tenant";
import { CapacityRow, DeleteExceptionButton, ExceptionForm, OverrideControls, RecomputeRiskButton, ScoringSettingsForm, TagSettingsForm } from "./controls";
import { CarrierImportForm, OperationsForm, ScorePreview, TemplatesEditor } from "./extras";

import { withIntl } from "@/i18n/intl-scope";
async function CodSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "cod_settings");
  const t = await getTranslations("cod.settings");
  const tcod = await getTranslations("cod");
  const { settings, capacity, risky, batches } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { settings: await getCodSettings(s), capacity: await listCapacity(s), risky: await listRiskyRecipients(s, { tiers: ["watch", "high_risk", "blacklisted"], limit: 100 }), batches: await carrierImportSummary(s) };
  });
  const decimals = new Intl.NumberFormat("en", { style: "currency", currency: ctx.tenant.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const members = await adminDb().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.tenantMemberships.role }).from(schema.tenantMemberships).innerJoin(schema.users, eq(schema.users.id, schema.tenantMemberships.userId)).where(eq(schema.tenantMemberships.tenantId, ctx.tenant.id));
  const operators = members.filter((m) => ["operations", "customer_care", "admin", "owner"].includes(m.role)).map((m) => ({ id: m.id, label: displayName(m) }));
  const mask = (k: string) => (k.startsWith("email:") ? k.replace(/^email:(.{2}).*(@.*)$/, "email:$1***$2") : k.replace(/\d(?=\d{3})/g, "•"));
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/cod`} className="hover:underline">← {tcod("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("operators_title")}</CardTitle>
            <CardDescription>{t("operators_description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <WideTable label={t("operators_title")} stickyFirst data-testid="capacity-grid">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="px-3 py-2">{t("operator")}</th>
                    {(["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const).map((d) => <th key={d} className="px-1 py-2 text-center">{t(`days.${d}`)}</th>)}
                    <th className="px-3 py-2 text-right">{t("week")}</th>
                    <th className="px-3 py-2">{t("allowed_tags")}</th>
                    <th className="px-3 py-2 text-right">{t("active")}</th>
                  </tr>
                </thead>
                <tbody>
                  {operators.map((o) => {
                    const cap = capacity.operators.find((c) => c.userId === o.id);
                    return <CapacityRow key={o.id} slug={tenant} userId={o.id} label={o.label} dailyHours={cap?.dailyHours ?? [0, 0, 0, 0, 0, 0, 0]} isActive={cap ? cap.isActive === 1 : false} allowedTags={cap?.allowedTags ?? []} />;
                  })}
                </tbody>
            </WideTable>
            <div>
              <p className="mb-2 text-sm font-medium">{t("exceptions_title")}</p>
              <ExceptionForm slug={tenant} operators={operators} />
              {capacity.exceptions.length > 0 && (
                <ul className="mt-2 divide-y text-sm">
                  {capacity.exceptions.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 py-1">
                      <span>{formatDate(new Date(`${e.date}T12:00:00Z`), ctx.locale, ctx.tenant.timezone)} · {operators.find((o) => o.id === e.userId)?.label ?? e.userId.slice(0, 8)} · <Badge variant={e.kind === "off" ? "muted" : "info"}>{t(`kinds.${e.kind}`)}{e.hours ? ` ${e.hours}h` : ""}</Badge> {e.note && <span className="text-muted-foreground">{e.note}</span>}</span>
                      <DeleteExceptionButton slug={tenant} id={e.id} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
        <OperationsForm slug={tenant} settings={settings} currencyDecimals={decimals} />
        <TemplatesEditor slug={tenant} templates={settings.messageTemplates} variables={TEMPLATE_VARIABLES} webhookUrl={codMessagingWebhookUrl(ctx.tenant.id)} />
        <TagSettingsForm slug={tenant} settings={settings} events={TAG_WRITE_EVENTS} />
        <ScorePreview slug={tenant} />
        <ScoringSettingsForm slug={tenant} settings={settings} factors={SCORE_FACTORS} />
        <CarrierImportForm slug={tenant} batches={batches.map((b) => ({ batch: b.batch, at: formatDateTime(b.at instanceof Date ? b.at : new Date(b.at), ctx.locale, ctx.tenant.timezone), rows: b.rows, matched: b.matched, refused: b.refused }))} />
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">{t("recipients_title")}</CardTitle>
              <CardDescription>{t("recipients_description")}</CardDescription>
            </div>
            <RecomputeRiskButton slug={tenant} />
          </CardHeader>
          <CardContent className="p-0">
            <DataList
              rows={risky}
              rowKey={(r) => r.id}
              rowProps={() => ({ "data-testid": "risk-row" })}
              columns={[
                { key: "recipient", header: t("recipient"), mobile: "title", className: "font-mono text-xs break-all", cell: (r) => mask(r.recipientKey) },
                { key: "tier", header: t("tier"), mobile: "badge", cell: (r) => <><Badge variant={r.tier === "blacklisted" ? "destructive" : r.tier === "high_risk" ? "warning" : "muted"}>{tcod(`risk.${r.tier}`)}</Badge>{r.override && <Badge variant="outline" className="ml-1">{t(`overrides.${r.override}`)}</Badge>}</> },
                { key: "returns", header: t("returns"), align: "right", className: "tabular", cell: (r) => <>{r.ordersReturned} <span className="text-xs text-muted-foreground">({r.weightedReturns})</span></> },
                { key: "delivered", header: t("delivered"), align: "right", className: "tabular", cell: (r) => r.ordersDelivered },
                { key: "last_return", header: t("last_return"), priority: 2, cell: (r) => (r.lastReturnAt ? formatDate(r.lastReturnAt, ctx.locale, ctx.tenant.timezone) : "—") },
                { key: "suggestion", header: t("suggestion"), mobile: "subtitle", className: "text-xs", cell: (r) => (r.tier === "blacklisted" && r.override !== "force_blacklist" ? t("suggest_blacklist") : r.tier === "high_risk" ? t("suggest_verify") : "—") },
                { key: "override", header: <span className="sr-only">{t("tier")}</span>, mobile: "action", cell: (r) => <OverrideControls slug={tenant} recipientKey={r.recipientKey} override={r.override} /> },
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default withIntl(CodSettingsPage, "app/t/[tenant]/cod/settings/page.tsx");
