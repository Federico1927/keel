import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { eq, schema } from "@keel/db";
import { requirePage } from "@/server/tenant";
import { reorderCandidates } from "@/server/queries/purchasing";
import { NewPoForm } from "./form";

export default async function NewPurchaseOrderPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ product?: string }> }) {
  const { tenant } = await params;
  const { product } = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("po_new");
  const [suppliers, locations, candidates] = await Promise.all([
    ctx.run((tx) => tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(schema.suppliers.name)),
    ctx.run((tx) => tx.select({ id: schema.locations.id, name: schema.locations.name, isDefault: schema.locations.isDefault }).from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id))),
    reorderCandidates(ctx),
  ]);
  const filtered = product ? candidates.filter((c) => c.productId === product) : candidates.filter((c) => c.suggestedReorder > 0 || c.risk === "critical").slice(0, 60);
  return (
    <>
      <Link href={`/t/${tenant}/purchasing`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <h1 className="mb-1 text-2xl sm:text-3xl">{t("title")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t("description", { target: ctx.settings.reorderTargetDays })}</p>
      <NewPoForm slug={tenant} suppliers={suppliers} locations={locations} currency={ctx.tenant.currency} candidates={filtered.map((c) => ({ variantId: c.variantId, label: `${c.productTitle} · ${c.variantTitle}`, sku: c.sku, available: c.available, incoming: c.incoming, daysOfCover: c.daysOfCover, risk: c.risk, suggested: c.suggestedReorder, cost: (c.costMinor ?? 0) / 100 }))} />
    </>
  );
}
