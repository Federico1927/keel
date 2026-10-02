import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { parseTenantSettings } from "@hullwise/core";
import { attributionReport, blendedForPeriod, creativePerformance, evaluateAlertRules, listCustomMetrics, ltvReport, metricValues, drainEmailJobs, mockEmailOutbox, mockSinkFor, saveAlertRule, saveCustomMetric, upsertPeriodCost, pnlForPeriod, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
let tenant: AnalyticsTenant;
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  tenantId = ctx.tenantIds.northwind;
  tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds["owner@northwind.demo"]! } }), pools.app);
const period = () => ({ from: new Date(Date.now() - 90 * 864e5), to: new Date() });

describe("attribution models on seeded journeys", () => {
  it("every model credits the same total revenue; the platform claim gives paid channels more than last click", async () => {
    const p = period();
    const linear = await run((s) => attributionReport(s, tenant, p, "linear", "channel"));
    const last = await run((s) => attributionReport(s, tenant, p, "last_click", "channel"));
    const total = (rows: typeof linear) => rows.reduce((s, r) => s + r.netMinor, 0);
    expect(linear.length).toBeGreaterThan(2);
    expect(Math.abs(total(linear) - total(last))).toBeLessThan(linear.length + 2);
    const paid = linear.find((r) => r.key === "paid_social")!;
    expect(paid.platformClaim.netMinor).toBeGreaterThanOrEqual(paid.lastClick.netMinor);
    expect(paid.spendMinor).toBeGreaterThan(0);
    const byCampaign = await run((s) => attributionReport(s, tenant, p, "time_decay", "campaign"));
    expect(byCampaign.some((r) => r.platform === "meta" && r.declared !== null)).toBe(true);
  });
});

describe("creatives", () => {
  it("returns ad-level spend, real orders and fatigue; groups by format", async () => {
    const p = period();
    const rows = await run((s) => creativePerformance(s, tenant, p, "creative"));
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some((r) => r.orders > 0)).toBe(true);
    expect(rows.some((r) => r.fatigue && r.fatigue.level !== "no_data")).toBe(true);
    const byFormat = await run((s) => creativePerformance(s, tenant, p, "format"));
    expect(byFormat.map((r) => r.key).sort()).toEqual(expect.arrayContaining(["video"]));
    expect(byFormat.reduce((s, r) => s + r.spendMinor, 0)).toBe(rows.reduce((s, r) => s + r.spendMinor, 0));
  });
});

describe("blended, LTV, custom metrics", () => {
  it("blended ratios and LTV rows exist on the seed", async () => {
    const b = await run((s) => blendedForPeriod(s, tenant, period()));
    expect(b.mer).toBeGreaterThan(0);
    expect(b.newCustomers).toBeGreaterThan(0);
    const ltv = await run((s) => ltvReport(s, tenant, "cohort"));
    expect(ltv.length).toBeGreaterThan(3);
    expect(ltv.some((r) => r.windows.find((w) => w.window === 90)!.avgNetMinor !== null)).toBe(true);
  });
  it("evaluates custom formulas over base metrics and rejects unknown names", async () => {
    await run((s) => saveCustomMetric(s, { key: "Profit Ratio", label: "Profit ratio", formula: "operating_profit / net_revenue", format: "percent" }));
    expect((await run((s) => listCustomMetrics(s))).some((m) => m.key === "profit_ratio")).toBe(true);
    const p = period();
    const prev = { from: new Date(p.from.getTime() - 90 * 864e5), to: p.from };
    const vals = await run((s) => metricValues(s, tenant, p, prev, ["net_revenue", "custom:profit_ratio", "custom:missing"]));
    const pnl = await run((s) => pnlForPeriod(s, tenant, p));
    expect(vals[1]!.value).toBeCloseTo(pnl.operatingProfitMinor / pnl.netRevenueMinor, 6);
    expect(vals[2]!.value).toBeNull();
    await expect(run((s) => saveCustomMetric(s, { key: "bad", label: "Bad", formula: "foo * 2", format: "number" }))).rejects.toThrow(/unknown metric/);
  });
  it("period costs change the P/L source", async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await run((s) => upsertPeriodCost(s, { period: month, kind: "shipping", label: "", estimateMinor: 1000, actualMinor: 4321 }));
    const p = { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
    const pnl = await run((s) => pnlForPeriod(s, tenant, p));
    expect(pnl.costSources.shipping).toBe("actual");
    expect(pnl.shippingCostMinor).toBe(4321);
  });
});

describe("alerts", () => {
  it("fires a threshold rule once, respects the cooldown, delivers in-app and by mock email/Slack", async () => {
    const owner = ctx.userIds["owner@northwind.demo"]!;
    await withTenant(tenantId, (tx) => tx.insert(schema.integrations).values({ tenantId, provider: "slack", status: "connected", mode: "mock" }).onConflictDoNothing(), pools.admin);
    const id = await run((s) => saveAlertRule(s, { name: "Orders above zero", metric: "orders", condition: { kind: "threshold", op: "gt", value: -1, days: 1 }, channels: ["in_app", "email", "slack"], recipients: [owner], cooldownHours: 24, isActive: true }));
    const first = await run((s) => evaluateAlertRules(s, tenant, { ruleId: id }));
    expect(first.fired.map((f) => f.ruleId)).toEqual([id]);
    const again = await run((s) => evaluateAlertRules(s, tenant, { ruleId: id }));
    expect(again.fired).toEqual([]);
    const [ev] = await withTenant(tenantId, (tx) => tx.select().from(schema.alertEvents).where(eq(schema.alertEvents.ruleId, id)), pools.app);
    expect(ev!.delivered).toMatchObject({ in_app: "ok", email: "queued", slack: "mock" });
    expect(mockSinkFor(tenantId)!.sent.length).toBeGreaterThan(0);
    await drainEmailJobs(pools.admin);
    expect(mockEmailOutbox().to("owner@northwind.demo").some((m) => m.message.subject === "Orders above zero")).toBe(true);
    const notes = await withTenant(tenantId, (tx) => tx.select().from(schema.notifications).where(eq(schema.notifications.type, "alert")), pools.app);
    expect(notes.length).toBeGreaterThan(0);
  });
});
