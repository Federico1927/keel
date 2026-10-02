import { NextResponse, type NextRequest } from "next/server";
import { campaignDailyLedger } from "@hullwise/services";
import { ForbiddenError, requirePage } from "@/server/tenant";
import { resolvePeriod } from "@/server/period";

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of the ads daily ledger; same guards and period semantics as the page. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  let ctx;
  try {
    ctx = await requirePage(tenant, "campaigns");
  } catch (e) {
    if (e instanceof ForbiddenError) return new NextResponse("forbidden", { status: 404 });
    throw e;
  }
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const period = resolvePeriod(sp, ctx.tenant.timezone, "7d");
  const at = { id: ctx.tenant.id, country: ctx.tenant.country, currency: ctx.tenant.currency, timezone: ctx.tenant.timezone, settings: ctx.settings };
  const rows = (await ctx.run((tx) => campaignDailyLedger({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, at, period))).filter((r) => !sp.platform || r.platform === sp.platform);
  const header = ["date", "campaign", "platform", "spend", "impressions", "clicks", "orders", "net_revenue", "margin", "profit", "roas", "flags"];
  const lines = rows.map((r) => [r.date, r.campaignName, r.platform, (r.spendMinor / 100).toFixed(2), r.impressions, r.clicks, r.orders, (r.netRevenueMinor / 100).toFixed(2), (r.marginMinor / 100).toFixed(2), (r.profitMinor / 100).toFixed(2), r.roas === null ? null : r.roas.toFixed(4), r.flags.join("|")].map(csvCell).join(","));
  const body = [header.join(","), ...lines].join("\n");
  const name = `ads-ledger-${period.from.toISOString().slice(0, 10)}-${new Date(period.to.getTime() - 1).toISOString().slice(0, 10)}.csv`;
  return new NextResponse(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
}
