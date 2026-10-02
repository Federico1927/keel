import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { DASHBOARD_LAYOUT_VERSION, hullwiseTemplate, type DashboardWidget } from "@hullwise/config";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const SALE = ["confirmed", "fulfilling", "shipped", "delivered", "returned_partial"];

/**
 * Tenant dashboards (issue #43). Northwind customised its home: Hullwise's tiles plus "Contribution per
 * order" (a custom metric), the monthly revenue target and a note for the team, and a marketing home
 * variant with the ads widgets. Harbor Home keeps Hullwise's template (no home row), so both states show in
 * the demo; it only carries a revenue target, which its template home does not display.
 */
export async function seedDashboards(db: Db, userIds: Record<string, string>, key: "northwind" | "harbor", tenantId: string, now: Date): Promise<void> {
  await db.delete(schema.metricTargets).where(eq(schema.metricTargets.tenantId, tenantId));
  const it = key === "northwind";
  const owner = userIds[it ? "owner@northwind.demo" : "owner@harborhome.demo"] ?? null;
  // the target is last month's sales plus 8 %, rounded: deterministic for a given seed
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const [sales] = await db.select({ v: sql<number>`coalesce(sum(${schema.orders.totalMinor} - ${schema.orders.refundedMinor} - ${schema.orders.taxMinor}), 0)::bigint` }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), gte(schema.orders.placedAt, lastMonth), lt(schema.orders.placedAt, thisMonth), inArray(schema.orders.status, SALE)));
  const target = Math.max(100_000, Math.round((Number(sales?.v ?? 0) * 1.08) / 100_000) * 100_000);
  const months = [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)), lastMonth, thisMonth];
  await db.insert(schema.metricTargets).values(months.map((m, i) => ({ tenantId, metric: "net_revenue", month: monthKey(m), target: Math.round(target * (0.94 + i * 0.03)), createdBy: owner })));
  if (!it) return;

  await db.insert(schema.customMetrics).values({ tenantId, key: "contribution_per_order", label: "Contribuzione per ordine", translations: { en: "Contribution per order", es: "Contribución por pedido" }, formula: "contribution / orders", format: "money", higherIsBetter: true, description: "Margine di contribuzione medio di un ordine di vendita.", createdBy: owner }).onConflictDoNothing();
  const w = (id: string, type: DashboardWidget["type"], settings: Record<string, unknown>, size: Partial<Pick<DashboardWidget, "w" | "h" | "period">> = {}): DashboardWidget => ({ id, type, w: size.w ?? 1, h: size.h ?? 1, period: size.period ?? null, settings });
  const home: DashboardWidget[] = [
    ...hullwiseTemplate(["addon.cod"]),
    w("nw-cpo", "kpi", { metric: "custom:contribution_per_order", compare: "previous", sparkline: true }, { period: "mtd" }),
    w("nw-target", "target", { metric: "net_revenue" }),
    w("nw-review", "queue_review", {}),
    w("nw-note", "note", { markdown: "## Routine del mattino\n- Prima gli ordini **in ritardo di spedizione**\n- Poi le eccezioni di consegna\n- Controlla la [coda in attesa di stock](/t/northwind-apparel/orders?stock=awaiting)", translations: { en: "## Morning routine\n- **Late to ship** orders first\n- Then delivery exceptions\n- Check the [awaiting stock queue](/t/northwind-apparel/orders?stock=awaiting)" } }),
  ];
  const marketing: DashboardWidget[] = [
    w("mk-meta-spend", "kpi", { metric: "meta_spend", compare: "previous", sparkline: false }),
    w("mk-meta-roas", "kpi", { metric: "meta_roas", compare: "previous", sparkline: false }),
    w("mk-google-spend", "kpi", { metric: "google_spend", compare: "previous", sparkline: false }),
    w("mk-mer", "kpi", { metric: "mer", compare: "previous", sparkline: true }),
    w("mk-series", "timeseries", { metrics: ["ad_spend", "contribution"], chart: "bar", granularity: "week" }, { w: 2, h: 2, period: "90d" }),
    w("mk-platform", "breakdown", { metric: "ad_spend", by: "platform", limit: 5 }, { w: 2, h: 2 }),
    w("mk-campaigns", "top_list", { entity: "campaigns", limit: 6 }, { w: 2, h: 2 }),
    w("mk-alerts", "alerts", { limit: 5 }, { w: 2, h: 2 }),
  ];
  await db.insert(schema.dashboards).values([
    { tenantId, scope: "tenant", isHome: true, roles: [], layoutVersion: DASHBOARD_LAYOUT_VERSION, name: "Home Northwind", widgets: home, settings: { period: "30d" }, publishedAt: now, updatedBy: owner },
    { tenantId, scope: "role", isHome: true, roles: ["marketing"], layoutVersion: DASHBOARD_LAYOUT_VERSION, name: "Marketing", widgets: marketing, settings: { period: "30d" }, publishedAt: now, updatedBy: owner },
    { tenantId, scope: "tenant", isHome: false, roles: ["owner", "admin", "marketing"], layoutVersion: DASHBOARD_LAYOUT_VERSION, name: "Revisione settimanale", widgets: [w("wr-rev", "kpi", { metric: "net_revenue" }), w("wr-contr", "kpi", { metric: "contribution" }), w("wr-ret", "kpi", { metric: "returns_rate" }), w("wr-stock", "kpi", { metric: "stock_value_cost", sparkline: false }), w("wr-channel", "breakdown", { metric: "net_revenue", by: "channel" }, { w: 2, h: 2 }), w("wr-products", "top_list", { entity: "products", limit: 8 }, { w: 2, h: 2 })], settings: { period: "7d" }, publishedAt: now, updatedBy: owner },
  ]);
}
