import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { PRODUCT_NAME } from "@keel/config";
import { formatDate, formatMoney } from "@keel/core";
import { eq, schema } from "@keel/db";
import { ledgerInvoicePdf } from "@keel/services";
import { getTenantContext } from "@/server/tenant";

/** Invoice download (owner, #53): Stripe's PDF when Stripe issued it, else a PDF of the Keel ledger row. Read through RLS. */
export async function GET(_req: Request, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await getTenantContext(tenant);
  if (ctx.role !== "owner" || !/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });
  const [inv] = await ctx.run((tx) => tx.select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1));
  if (!inv) return new NextResponse("not found", { status: 404 });
  if (inv.pdfUrl) return NextResponse.redirect(inv.pdfUrl);
  const t = await getTranslations("billing");
  const pdf = ledgerInvoicePdf(inv, {
    sellerName: PRODUCT_NAME,
    customerName: ctx.tenant.name,
    labels: { title: t("pdf.title"), issued: t("pdf.issued"), due: t("pdf.due"), item: t("pdf.item"), amount: t("pdf.amount"), total: t("pdf.total"), status: t("pdf.status"), kinds: { plan: t("pdf.kinds.plan"), addon: t("pdf.kinds.addon"), setup: t("pdf.kinds.setup"), other: t("pdf.kinds.other") } },
    money: (m, c) => formatMoney(m, c, ctx.locale),
    date: (d) => formatDate(d, ctx.locale, ctx.tenant.timezone),
  });
  return new NextResponse(Buffer.from(pdf.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf.filename}"`, "cache-control": "private, no-store" } });
}
