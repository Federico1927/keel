import { NextResponse, type NextRequest } from "next/server";
import { canDo, isPageEnabled } from "@keel/config";
import { and, eq, schema } from "@keel/db";
import { segmentMembers } from "@keel/services";
import { ForbiddenError, requirePage } from "@/server/tenant";

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the segment members (profile fields, plus the group with the customer-campaigns add-on); requires the export action. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "segments");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("not found", { status: 404 });
    throw e;
  }
  if (!canDo(ctx.role, "export")) return new NextResponse("forbidden", { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("not found", { status: 404 });
  const data = await ctx.run(async (tx) => {
    const [segment] = await tx.select({ id: schema.segments.id, name: schema.segments.name }).from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenant.id), eq(schema.segments.id, id))).limit(1);
    if (!segment) return null;
    const rows = await segmentMembers({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, id);
    return { segment, rows };
  });
  if (!data) return new NextResponse("not found", { status: 404 });
  // the group column exists only with the customer-campaigns add-on; without it every member is exported alike
  const groups = isPageEnabled("customer_campaigns", ctx.activeAddons);
  const header = ["customer_id", "first_name", "last_name", "email", "phone", "country", "city", "accepts_marketing", ...(groups ? ["group"] : []), "orders_count", "total_spent", "aov", "last_order_at", "days_since_last_order", "rfm_tier", "tags"];
  const lines = data.rows.map((r) => [r.customerId, r.firstName, r.lastName, r.email, r.phone, r.country, r.city, r.acceptsMarketing, ...(groups ? [r.groupName] : []), r.ordersCount, (r.totalSpentMinor / 100).toFixed(2), r.aovMinor === null ? null : (r.aovMinor / 100).toFixed(2), r.lastOrderAt ? r.lastOrderAt.toISOString() : null, r.daysSinceLastOrder, r.tier, r.tags.join("|")].map(cell).join(","));
  const slug = data.segment.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "segment";
  return new NextResponse([header.join(","), ...lines].join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="segment-${slug}.csv"` } });
}
