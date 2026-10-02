import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { canDo } from "@hullwise/config";
import { canEditPo } from "@hullwise/core";
import { eq, schema } from "@hullwise/db";
import { poVariantOptions } from "@hullwise/services";
import { requirePage } from "@/server/tenant";
import { getPurchaseOrder } from "@/server/queries/purchasing";
import { PoEditor } from "../../po-editor";
import { lineFromOption, newLineKey } from "../../po-lines";

import { withIntl } from "@/i18n/intl-scope";
/** Edit a draft or sent PO: header and lines; the supplier of a sent PO is fixed. */
async function EditPurchaseOrderPage({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await requirePage(tenant, "purchasing");
  if (!canDo(ctx.role, "receive_purchase_order")) notFound();
  const detail = await getPurchaseOrder(ctx, id);
  if (!detail) notFound();
  const { po, lines, locations } = detail;
  if (!canEditPo(po.status)) redirect(`/t/${tenant}/purchasing/${id}`);
  const t = await getTranslations("po_editor");
  const svc = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const [suppliers, options] = await Promise.all([
    ctx.run((tx) => tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.tenantId, ctx.tenant.id)).orderBy(schema.suppliers.name)),
    ctx.run((tx) => poVariantOptions(svc(tx), ctx.settings, [...new Set(lines.map((l) => l.variantId).filter((v): v is string => Boolean(v)))])),
  ]);
  const byId = new Map(options.map((o) => [o.variantId, o]));
  const editorLines = lines.map((l) => {
    const o = l.variantId ? byId.get(l.variantId) : undefined;
    if (o) return { ...lineFromOption(o, po.supplierId, l.quantity), unitCost: (l.unitCostMinor / 100).toFixed(2) };
    return { key: newLineKey(), variantId: null, label: "", sku: null, description: l.description ?? "", quantity: String(l.quantity), unitCost: (l.unitCostMinor / 100).toFixed(2), risk: null, daysOfCover: null, available: null };
  });
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  return (
    <>
      <Link href={`/t/${tenant}/purchasing/${id}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> {po.number}
      </Link>
      <h1 className="mb-1 text-2xl sm:text-3xl">{t("edit_title", { number: po.number })}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{po.status === "sent" ? t("edit_sent_hint") : t("edit_hint")}</p>
      <PoEditor slug={tenant} poId={po.id} suppliers={suppliers} locations={locations.map((l) => ({ id: l.id, name: l.name }))} currency={po.currency} supplierLocked={po.status !== "draft"} initial={{ supplierId: po.supplierId, destinationLocationId: po.destinationLocationId ?? "", expectedAt: day(po.expectedAt), notes: po.notes ?? "", lines: editorLines }} suggestions={[]} />
    </>
  );
}

export default withIntl(EditPurchaseOrderPage, "app/t/[tenant]/purchasing/[id]/edit/page.tsx");
