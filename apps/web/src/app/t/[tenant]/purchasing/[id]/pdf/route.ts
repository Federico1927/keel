import { NextResponse, type NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { formatDate, formatMoney } from "@keel/core";
import { purchaseOrderPdf } from "@keel/services";
import { ForbiddenError, requirePage } from "@/server/tenant";

/** The purchase order as a PDF for the supplier, in the user's language. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "purchasing");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  const t = await getTranslations("po_pdf");
  const pdf = await ctx.run((tx) =>
    purchaseOrderPdf(
      { tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } },
      id,
      { title: t("title"), supplier: t("supplier"), expected: t("expected"), sku: t("sku"), item: t("item"), quantity: t("quantity"), unitPrice: t("unit_price"), total: t("total"), confirmAt: t("confirm_at"), notes: t("notes") },
      { money: (m) => formatMoney(m, ctx.tenant.currency, ctx.locale), date: (d) => formatDate(d, ctx.locale, ctx.tenant.timezone) },
    ),
  );
  if (!pdf) return new NextResponse("not found", { status: 404 });
  return new NextResponse(Buffer.from(pdf.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf.filename}"`, "cache-control": "private, no-store" } });
}
