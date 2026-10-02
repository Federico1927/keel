import { describe, expect, it } from "vitest";
import { KEEL_TEMPLATE, WIDGETS, availableWidgetTypes, canEditDashboard, canSeeDashboard, isWidgetVisible, keelTemplate, metricPages, normalizeLayout, normalizeMetricFilters, parseWidget } from "./dashboards";

const noCustom = () => null;

describe("widget catalog", () => {
  it("never offers an add-on widget to a tenant without the add-on", () => {
    expect(availableWidgetTypes([])).not.toContain("cod_queue");
    expect(availableWidgetTypes(["addon.cod"])).toContain("cod_queue");
    expect(WIDGETS.cod_queue.module).toBe("addon.cod");
  });
  it("hides widgets whose page or metrics the role cannot open", () => {
    const ads = { type: "kpi" as const, settings: { metric: "meta_roas" } };
    expect(isWidgetVisible(ads, "marketing", [], noCustom)).toBe(true);
    expect(isWidgetVisible(ads, "customer_care", [], noCustom)).toBe(false);
    expect(isWidgetVisible({ type: "queue_review", settings: {} }, "marketing", [], noCustom)).toBe(true);
    expect(isWidgetVisible({ type: "queue_integrations", settings: {} }, "customer_care", [], noCustom)).toBe(false);
    expect(isWidgetVisible({ type: "cod_queue", settings: {} }, "owner", [], noCustom)).toBe(false);
    // a custom metric needs every page its bases need
    expect(metricPages("custom:x", () => ["net_revenue", "stock_value_cost"]).sort()).toEqual(["analytics", "inventory"]);
    expect(isWidgetVisible({ type: "kpi", settings: { metric: "custom:x" } }, "customer_care", [], () => ["orders"])).toBe(false);
  });
  it("parses widgets with defaults and drops invalid ones", () => {
    expect(parseWidget({ id: "a", type: "timeseries", w: 1, settings: { metrics: ["ad_spend", "contribution"], granularity: "week" } })).toMatchObject({ w: 2, settings: { chart: "line", granularity: "week" } });
    expect(parseWidget({ id: "a", type: "nope" })).toBeNull();
    expect(parseWidget({ id: "a", type: "timeseries", settings: { metrics: ["a", "b", "c", "d"] } })).toBeNull();
    expect(parseWidget({ id: "bad id", type: "kpi" })).toBeNull();
  });
  it("loads version-1 personal dashboards as KPI tiles", () => {
    const w = normalizeLayout(1, [{ metric: "net_revenue" }, { metric: "custom:profit_per_order" }, { junk: true }]);
    expect(w.map((x) => [x.type, x.settings.metric])).toEqual([["kpi", "net_revenue"], ["kpi", "custom:profit_per_order"]]);
    expect(normalizeLayout(2, [{ id: "k", type: "kpi", settings: { metric: "orders" } }, { id: "z", type: "gone" }])).toHaveLength(1);
  });
  it("the Keel template is today's home and only holds core widgets", () => {
    expect(KEEL_TEMPLATE.map((w) => w.type)).toEqual(["today_kpis", "sales_30d", "month_forecast", "work_queue", "stock_backorders", "today_by_status"]);
    expect(keelTemplate([])).toHaveLength(KEEL_TEMPLATE.length);
  });
});

describe("dashboard permissions", () => {
  const tenantDash = { scope: "tenant", userId: null, roles: [] as string[] };
  it("only owner and admin edit tenant dashboards; a personal one belongs to its user", () => {
    expect(canEditDashboard("owner", "u1", tenantDash, true)).toBe(true);
    expect(canEditDashboard("viewer", "u1", tenantDash, true)).toBe(false);
    expect(canEditDashboard("operations", "u1", tenantDash, true)).toBe(false);
    expect(canEditDashboard("viewer", "u1", { scope: "personal", userId: "u1" }, true)).toBe(true);
    expect(canEditDashboard("viewer", "u1", { scope: "personal", userId: "u1" }, false)).toBe(false);
    expect(canEditDashboard("owner", "u1", { scope: "personal", userId: "u2" }, true)).toBe(false);
  });
  it("role dashboards are seen by their roles and by managers", () => {
    const mk = { scope: "role", userId: null, roles: ["marketing"] };
    expect(canSeeDashboard("marketing", "u", mk, true)).toBe(true);
    expect(canSeeDashboard("operations", "u", mk, true)).toBe(false);
    expect(canSeeDashboard("admin", "u", mk, true)).toBe(true);
  });
});

describe("metric filters", () => {
  it("normalizes empty filters to null and validates values", () => {
    expect(normalizeMetricFilters({ channel: [] })).toBeNull();
    expect(normalizeMetricFilters({ channel: ["paid_social"], country: ["it"] })).toEqual({ channel: ["paid_social"], country: ["IT"] });
    expect(normalizeMetricFilters({ sql: "drop table" })).toBeNull();
  });
});
