import { NextResponse, type NextRequest } from "next/server";
import { invoicesCsv } from "@hullwise/services";
import { requireSuperAdmin } from "@/server/admin";

/** CSV of the invoices list with the page's filters and sort (#48); audited as `admin.export_csv`. */
export async function GET(req: NextRequest) {
  const { user, db } = await requireSuperAdmin();
  const { csv, rows } = await invoicesCsv(db, Object.fromEntries(req.nextUrl.searchParams.entries()), user.id);
  return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.csv"`, "x-export-rows": String(rows), "cache-control": "no-store" } });
}
