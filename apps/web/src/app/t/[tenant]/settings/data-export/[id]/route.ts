import { NextResponse, type NextRequest } from "next/server";
import { canDo } from "@keel/config";
import { TenantExportError, takeTenantExportFile } from "@keel/services";
import { auditActor } from "@/server/audit-actor";
import { getTenantContext } from "@/server/tenant";

/** Download of a tenant data export (#32): owner only, until the link expires; every download is audited. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  const ctx = await getTenantContext(tenant);
  if (!canDo(ctx.role, "export_tenant_data") || !/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });
  const actor = auditActor(ctx);
  try {
    const { fileName, file } = await ctx.run((tx) => takeTenantExportFile(tx, ctx.tenant.id, id, { userId: ctx.user.id, actorType: actor.actorType, impersonatedBy: actor.impersonatedBy }));
    return new NextResponse(new Uint8Array(file), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${fileName}"`, "content-length": String(file.length), "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof TenantExportError) return new NextResponse(e.code, { status: e.code === "expired" ? 410 : 404 });
    throw e;
  }
}
