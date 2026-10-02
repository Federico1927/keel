import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canWritePage, isPageEnabled } from "@hullwise/config";
import { validateSegmentRules, type SegmentGroup } from "@hullwise/core";
import { PageHeader } from "@hullwise/ui";
import { notFound } from "next/navigation";
import { requirePage } from "@/server/tenant";
import { decodeRulesParam, segmentBuilderOptions } from "@/server/queries/crm";
import { SegmentBuilder } from "../builder";

export default async function NewSegmentPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ rules?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const ctx = await requirePage(tenant, "segments");
  if (!canWritePage(ctx.role, "segments")) notFound();
  const t = await getTranslations("segments");
  const options = await segmentBuilderOptions(ctx);
  const decoded = validateSegmentRules(decodeRulesParam(sp.rules)).rules;
  const rules: SegmentGroup = decoded ?? { match: "all", conditions: [{ field: "orders_count", op: "gte", value: 2 }] };
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/segments`} className="hover:underline">← {t("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("new")} description={t("new_description")} />
      <SegmentBuilder slug={tenant} segment={{ name: "", description: null, rules, holdoutPercentage: 0 }} options={options} currency={ctx.tenant.currency} locale={ctx.locale} canWrite holdoutEnabled={isPageEnabled("customer_campaigns", ctx.activeAddons)} />
    </>
  );
}
