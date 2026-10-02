import { NextResponse, type NextRequest } from "next/server";
import { supportAttachment } from "@hullwise/services";
import { requirePage } from "@/server/tenant";

/** A file attached to a support message; RLS limits it to the tenant's own tickets. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; mid: string }> }) {
  const { tenant, mid } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(mid)) return new NextResponse("not found", { status: 404 });
  const ctx = await requirePage(tenant, "support");
  const file = await ctx.run((tx) => supportAttachment({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, mid));
  if (!file) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(file.data), { headers: { "content-type": file.type, "content-disposition": `attachment; filename="${encodeURIComponent(file.name)}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
