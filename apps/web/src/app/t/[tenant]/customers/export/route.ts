import type { NextRequest } from "next/server";
import { handleListExport } from "@/server/list-export";

/** CSV of the filtered list (direct up to 5,000 rows, background job above). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenant: string }> }) {
  return handleListExport(req, (await params).tenant, "customers");
}
