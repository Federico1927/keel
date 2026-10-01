import { NextResponse, type NextRequest } from "next/server";
import { returnEvidenceData } from "@keel/services";
import { requirePage } from "@/server/tenant";

/** A photo the customer attached to the return; only for users who can see returns. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string; eid: string }> }) {
  const { tenant, id, eid } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(eid)) return new NextResponse("not found", { status: 404 });
  const ctx = await requirePage(tenant, "returns");
  const row = await ctx.run((tx) => returnEvidenceData({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id, eid));
  if (!row) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(row.data), { headers: { "content-type": row.contentType, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
}
