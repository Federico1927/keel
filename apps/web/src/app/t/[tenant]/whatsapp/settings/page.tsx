import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { ORDER_MESSAGE_EVENTS, formatDateTime, formatNumber } from "@hullwise/core";
import { ORDER_NOTIFICATION_VARIABLES, getSpokiState, spokiStats } from "@hullwise/addon-spoki";
import { TEMPLATE_VARIABLES, getCodSettings } from "@hullwise/addon-cod";
import { PageHeader, Stat } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { SpokiCard } from "@/components/spoki-card";
import { WhatsappLog } from "@/components/whatsapp-log";
import { CodRepliesForm, SpokiSettingsForm, type TemplateRow } from "./controls";

import { withIntl } from "@/i18n/intl-scope";
/**
 * Settings of the Spoki WhatsApp add-on (issue #9): connection and webhook, the template of each
 * event (order notifications, the campaign message with customer campaigns, each COD confirmation
 * template with the COD add-on), opt-out keywords, COD reply keywords, last 7 days and the log.
 * `requirePage` answers 404 when the add-on is off or the role cannot open it.
 */
async function WhatsappSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "whatsapp_settings");
  const t = await getTranslations("whatsapp.settings");
  const cod = ctx.activeAddons.includes("addon.cod");
  const campaigns = ctx.activeAddons.includes("addon.customer_campaigns");
  const { state, stats, codSettings } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { state: await getSpokiState(s), stats: await spokiStats(s), codSettings: cod ? await getCodSettings(s) : null };
  });
  const rows: TemplateRow[] = [
    ...ORDER_MESSAGE_EVENTS.map((e) => ({ key: e, label: t(`events.${e}`), variables: ORDER_NOTIFICATION_VARIABLES, notify: state.settings.notify[e] })),
    ...(campaigns ? [{ key: "campaign", label: t("events.campaign"), variables: ["first_name", "code", "body"] }] : []),
    ...(codSettings?.messageTemplates ?? []).map((m) => ({ key: `cod:${m.key}`, label: t("events.cod", { name: m.name }), variables: [...TEMPLATE_VARIABLES, "body"] })),
  ];
  const n = (v: number) => formatNumber(v, ctx.locale);
  return (
    <>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <SpokiCard ctx={ctx} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4" data-testid="whatsapp-stats">
            <Stat label={t("stats.sent")} value={n(stats.sent)} hint={t("stats.days", { n: 7 })} />
            <Stat label={t("stats.delivered")} value={n(stats.delivered)} />
            <Stat label={t("stats.read")} value={n(stats.read)} />
            <Stat label={t("stats.replied")} value={n(stats.replied)} />
            <Stat label={t("stats.failed")} value={n(stats.failed)} />
            <Stat label={t("stats.received")} value={n(stats.received)} />
            <Stat label={t("stats.opt_outs")} value={n(stats.optOuts)} />
            <Stat label={t("stats.templates")} value={n(state.templates.filter((x) => x.status === "approved").length)} hint={state.templatesSyncedAt ? formatDateTime(state.templatesSyncedAt, ctx.locale, ctx.tenant.timezone) : t("stats.never")} />
          </div>
        </div>
        {canWritePage(ctx.role, "whatsapp_settings") && <SpokiSettingsForm slug={tenant} settings={state.settings} templates={state.templates} rows={rows} />}
        {codSettings && canWritePage(ctx.role, "whatsapp_settings") && <CodRepliesForm slug={tenant} confirm={codSettings.messagingReplies.confirm} cancel={codSettings.messagingReplies.cancel} />}
        <WhatsappLog ctx={ctx} limit={25} title={t("recent")} showEmpty />
      </div>
    </>
  );
}

export default withIntl(WhatsappSettingsPage, "app/t/[tenant]/whatsapp/settings/page.tsx");
