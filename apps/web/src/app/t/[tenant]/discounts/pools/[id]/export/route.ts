import { NextResponse, type NextRequest } from "next/server";
import { canExportList } from "@keel/config";
import { POOL_CODE_STATUSES, type PoolCodeStatus } from "@keel/core";
import { recordAudit } from "@keel/db";
import { PoolError, poolCodesCsv, poolCodesForExport } from "@keel/services";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requirePage } from "@/server/tenant";

const HEADER = ["code", "status", "active", "assigned_customer_email", "assigned_campaign", "assigned_at", "redeemed_order", "redeemed_at"];

/** CSV of a pool's codes with status, assignment and the order that used each one (same filters as the page); one audit row per export. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "discounts");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("not found", { status: 404 });
    throw e;
  }
  if (!canExportList(ctx.role, "discounts")) return new NextResponse("forbidden", { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") === "inactive" || (POOL_CODE_STATUSES as readonly string[]).includes(sp.get("status") ?? "") ? (sp.get("status") as PoolCodeStatus | "inactive") : undefined;
  const q = sp.get("q")?.trim() || undefined;
  try {
    const csv = await ctx.run(async (tx) => {
      const rows = await poolCodesForExport({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id, { status, q });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "export.csv", entityType: "discount_pool", entityId: id, metadata: { list: "discount_pool_codes", status: status ?? null, q: q ?? null, rows: rows.length, mode: "direct" } });
      return poolCodesCsv(rows, HEADER, { date: (d) => d.toISOString(), status: (s) => s, yes: "true", no: "false" });
    });
    return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="discount-pool-${id.slice(0, 8)}.csv"`, "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof PoolError) return new NextResponse("not found", { status: 404 });
    throw e;
  }
}
