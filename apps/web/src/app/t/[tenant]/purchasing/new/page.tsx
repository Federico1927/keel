import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { eq, schema } from "@hullwise/db";
import { poVariantOptions } from "@hullwise/services";
import { requirePage } from "@/server/tenant";
import { reorderCandidates } from "@/server/queries/purchasing";
import { PoEditor } from "../po-editor";
import { lineFromOption } from "../po-lines";

export default async function NewPurchaseOrderPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ product?: string; supplier?: string }> }) {
  const { tenant } = await params;
  const { product, supplier } = await searchParams;
  const ctx = await requirePage(tenant, "purchasing");
  const t = await getTranslations("po_new");
  const [suppliers, locations, candidates] = await Promise.all([
    ctx.run((tx) => tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(schema.suppliers.name)),
    ctx.run((tx) => tx.select({ id: schema.locations.id, name: schema.locations.name, isDefault: schema.locations.isDefault }).from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id))),
    reorderCandidates(ctx),
  ]);
  // pre-fill: every variant of the product, or the variants that need reordering
  const picked = product ? candidates.filter((c) => c.productId === product) : candidates.filter((c) => c.suggestedReorder > 0 || c.risk === "critical").slice(0, 60);
  const options = await ctx.run((tx) => poVariantOptions({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.settings, picked.map((c) => c.variantId)));
  const supplierId = suppliers.find((s) => s.id === supplier)?.id ?? options.find((o) => o.supplierId)?.supplierId ?? suppliers[0]?.id ?? "";
  const prefill = options.filter((o) => o.suggested > 0 || product);
  return (
    <>
      <Link href={`/t/${tenant}/purchasing`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {t("back")}
      </Link>
      <h1 className="mb-1 text-2xl sm:text-3xl">{t("title")}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t("description", { target: ctx.settings.reorderTargetDays })}</p>
      <PoEditor
        slug={tenant}
        suppliers={suppliers}
        locations={locations}
        currency={ctx.tenant.currency}
        initial={{ supplierId, destinationLocationId: locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? "", expectedAt: "", notes: "", lines: prefill.map((o) => lineFromOption(o, supplierId, o.suggested)) }}
        suggestions={options.filter((o) => !prefill.includes(o))}
      />
    </>
  );
}
