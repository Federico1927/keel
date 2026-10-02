import { NextResponse, type NextRequest } from "next/server";
import { TenantExportError, takeTenantExportFile } from "@hullwise/services";
import { requireSuperAdmin } from "@/server/admin";

/** The super-admin downloads a tenant's data export (#32), until it expires; audited on the tenant as `super_admin`. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; exportId: string }> }) {
  const { user, db } = await requireSuperAdmin();
  const { id, exportId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(exportId)) return new NextResponse("not found", { status: 404 });
  try {
    const { fileName, file } = await takeTenantExportFile(db, id, exportId, { userId: user.id, actorType: "super_admin" });
    return new NextResponse(new Uint8Array(file), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${fileName}"`, "content-length": String(file.length), "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof TenantExportError) return new NextResponse(e.code, { status: e.code === "expired" ? 410 : 404 });
    throw e;
  }
}
