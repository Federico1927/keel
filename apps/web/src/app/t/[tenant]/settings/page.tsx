import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Button, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@keel/ui";
import { schema } from "@keel/db";
import { canDo } from "@keel/config";
import { requirePage } from "@/server/tenant";
import { GeneralSettingsForm, OperationalSettingsForm, TaxRatesSection } from "./forms";

export default async function SettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "settings");
  const t = await getTranslations("settings");
  const taxRates = await ctx.run((tx) => tx.select().from(schema.tenantTaxRates).orderBy(schema.tenantTaxRates.country));
  return (
    <>
      <PageHeader
        eyebrow={ctx.tenant.name}
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/t/${tenant}/settings/branding`}>{t("branding_link")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/t/${tenant}/settings/order-states`}>{t("order_states_link")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/t/${tenant}/settings/fulfilment`} data-testid="fulfilment-settings-link">{t("fulfilment_link")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/t/${tenant}/settings/ai`} data-testid="ai-settings-link">{t("ai_link")}</Link>
            </Button>
            {canDo(ctx.role, "export_tenant_data") && (
              <Button asChild variant="outline">
                <Link href={`/t/${tenant}/settings/data-export`} data-testid="data-export-link">{t("data_export_link")}</Link>
              </Button>
            )}
          </>
        }
      />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t("tabs.general")}</TabsTrigger>
          <TabsTrigger value="operational">{t("tabs.operational")}</TabsTrigger>
          <TabsTrigger value="taxes">{t("tabs.taxes")}</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <GeneralSettingsForm
            slug={ctx.tenant.slug}
            values={{
              name: ctx.tenant.name,
              country: ctx.tenant.country,
              currency: ctx.tenant.currency,
              timezone: ctx.tenant.timezone,
              defaultLocale: ctx.tenant.defaultLocale,
              orderNumberPrefix: ctx.tenant.orderNumberPrefix,
            }}
          />
        </TabsContent>
        <TabsContent value="operational">
          <OperationalSettingsForm slug={ctx.tenant.slug} settings={ctx.settings} currency={ctx.tenant.currency} />
        </TabsContent>
        <TabsContent value="taxes">
          <TaxRatesSection slug={ctx.tenant.slug} rates={taxRates.map((r) => ({ country: r.country, rateBps: r.rateBps, pricesIncludeTax: r.pricesIncludeTax }))} />
        </TabsContent>
      </Tabs>
    </>
  );
}
