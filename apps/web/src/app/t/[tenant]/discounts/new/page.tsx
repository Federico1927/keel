import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@hullwise/ui";
import { requireAction } from "@/server/tenant";
import { DiscountForms } from "./forms";

import { withIntl } from "@/i18n/intl-scope";
async function NewDiscountPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requireAction(tenant, "create_discount", "discounts");
  const t = await getTranslations("discount_new");
  const td = await getTranslations("discounts");
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground"><Link href={`/t/${tenant}/discounts`} className="hover:underline">← {td("title")}</Link></p>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <DiscountForms slug={tenant} currency={ctx.tenant.currency} defaultPrefix={ctx.tenant.orderNumberPrefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "HULLWISE"} />
    </>
  );
}

export default withIntl(NewDiscountPage, "app/t/[tenant]/discounts/new/page.tsx");
