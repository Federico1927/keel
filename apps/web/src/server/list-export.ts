import { NextResponse, after, type NextRequest } from "next/server";
import { EXPORT_DIRECT_MAX_ROWS, EXPORT_MAX_ROWS, canExportList, type ExportListKey } from "@hullwise/config";
import { recordAudit, withTenant } from "@hullwise/db";
import { canonicalQuery, queryParams } from "@hullwise/core";
import { buildListCsv, countListExport, exportFileName, requestListExport, runListExport, type ExportScope } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { enqueue } from "@/server/jobs";
import { requirePage } from "@/server/tenant";

/**
 * GET handler behind every list's "Export CSV" link: the same filters as the page (the link carries
 * the page's query string), the same permission (`canExportList`), one audit row per export.
 * Up to EXPORT_DIRECT_MAX_ROWS rows the file is returned at once; above that the export is queued
 * (`list.export`, or run after the response when no worker is deployed) and the user is sent to the
 * exports page and notified when the file is ready.
 */
export async function handleListExport(req: NextRequest, tenant: string, list: ExportListKey): Promise<NextResponse> {
  const ctx = await requirePage(tenant, list);
  if (!canExportList(ctx.role, list)) return new NextResponse("forbidden", { status: 403 });
  const query = canonicalQuery(Object.fromEntries(req.nextUrl.searchParams.entries()));
  const params = queryParams(query);
  const scope: ExportScope = { tenantId: ctx.tenant.id, userId: ctx.user.id, orderNumberPrefix: ctx.tenant.orderNumberPrefix, country: ctx.tenant.country, settings: ctx.settings };
  const s = (tx: Parameters<Parameters<typeof ctx.run>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
  const total = await ctx.run((tx) => countListExport(s(tx), list, params, scope));
  if (total > EXPORT_DIRECT_MAX_ROWS) {
    const exportId = await ctx.run(async (tx) => {
      const id = await requestListExport(s(tx), { list, query, userId: ctx.user.id, expectedRows: Math.min(total, EXPORT_MAX_ROWS) });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "export.csv", entityType: "list_export", entityId: id, metadata: { list, query, rows: total, mode: "background" } });
      return id;
    });
    after(async () => {
      const queued = await enqueue("list.export", { tenantId: ctx.tenant.id, exportId });
      if (!queued) await withTenant(ctx.tenant.id, (tx) => runListExport({ tenantId: ctx.tenant.id, tx, actor: { type: "system", userId: null } }, exportId));
    });
    return NextResponse.redirect(new URL(`/t/${tenant}/exports?queued=${exportId}`, req.nextUrl.origin), 303);
  }
  const { csv, rows } = await ctx.run(async (tx) => {
    const r = await buildListCsv(s(tx), list, params, scope, EXPORT_DIRECT_MAX_ROWS);
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "export.csv", entityType: list, metadata: { list, query, rows: r.rows, mode: "direct" } });
    return r;
  });
  return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${exportFileName(list)}"`, "x-export-rows": String(rows), "cache-control": "no-store" } });
}
