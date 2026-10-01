import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo, canWritePage } from "@keel/config";
import { Card, CardContent, PageHeader } from "@keel/ui";
import { requirePage } from "@/server/tenant";
import { CostImportForm, CostWriteBackToggle } from "./import-form";

export default async function ImportCostsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const ctx = await requirePage(tenant, "products");
  if (!canWritePage(ctx.role, "products")) notFound();
  const t = await getTranslations("cost_import");
  return (
    <>
      <Link href={`/t/${tenant}/products/quality`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <PageHeader eyebrow={ctx.tenant.name} title={t("title")} description={t("description")} />
      <div className="space-y-4">
        <CostImportForm slug={tenant} currency={ctx.tenant.currency} locale={ctx.locale} />
        <Card>
          <CardContent className="pt-6">
            <CostWriteBackToggle slug={tenant} enabled={ctx.settings.costWriteBack} canEdit={canDo(ctx.role, "manage_settings")} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
