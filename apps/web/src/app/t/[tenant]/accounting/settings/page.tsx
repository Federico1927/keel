import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@hullwise/config";
import { ACCOUNTING_LINES, accountFor } from "@hullwise/core";
import { getAccountingState, recentRateKeys } from "@hullwise/services";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { analyticsTenant } from "@/server/analytics";
import { AccountingCard } from "@/components/accounting-card";
import { rateText } from "../../analytics/daily-sales/shared";
import { MappingForm } from "../controls";

import { withIntl } from "@/i18n/intl-scope";
/**
 * Settings of addon.accounting (#85), under the Platform section next to the other add-on settings:
 * the accounting system connection, its chart of accounts, and the account each summary line goes
 * to (sales and tax per tax rate, shipping, discounts, refunds, fees, clearing) plus the push rules.
 */
async function AccountingSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "accounting");
  const t = await getTranslations("accounting");
  const ts = await getTranslations("daily_sales");
  const { state, rateKeys } = await ctx.run(async (tx) => {
    const s = { tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } };
    return { state: await getAccountingState(s), rateKeys: await recentRateKeys(s, analyticsTenant(ctx)) };
  });
  const keys = [...new Set([...rateKeys, ...Object.keys(state.settings.mapping.byRate)])].sort();
  const rateLabels = Object.fromEntries(keys.map((k) => [k, rateText(k, ctx.locale, (v) => ts("rate_label", v))]));
  const canWrite = canWritePage(ctx.role, "accounting");
  const name = (code: string | null) => (code ? `${code}${state.accounts.find((a) => a.code === code) ? ` · ${state.accounts.find((a) => a.code === code)!.name}` : ""}` : t("settings.not_mapped"));
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/accounting`} className="hover:underline">← {t("log.title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("settings.title")} description={t("settings.description")} />
      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <AccountingCard ctx={ctx} />
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">{t("settings.chart_title")}</CardTitle>
            <CardDescription>{t("settings.chart_description")}</CardDescription>
          </CardHeader>
          <CardContent className="max-h-80 overflow-y-auto p-0">
            {state.accounts.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("settings.chart_empty")}</p> : (
              <DataList
                data-testid="accounting-chart"
                rows={state.accounts}
                rowKey={(a) => a.code}
                columns={[
                  { key: "code", header: t("settings.columns.code"), mobile: "title", className: "font-mono", cell: (a) => a.code },
                  { key: "name", header: t("settings.columns.name"), mobile: "subtitle", cell: (a) => a.name },
                  { key: "type", header: t("settings.columns.type"), cell: (a) => t(`account_types.${a.type}`) },
                  { key: "active", header: t("settings.columns.active"), mobile: "badge", cell: (a) => (a.active ? null : <Badge variant="muted">{t("settings.archived")}</Badge>) },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">{t("settings.mapping_title")}</CardTitle>
          <CardDescription>{t("settings.mapping_description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {canWrite ? (
            <MappingForm slug={tenant} settings={state.settings} accounts={state.accounts} rateKeys={keys} rateLabels={rateLabels} />
          ) : (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="accounting-mapping-read">
              {ACCOUNTING_LINES.map((l) => <div key={l}><dt className="text-muted-foreground">{t(`settings.lines.${l}`)}</dt><dd>{name(accountFor(state.settings.mapping, l))}</dd></div>)}
              {keys.map((k) => <div key={k}><dt className="text-muted-foreground">{rateLabels[k]}</dt><dd>{name(accountFor(state.settings.mapping, "sales", k))} · {name(accountFor(state.settings.mapping, "tax", k))}</dd></div>)}
            </dl>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default withIntl(AccountingSettingsPage, "app/t/[tenant]/accounting/settings/page.tsx");
