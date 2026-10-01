import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, requirePage } from "@/server/tenant";
import { exportPurchaseOrders } from "@/server/queries/purchasing";

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the purchase orders matching the list filters (status, supplier, destination, search, dates). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "purchasing");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 404 });
    throw e;
  }
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const rows = await exportPurchaseOrders(ctx, { status: sp.status, supplier: sp.supplier, destination: sp.destination, q: sp.q, from: sp.from, to: sp.to });
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const header = ["number", "status", "supplier", "destination", "source", "created", "ordered", "expected", "received", "lines", "units", "units_received_good", "total", "currency", "waiting_orders"];
  const lines = rows.map((r) => [r.number, r.status, r.supplierName, r.destinationName, r.source, day(r.createdAt), day(r.orderedAt), day(r.expectedAt), day(r.receivedAt), r.lines, r.units, r.receivedUnits, (r.totalMinor / 100).toFixed(2), r.currency, r.backorders].map(csvCell).join(","));
  const body = [header.join(","), ...lines].join("\n");
  return new NextResponse(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="purchase-orders-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
