import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings } from "@keel/core";
import { normalizeLayout, type TenantRole } from "@keel/config";
import {
  CORE_WIDGET_LOADERS,
  DashboardError,
  MetricDefinitionError,
  campaignsWithEconomics,
  createDashboard,
  currentTarget,
  customiseHome,
  deleteDashboard,
  deleteTenantMetric,
  getDashboard,
  listDashboards,
  listTenantMetrics,
  loadWidgetData,
  orderPnlTable,
  pnlForPeriod,
  resetHomeToTemplate,
  resolveHomeDashboard,
  saveDashboard,
  saveTenantMetric,
  setMetricTarget,
  tenantMetricSeries,
  tenantMetricValues,
  userDashboard,
  validateLayout,
  type AnalyticsTenant,
  type ServiceContext,
  type TargetData,
  type WidgetEnv,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let A = "";
let B = "";
let nw: AnalyticsTenant;
let hb: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  A = ctx.tenantIds.northwind;
  B = ctx.tenantIds.harbor;
  nw = { id: A, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
  hb = { id: B, country: "US", currency: "USD", timezone: "America/New_York", settings: parseTenantSettings({}) };
});
afterAll(() => pools.close());

const runAs = <T>(tenantId: string, email: string, fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email] ?? null } }), pools.app);
const runA = <T>(fn: (s: ServiceContext) => Promise<T>) => runAs(A, "owner@northwind.demo", fn);
const runB = <T>(fn: (s: ServiceContext) => Promise<T>) => runAs(B, "owner@harborhome.demo", fn);
const period = () => ({ from: new Date(Date.now() - 90 * 864e5), to: new Date() });
const envFor = async (tenant: AnalyticsTenant, role: TenantRole, addons: string[]): Promise<WidgetEnv> => ({ tenant, role, activeAddons: addons, userId: null, customs: await withTenant(tenant.id, (tx) => listTenantMetrics({ tenantId: tenant.id, tx, actor: { type: "system", userId: null } }), pools.app) });

describe("custom metrics over filtered orders", () => {
  it("contribution / orders filtered to paid social equals the per-order P/L by hand, and the change is audited", async () => {
    await runA((s) => saveTenantMetric(s, { key: "cpo_paid_social", label: "Contribution per paid-social order", formula: "contribution / orders", format: "money", filters: { channel: ["paid_social"] } }));
    const p = period();
    const [v] = await runA((s) => tenantMetricValues(s, nw, p, null, ["custom:cpo_paid_social"]));
    // the P/L by hand: every paid-social sale order of the period, revenue − goods − shipping − fee − its return costs
    const table = await runA((s) => orderPnlTable(s, nw, p, { channel: "paid_social" }, 1, 0));
    expect(table.totals.orders).toBeGreaterThan(0);
    const byHand = table.rows.reduce((t, r) => t + (r.netRevenueMinor - r.cogsMinor - r.shippingCostMinor - r.paymentFeeMinor - r.returnCostMinor), 0) / table.rows.length;
    expect(v!.value).toBeCloseTo(byHand, 6);
    expect(v!.value).toBeCloseTo(table.totals.contributionMinor / table.totals.orders, 6);
    expect(v!.filters).toEqual({ channel: ["paid_social"] });
    const audit = await withTenant(A, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, A), eq(schema.auditLogs.action, "custom_metric.created"))), pools.app);
    expect(audit.some((r) => (r.diff as Record<string, { to: unknown }>).formula?.to === "contribution / orders")).toBe(true);
  });

  it("unfiltered metrics match the period P/L; period-only bases are refused with filters", async () => {
    await runA((s) => saveTenantMetric(s, { key: "cpo_all", label: "Contribution per order", formula: "contribution / orders", format: "money" }));
    const p = period();
    const [v] = await runA((s) => tenantMetricValues(s, nw, p, null, ["custom:cpo_all"]));
    const pnl = await runA((s) => pnlForPeriod(s, nw, p));
    expect(v!.value).toBeCloseTo(pnl.contributionMinor / pnl.orders, 6);
    await expect(runA((s) => saveTenantMetric(s, { key: "bad", label: "Bad", formula: "operating_profit / orders", format: "money", filters: { country: ["IT"] } }))).rejects.toThrow(MetricDefinitionError);
    await expect(runA((s) => saveTenantMetric(s, { key: "bad2", label: "Bad", formula: "orders", format: "number", filters: { evil: "1" } }))).rejects.toThrow(/invalid_filters/);
  });

  it("extended base metrics come from the inventory, purchasing and campaign services", async () => {
    const p = period();
    const vals = await runA((s) => tenantMetricValues(s, nw, p, null, ["stock_value_cost", "coverage_days", "out_of_stock_variants", "incoming_po_value", "returns_rate", "cancel_rate", "repeat_customer_rate", "meta_spend", "google_roas"]));
    const by = Object.fromEntries(vals.map((x) => [x.ref, x.value]));
    expect(by.stock_value_cost).toBeGreaterThan(0);
    expect(by.coverage_days).not.toBeNull();
    expect(by.returns_rate).toBeGreaterThan(0);
    expect(by.returns_rate).toBeLessThan(1);
    expect(by.repeat_customer_rate).toBeGreaterThan(0);
    const meta = await runA((s) => campaignsWithEconomics(s, nw, p, { platform: "meta" }));
    expect(by.meta_spend).toBe(meta.reduce((t, c) => t + c.metrics.spendMinor, 0));
    expect(vals.find((x) => x.ref === "stock_value_cost")!.kind).toBe("snapshot");
  });

  it("weekly series add up to the period P/L", async () => {
    const p = { from: new Date(Date.UTC(2026, 0, 5)), to: new Date(Date.UTC(2026, 2, 2)) };
    const s = await runA((x) => tenantMetricSeries(x, nw, p, "week", ["ad_spend", "contribution", "custom:cpo_paid_social"]));
    const pnl = await runA((x) => pnlForPeriod(x, nw, p));
    expect(s.buckets.length).toBe(8);
    expect(s.series[0]!.values.reduce<number>((t, v) => t + (v ?? 0), 0)).toBe(pnl.adSpendMinor);
    expect(s.series[1]!.values.reduce<number>((t, v) => t + (v ?? 0), 0)).toBe(pnl.contributionMinor);
    expect(s.series[2]!.values.some((v) => v !== null)).toBe(true);
  });

  it("monthly targets carry forward and feed the target widget's projection", async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await runA((s) => setMetricTarget(s, { metric: "orders", month: "2020-01", target: 50 }));
    expect((await runA((s) => currentTarget(s, nw, "orders")))?.target).toBe(50);
    await runA((s) => setMetricTarget(s, { metric: "orders", month, target: 400 }));
    expect(await runA((s) => currentTarget(s, nw, "orders"))).toMatchObject({ target: 400, ownMonth: true });
    const env = await envFor(nw, "owner", ["addon.cod"]);
    const r = await runA((s) => loadWidgetData(s, env, { type: "target", settings: { metric: "orders" } }, period()));
    expect(r.ok).toBe(true);
    const d = (r as { data: TargetData }).data;
    expect(d.target).toBe(400);
    expect(d.projected === null || d.projected >= (d.value.value ?? 0)).toBe(true);
  });
});

describe("dashboards", () => {
  it("each role sees its home: the marketing variant, the tenant home, or Keel's template for Harbor", async () => {
    const mk = await runA((s) => resolveHomeDashboard(s, "marketing", ["addon.cod"]));
    expect(mk.scope).toBe("role");
    expect(mk.widgets.some((w) => w.settings.metric === "meta_roas")).toBe(true);
    const ops = await runA((s) => resolveHomeDashboard(s, "operations", ["addon.cod"]));
    expect(ops.scope).toBe("tenant");
    expect(ops.widgets.some((w) => w.settings.metric === "custom:contribution_per_order")).toBe(true);
    const harbor = await runB((s) => resolveHomeDashboard(s, "owner", []));
    expect(harbor.isTemplate).toBe(true);
    expect(harbor.widgets.map((w) => w.type)).toEqual(["today_kpis", "sales_30d", "month_forecast", "work_queue", "stock_backorders", "today_by_status"]);
    const opsList = await runA((s) => listDashboards(s, { role: "operations", userId: ctx.userIds["ops@northwind.demo"]!, personalAllowed: true }));
    expect(opsList.some((d) => d.scope === "role")).toBe(false);
  });

  it("COD widgets are refused without addon.cod: not saved and no data", async () => {
    const cod = [{ id: "c", type: "cod_queue", settings: {} }];
    expect(() => validateLayout(cod, [])).toThrow(DashboardError);
    expect(validateLayout(cod, ["addon.cod"])).toHaveLength(1);
    const env = await envFor(hb, "owner", []);
    expect(await runB((s) => loadWidgetData(s, env, { type: "cod_queue", settings: {} }, period()))).toEqual({ ok: false, reason: "module_disabled" });
  });

  it("a widget whose loader throws gives an error result, the others still load", async () => {
    const env = await envFor(nw, "owner", ["addon.cod"]);
    const loaders = { ...CORE_WIDGET_LOADERS, kpi: async () => { throw new Error("boom"); } };
    const bad = await runA((s) => loadWidgetData(s, env, { type: "kpi", settings: { metric: "orders" } }, period(), loaders));
    expect(bad).toMatchObject({ ok: false, reason: "failed", message: "boom" });
    const good = await runA((s) => loadWidgetData(s, env, { type: "queue_review", settings: {} }, period(), loaders));
    expect(good.ok).toBe(true);
  });

  it("a widget whose metric the role cannot open is refused for that role", async () => {
    const care = await envFor(nw, "customer_care", ["addon.cod"]);
    expect(await runA((s) => loadWidgetData(s, care, { type: "kpi", settings: { metric: "meta_roas" } }, period()))).toMatchObject({ ok: false, reason: "forbidden" });
    const mk = await envFor(nw, "marketing", ["addon.cod"]);
    expect((await runA((s) => loadWidgetData(s, mk, { type: "kpi", settings: { metric: "meta_roas" } }, period()))).ok).toBe(true);
  });

  it("customise, draft, publish and reset: drafts stay invisible until published, every step audited", async () => {
    const home = await runB((s) => customiseHome(s, { activeAddons: [], name: "Home" }));
    const widgets = [...normalizeLayout(2, home.widgets), { id: "k1", type: "kpi", settings: { metric: "net_revenue" } }];
    await runB((s) => saveDashboard(s, home.id, { widgets }, { activeAddons: [] }));
    expect((await runB((s) => resolveHomeDashboard(s, "operations", []))).widgets.some((w) => w.id === "k1")).toBe(false);
    await runB((s) => saveDashboard(s, home.id, { widgets, publish: true }, { activeAddons: [] }));
    expect((await runB((s) => resolveHomeDashboard(s, "operations", []))).widgets.some((w) => w.id === "k1")).toBe(true);
    await expect(runB((s) => saveDashboard(s, home.id, { widgets: Array.from({ length: 25 }, (_, i) => ({ id: `x${i}`, type: "note", settings: {} })) }, { activeAddons: [] }))).rejects.toThrow(/too_many_widgets/);
    expect(await runB((s) => resetHomeToTemplate(s, "all"))).toBe(1);
    expect((await runB((s) => resolveHomeDashboard(s, "operations", []))).isTemplate).toBe(true);
    const actions = (await withTenant(B, (tx) => tx.select({ a: schema.auditLogs.action }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, B), eq(schema.auditLogs.entityType, "dashboard"))), pools.app)).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["dashboard.created", "dashboard.draft_saved", "dashboard.published", "dashboard.reset_to_template"]));
  });

  it("a role can be in one home variant only", async () => {
    await expect(runA((s) => createDashboard(s, { name: "Dup", scope: "role", roles: ["marketing"], widgets: [] }, { activeAddons: ["addon.cod"] }))).rejects.toThrow(/role_taken/);
  });

  it("the Analytics 'My dashboard' (layout version 1) still loads", async () => {
    const legacy = await runA((s) => userDashboard(s, ctx.userIds["owner@northwind.demo"]!));
    expect(legacy?.layoutVersion).toBe(1);
    expect(normalizeLayout(legacy!.layoutVersion, legacy!.widgets).every((w) => w.type === "kpi")).toBe(true);
  });
});

describe("isolation of dashboards and metrics", () => {
  it("tenant B can neither read nor change tenant A's dashboards or metrics", async () => {
    const aHome = await runA((s) => resolveHomeDashboard(s, "owner", ["addon.cod"]));
    expect(aHome.id).toBeTruthy();
    expect(await runB((s) => getDashboard(s, aHome.id!))).toBeNull();
    await expect(runB((s) => saveDashboard(s, aHome.id!, { widgets: [], publish: true }, { activeAddons: [] }))).rejects.toThrow(/not_found/);
    await expect(runB((s) => deleteDashboard(s, aHome.id!))).rejects.toThrow(/not_found/);
    expect((await runB((s) => listDashboards(s, { role: "owner", userId: ctx.userIds["owner@harborhome.demo"]!, personalAllowed: true }))).some((d) => d.id === aHome.id)).toBe(false);
    const aMetric = (await runA((s) => listTenantMetrics(s))).find((m) => m.key === "contribution_per_order")!;
    expect(await runB((s) => deleteTenantMetric(s, aMetric.id))).toBe(false);
    expect((await runB((s) => listTenantMetrics(s))).some((m) => m.id === aMetric.id)).toBe(false);
    // the same key in B is B's own metric, A's stays untouched
    await runB((s) => saveTenantMetric(s, { key: "contribution_per_order", label: "Mine", formula: "orders", format: "number" }));
    expect((await runA((s) => listTenantMetrics(s))).find((m) => m.key === "contribution_per_order")!.formula).toBe("contribution / orders");
    expect((await runA((s) => getDashboard(s, aHome.id!)))?.widgets).toEqual(expect.any(Array));
  });
});
