import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { canWritePage } from "@keel/config";
import { listSegments } from "@keel/services";
import { Card, CardContent, EmptyState, PageHeader } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { CampaignForm } from "../campaign-form";

export default async function NewRetentionCampaignPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ segment?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "customer_campaigns");
  if (!canWritePage(ctx.role, "customer_campaigns")) notFound();
  const t = await getTranslations("retention");
  const segments = await ctx.run((tx) => listSegments({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
  const options = segments.map((s) => ({ id: s.id, name: s.name, holdoutPercentage: s.holdoutPercentage, lastCount: s.lastCount }));
  const preselected = options.find((s) => s.id === sp.segment)?.id ?? options.find((s) => s.holdoutPercentage > 0)?.id ?? options[0]?.id ?? "";
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/segments/campaigns`} className="hover:underline">← {t("tabs.campaigns")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("new")} description={t("new_description")} />
      {options.length === 0 ? (
        <EmptyState title={t("no_segments_title")} description={t("no_segments_description")} />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <CampaignForm slug={tenant} segments={options} currency={ctx.tenant.currency} values={{ name: "", segmentId: preselected, channel: "email", message: "", discountCode: null, costPerMessageMinor: 0, attributionDays: 14 }} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
