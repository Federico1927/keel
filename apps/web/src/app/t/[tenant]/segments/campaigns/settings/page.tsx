import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canDo } from "@hullwise/config";
import { PageHeader } from "@hullwise/ui";
import { requirePage } from "@/server/tenant";
import { CampaignSettingsForm } from "./form";

/** Add-on settings of customer campaigns: frequency cap, send window, throttle per channel, measurement lock. */
export default async function CampaignSettingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "customer_campaigns");
  if (!canDo(ctx.role, "manage_settings")) notFound();
  const t = await getTranslations("retention");
  const s = ctx.settings;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/segments/campaigns`} className="hover:underline">← {t("tabs.campaigns")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("settings.title")} description={t("settings.description", { timezone: ctx.tenant.timezone })} />
      <CampaignSettingsForm slug={tenant} values={{ campaignFrequencyCap: s.campaignFrequencyCap, campaignFrequencyDays: s.campaignFrequencyDays, campaignSendStartHour: s.campaignSendStartHour, campaignSendEndHour: s.campaignSendEndHour, throttleEmail: s.campaignThrottlePerMinute.email, throttleSms: s.campaignThrottlePerMinute.sms, throttleWhatsapp: s.campaignThrottlePerMinute.whatsapp, campaignMeasurementLock: s.campaignMeasurementLock }} />
    </>
  );
}
