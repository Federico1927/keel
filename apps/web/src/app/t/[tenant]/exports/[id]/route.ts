import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@keel/db";
import { takeExportFile } from "@keel/services";
import { auditActor } from "@/server/audit-actor";
import { getTenantContext } from "@/server/tenant";

/** Download of a background export: only the user who asked for it, audited. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });
  const ctx = await getTenantContext(tenant);
  const file = await ctx.run(async (tx) => {
    const f = await takeExportFile({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id, ctx.user.id);
    if (f) await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "export.downloaded", entityType: "list_export", entityId: id, metadata: { list: f.list, rows: f.rows } });
    return f;
  });
  if (!file) return new NextResponse("not found", { status: 404 });
  return new NextResponse(file.content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file.fileName}"`, "cache-control": "no-store" } });
}
