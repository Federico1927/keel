import { NextResponse, type NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { formatDate } from "@hullwise/core";
import { packingSlipsPdf } from "@hullwise/services";
import { ForbiddenError, requirePage } from "@/server/tenant";

/** Packing slips as one PDF: `?ids=<order id>[,<order id>…]` (one order or the board selection), in the user's language. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "shipments");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 200);
  if (!ids.length) return new NextResponse("no orders", { status: 400 });
  const t = await getTranslations("fulfilment.packing_slip");
  const pdf = await ctx.run((tx) =>
    packingSlipsPdf(
      { tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } },
      ids,
      { title: t("title"), order: t("order"), placed: t("placed"), shipTo: t("ship_to"), sku: t("sku"), item: t("item"), variant: t("variant"), quantity: t("quantity"), units: t("units"), note: t("note") },
      { date: (d) => formatDate(d, ctx.locale, ctx.tenant.timezone), companyName: ctx.tenant.name },
    ),
  );
  if (!pdf) return new NextResponse("not found", { status: 404 });
  return new NextResponse(Buffer.from(pdf.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${pdf.filename}"`, "cache-control": "private, no-store" } });
}
