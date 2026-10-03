import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, sql, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { DEMO_TENANTS, seedDomain, seedPlatform, type SeedContext } from "@hullwise/db/seed";
import { isPageEnabled } from "@hullwise/config";
import { addDaysToKey, localDateKey, parseTenantSettings, pct, type TenantSettings } from "@hullwise/core";
import { ACCOUNTING_MCP_TOOLS, AccountingError, accountingPushLog, accountingReconciliation, dailySalesSummaryFor, getAccountingProviderFor, mockAccountingFor, repushAccountingDay, resetMockAccounting, retryAccountingDay, runAccountingPush, salesDayOrders, saveAccountingSettings, getAccountingState, toolDenial, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let northwind = "";
let harbor = "";
let nw: AnalyticsTenant;
let hh: AnalyticsTenant;
let settings: TenantSettings;

const DAY = "2024-06-15";
const REFUND_DAY = "2024-06-18";
const ids = { o1: "", o2: "", o3: "" };

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.02 });
  northwind = ctx.tenantIds.northwind;
  harbor = ctx.tenantIds.harbor;
  const tenant = async (id: string): Promise<AnalyticsTenant> => {
    const [t] = await pools.admin.select().from(schema.tenants).where(eq(schema.tenants.id, id));
    return { id, country: t!.country, currency: t!.currency, timezone: t!.timezone, settings: parseTenantSettings(t!.settings) };
  };
  nw = await tenant(northwind);
  hh = await tenant(harbor);
  settings = nw.settings;
  resetMockAccounting();
  // three orders on a quiet day (before the seeded year) in Rome: a card sale with its processor fee, a bank transfer with
  // discount and shipping refunded in part three days later, and a cash-on-delivery order cancelled before payment
  const order = (n: number, v: Partial<typeof schema.orders.$inferInsert>) => ({ tenantId: northwind, orderNumber: 990_000 + n, name: `#NW-T${n}`, externalId: `acct-test-${n}`, currency: "EUR", shippingCountry: "IT", placedAt: new Date("2024-06-15T08:00:00Z"), totalMinor: 0, ...v });
  const [o1] = await pools.admin.insert(schema.orders).values(order(1, { status: "delivered", paymentMethod: "card", paymentStatus: "paid", totalMinor: 12200, taxMinor: 2200, subtotalMinor: 12200 })).returning({ id: schema.orders.id });
  const [o2] = await pools.admin.insert(schema.orders).values(order(2, { status: "returned_partial", paymentMethod: "bank_transfer", paymentStatus: "partially_refunded", totalMinor: 9610, discountMinor: 1000, shippingMinor: 610, taxMinor: 1733, subtotalMinor: 10000, refundedMinor: 4880, placedAt: new Date("2024-06-15T21:30:00Z") })).returning({ id: schema.orders.id });
  const [o3] = await pools.admin.insert(schema.orders).values(order(3, { status: "cancelled", paymentMethod: "cod", paymentStatus: "voided", totalMinor: 5000, taxMinor: 902, subtotalMinor: 5000, cancelledAt: new Date("2024-06-15T12:00:00Z") })).returning({ id: schema.orders.id });
  ids.o1 = o1!.id;
  ids.o2 = o2!.id;
  ids.o3 = o3!.id;
  await pools.admin.insert(schema.orderLines).values([
    { tenantId: northwind, orderId: ids.o1, title: "Coat", quantity: 1, currentQuantity: 1, unitPriceMinor: 12200, totalMinor: 12200 },
    { tenantId: northwind, orderId: ids.o2, title: "Shirt", quantity: 2, currentQuantity: 2, unitPriceMinor: 5000, totalMinor: 10000 },
    { tenantId: northwind, orderId: ids.o3, title: "Belt", quantity: 1, currentQuantity: 1, unitPriceMinor: 5000, totalMinor: 5000 },
  ]);
  await pools.admin.insert(schema.balanceTransactions).values({ tenantId: northwind, externalId: "acct-test-bt-1", type: "charge", orderId: ids.o1, amountMinor: 12200, feeMinor: 380, netMinor: 11820, currency: "EUR", occurredAt: new Date("2024-06-15T08:01:00Z") });
  await pools.admin.insert(schema.orderEvents).values({ tenantId: northwind, orderId: ids.o2, type: "refund_issued", actorType: "user", diff: { refundedMinor: { from: 0, to: 4880 } }, createdAt: new Date("2024-06-18T10:00:00Z") });
});
afterAll(() => pools.close());

const as = (tenantId: string, email: string, now?: Date) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: ctx.userIds[email]! }, now }), pools.app);
const nwOwner = (now?: Date) => as(northwind, "owner@northwind.demo", now);
const hhOwner = <T>(fn: (s: ServiceContext) => Promise<T>) => as(harbor, "owner@harborhome.demo")(fn);
const NOW = new Date("2024-07-01T10:00:00Z");
/** The seeded settings without the start day, so the test days of 2024 can be pushed. */
let mapped: Awaited<ReturnType<typeof getAccountingState>>["settings"];

describe("daily sales summary (core, every tenant)", () => {
  it("matches the hand calculation on three orders: card sale, discounted sale with shipping and a later refund, cancelled COD", async () => {
    const s = await nwOwner()((svc) => dailySalesSummaryFor(svc, nw, { fromDay: DAY, toDay: REFUND_DAY }));
    const d = s.days.find((x) => x.day === DAY)!;
    // #NW-T1: 122.00 incl. 22 % → 100.00 + 22.00; #NW-T2 placed 23:30 in Rome (21:30Z): goods 100.00 − discount 10.00 + shipping 6.10,
    // tax 17.33 split 16.23 goods / 1.10 shipping → discount net 8.20, gross net 81.97, shipping net 5.00; #NW-T3 cancelled unpaid: nothing
    expect(d.orderIds.sort()).toEqual([ids.o1, ids.o2].sort());
    expect(d.rates).toHaveLength(1);
    expect(d.rates[0]).toMatchObject({ rateKey: "IT|2200", grossSalesMinor: 10000 + 8197, discountsMinor: 820, refundsMinor: 0, netSalesMinor: 18197 - 820, shippingMinor: 500, taxMinor: 2200 + 1733, totalMinor: 12200 + 9610, saleOrders: 2 });
    const transferFee = pct(9610, settings.paymentFeeBps.bank_transfer) + settings.paymentFeeFixedMinor.bank_transfer;
    expect(d.fees).toEqual(expect.arrayContaining([{ method: "card", feeMinor: 380, orders: 1, estimatedOrders: 0 }]));
    expect(d.feesMinor).toBe(380 + transferFee);
    expect(d.netMinor).toBe(21810 - 380 - transferFee);
    // refund of 48.80 on the 18th: tax round(48.80 × 17.33 / 96.10) = 8.80, net 40.00
    const r = s.days.find((x) => x.day === REFUND_DAY)!;
    expect(r.rates[0]).toMatchObject({ refundsMinor: 4000, taxMinor: -880, totalMinor: -4880, refundOrders: 1, saleOrders: 0 });
    expect(s.totals.totalMinor).toBe(21810 - 4880);
  });

  it("opens the orders behind a number of the day", async () => {
    const all = await nwOwner()((svc) => salesDayOrders(svc, nw, DAY));
    expect(all.orders.map((o) => o.name)).toEqual(["#NW-T1", "#NW-T2"]);
    const fees = await nwOwner()((svc) => salesDayOrders(svc, nw, DAY, { method: "card" }));
    expect(fees.orders.map((o) => [o.name, o.feeMinor])).toEqual([["#NW-T1", 380]]);
    const refunds = await nwOwner()((svc) => salesDayOrders(svc, nw, REFUND_DAY, { kind: "refund" }));
    expect(refunds.orders.map((o) => [o.name, o.totalMinor])).toEqual([["#NW-T2", -4880]]);
  });

  it("works for a tenant without the add-on and never sees another tenant's orders", async () => {
    expect(isPageEnabled("analytics", DEMO_TENANTS.harbor.addons)).toBe(true);
    const s = await hhOwner((svc) => dailySalesSummaryFor(svc, hh, { fromDay: DAY, toDay: REFUND_DAY }));
    expect(s.totals.totalMinor).toBe(0);
    const recent = await hhOwner((svc) => dailySalesSummaryFor(svc, hh, { fromDay: addDaysToKey(localDateKey(new Date(), hh.timezone), -30), toDay: localDateKey(new Date(), hh.timezone) }));
    expect(recent.totals.saleOrders).toBeGreaterThan(0);
    expect(recent.rateKeys.every((r) => r.country !== "IT")).toBe(true);
  });
});

describe("seeded push log", () => {
  it("Northwind has pushed days, one waiting for a platform write and one failed push; Harbor has none", async () => {
    const log = await nwOwner()((svc) => accountingPushLog(svc, { pageSize: 500 }));
    expect(log.counts.pushed).toBeGreaterThan(5);
    expect(log.counts.waiting).toBe(1);
    expect(log.counts.failed).toBe(1);
    const waiting = log.rows.find((r) => r.current && r.status === "waiting")!;
    expect(waiting.reasons[0]).toMatchObject({ code: "orders_pending_write", count: 1 });
    const failed = log.rows.find((r) => r.current && r.status === "failed")!;
    expect(failed.lastError).toMatch(/rate_limited/);
    const [h] = (await pools.admin.execute<{ n: number }>(sql`select count(*)::int as n from accounting_journals where tenant_id = ${harbor}`)).rows;
    expect(h!.n).toBe(0);
  });

  it("the reconciliation finds the one seeded day pushed before an order synced; every other pushed day matches the summary", async () => {
    const r = await nwOwner()((svc) => accountingReconciliation(svc, nw));
    expect(r.checked).toBeGreaterThan(5);
    expect(r.drifts).toHaveLength(1);
    expect(r.drifts[0]!.differenceMinor).toBeGreaterThan(0);
    expect(r.drifts[0]!.lines.map((l) => l.line)).toEqual(expect.arrayContaining(["sales", "clearing"]));
  });
});

describe("push", () => {
  it("pushes only the days that reconcile, with readable reasons for the others", async () => {
    const seeded = await nwOwner()((svc) => getAccountingState(svc));
    mapped = { ...seeded.settings, startDay: null };
    await nwOwner()((svc) => saveAccountingSettings(svc, mapped));
    const provider = (await nwOwner()((svc) => getAccountingProviderFor(svc)))!;
    expect(provider).toBe(mockAccountingFor(northwind));
    // an order of the 15th waits for a write to the store; today is still open
    await pools.admin.insert(schema.platformWrites).values({ tenantId: northwind, provider: "shopify", kind: "order.tags", entityType: "order", entityId: ids.o1, targetKey: "order:acct-test-1:tags", payload: {}, payloadHash: "x", idempotencyKey: "acct-test-write", status: "pending" });
    const today = localDateKey(NOW, nw.timezone);
    const r = await nwOwner(NOW)((svc) => runAccountingPush(svc, nw, { days: [DAY, REFUND_DAY, today] }));
    expect(r).toMatchObject({ connected: true, pushed: 1, waiting: 2 });
    const log = await nwOwner()((svc) => accountingPushLog(svc, { pageSize: 500 }));
    const row = (day: string) => log.rows.find((x) => x.day === day && x.current)!;
    expect(row(DAY)).toMatchObject({ status: "waiting", reasons: [{ code: "orders_pending_write", count: 1, orders: ["#NW-T1"] }] });
    expect(row(today).reasons.map((x) => x.code)).toEqual(["day_open"]);
    expect(row(REFUND_DAY)).toMatchObject({ status: "pushed", version: 1, totalMinor: -4880 });
    const journal = mockAccountingFor(northwind)!.journals.get(row(REFUND_DAY).externalId!)!.journal;
    expect(journal.lines.reduce((s, l) => s + l.debitMinor, 0)).toBe(journal.lines.reduce((s, l) => s + l.creditMinor, 0));
    expect(journal.lines.find((l) => l.accountCode === "1100")).toMatchObject({ creditMinor: 4880 });
  });

  it("an unmapped line keeps the day waiting until it is mapped", async () => {
    await pools.admin.update(schema.platformWrites).set({ status: "succeeded" }).where(eq(schema.platformWrites.idempotencyKey, "acct-test-write"));
    await nwOwner()((svc) => saveAccountingSettings(svc, { ...mapped, mapping: { ...mapped.mapping, shipping: null } }));
    await nwOwner(NOW)((svc) => runAccountingPush(svc, nw, { days: [DAY] }));
    let log = await nwOwner()((svc) => accountingPushLog(svc, { pageSize: 500 }));
    expect(log.rows.find((x) => x.day === DAY)!.reasons).toEqual([{ code: "mapping_incomplete", lines: ["shipping"] }]);
    await expect(nwOwner()((svc) => saveAccountingSettings(svc, { ...mapped, mapping: { ...mapped.mapping, shipping: "6900" } }))).rejects.toMatchObject({ code: "unknown_account" });
    await nwOwner()((svc) => saveAccountingSettings(svc, mapped));
    const r = await nwOwner(NOW)((svc) => runAccountingPush(svc, nw, { days: [DAY] }));
    expect(r.pushed).toBe(1);
    log = await nwOwner()((svc) => accountingPushLog(svc, { pageSize: 500 }));
    expect(log.rows.find((x) => x.day === DAY && x.current)).toMatchObject({ status: "pushed", version: 1, totalMinor: 21810 });
    const audits = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, northwind), eq(schema.auditLogs.action, "accounting.settings_updated")));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent per (tenant, day): a re-run pushes nothing twice", async () => {
    const before = mockAccountingFor(northwind)!.journals.size;
    const rows = async () => (await pools.admin.select().from(schema.accountingJournals).where(eq(schema.accountingJournals.tenantId, northwind))).length;
    const n = await rows();
    const r = await nwOwner(NOW)((svc) => runAccountingPush(svc, nw, { days: [DAY, REFUND_DAY] }));
    expect(r).toMatchObject({ pushed: 0, skipped: 2 });
    expect(mockAccountingFor(northwind)!.journals.size).toBe(before);
    expect(await rows()).toBe(n);
    // the same idempotency key at the system returns the journal already created
    const replay = await mockAccountingFor(northwind)!.pushJournal({ date: DAY, currency: "EUR", narration: "", reference: "", status: "draft", lines: [{ accountCode: "1100", description: "", debitMinor: 1, creditMinor: 0 }, { accountCode: "4000", description: "", debitMinor: 0, creditMinor: 1 }] }, { idempotencyKey: `${northwind}:${DAY}:v1` });
    expect(replay.replayed).toBe(true);
  });

  it("re-push voids the pushed journal and replaces it with the next version, audited; it refuses a day that does not reconcile", async () => {
    const log = await nwOwner()((svc) => accountingPushLog(svc, { pageSize: 500 }));
    const v1 = log.rows.find((x) => x.day === DAY && x.current)!;
    // a refund recorded after the push: the new version carries it
    await pools.admin.insert(schema.orderEvents).values({ tenantId: northwind, orderId: ids.o1, type: "refund_issued", actorType: "user", diff: { refundedMinor: { from: 0, to: 1220 } }, createdAt: new Date("2024-06-15T15:00:00Z") });
    await pools.admin.update(schema.orders).set({ refundedMinor: 1220, paymentStatus: "partially_refunded" }).where(eq(schema.orders.id, ids.o1));
    const r = await nwOwner(NOW)((svc) => repushAccountingDay(svc, nw, DAY, { note: "late refund" }));
    expect(r).toEqual({ version: 2, status: "pushed" });
    const rows = await pools.admin.select().from(schema.accountingJournals).where(and(eq(schema.accountingJournals.tenantId, northwind), eq(schema.accountingJournals.day, DAY))).orderBy(schema.accountingJournals.version);
    expect(rows.map((x) => [x.version, x.status])).toEqual([[1, "voided"], [2, "pushed"]]);
    expect(rows[0]!.note).toBe("late refund");
    expect(mockAccountingFor(northwind)!.voided).toContain(v1.externalId);
    expect(rows[1]!.externalId).not.toBe(v1.externalId);
    expect((rows[1]!.summary as { totalMinor: number }).totalMinor).toBe(21810 - 1220);
    const [audit] = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, northwind), eq(schema.auditLogs.action, "accounting.journal_repushed")));
    expect(audit!.diff).toMatchObject({ version: { from: 1, to: 2 }, externalId: { from: v1.externalId } });
    expect(audit!.actorUserId).toBe(ctx.userIds["owner@northwind.demo"]);
    // a day that waits cannot be re-pushed, and nothing is voided
    await pools.admin.update(schema.platformWrites).set({ status: "failed" }).where(eq(schema.platformWrites.idempotencyKey, "acct-test-write"));
    const voided = mockAccountingFor(northwind)!.voided.length;
    await expect(nwOwner(NOW)((svc) => repushAccountingDay(svc, nw, DAY))).rejects.toMatchObject({ code: "not_ready" });
    expect(mockAccountingFor(northwind)!.voided.length).toBe(voided);
    await pools.admin.update(schema.platformWrites).set({ status: "succeeded" }).where(eq(schema.platformWrites.idempotencyKey, "acct-test-write"));
    await expect(nwOwner(NOW)((svc) => repushAccountingDay(svc, nw, "2024-06-16"))).rejects.toMatchObject({ code: "not_pushed" });
  });

  it("a refused push fails with the error, waits for its next attempt, and a manual retry pushes it", async () => {
    const day = "2024-06-14";
    await pools.admin.insert(schema.orders).values({ tenantId: northwind, orderNumber: 990_010, name: "#NW-T10", externalId: "acct-test-10", currency: "EUR", shippingCountry: "IT", placedAt: new Date("2024-06-14T09:00:00Z"), status: "delivered", paymentMethod: "card", paymentStatus: "paid", totalMinor: 2440, taxMinor: 440 });
    mockAccountingFor(northwind)!.failures.failNext("rate_limited");
    const r = await nwOwner(NOW)((svc) => runAccountingPush(svc, nw, { days: [day] }));
    expect(r.failed).toBe(1);
    let [row] = await pools.admin.select().from(schema.accountingJournals).where(and(eq(schema.accountingJournals.tenantId, northwind), eq(schema.accountingJournals.day, day)));
    expect(row).toMatchObject({ status: "failed", attempts: 1, lastErrorCode: "rate_limited" });
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect((await nwOwner(NOW)((svc) => runAccountingPush(svc, nw, { days: [day] }))).skipped).toBe(1);
    const retried = await nwOwner(NOW)((svc) => retryAccountingDay(svc, nw, day));
    expect(retried.pushed).toBe(1);
    [row] = await pools.admin.select().from(schema.accountingJournals).where(and(eq(schema.accountingJournals.tenantId, northwind), eq(schema.accountingJournals.day, day)));
    expect(row).toMatchObject({ status: "pushed", attempts: 2, lastError: null });
    const [health] = await pools.admin.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, northwind), eq(schema.integrationHealth.source, "accounting:writes")));
    expect(health!.status).toBe("ok");
  });
  it("reconciliation: an order synced after the push makes the day differ line by line; re-pushing it reconciles", async () => {
    expect((await nwOwner(NOW)((svc) => accountingReconciliation(svc, nw, { days: [DAY] }))).drifts).toEqual([]);
    await pools.admin.insert(schema.orders).values({ tenantId: northwind, orderNumber: 990_020, name: "#NW-T20", externalId: "acct-test-20", currency: "EUR", shippingCountry: "IT", placedAt: new Date("2024-06-15T10:00:00Z"), status: "delivered", paymentMethod: "card", paymentStatus: "paid", totalMinor: 6100, taxMinor: 1100, subtotalMinor: 6100 });
    const r = await nwOwner(NOW)((svc) => accountingReconciliation(svc, nw, { days: [DAY] }));
    expect(r.checked).toBe(1);
    expect(r.drifts).toHaveLength(1);
    const sales = r.drifts[0]!.lines.find((l) => l.line === "sales")!;
    // by hand: 6100 gross with 22% tax inside → 5000 more sales (a credit, negative in debit − credit)
    expect(sales.currentMinor - sales.pushedMinor).toBe(-5000);
    expect(r.drifts[0]!.lines.find((l) => l.line === "tax")!.currentMinor - r.drifts[0]!.lines.find((l) => l.line === "tax")!.pushedMinor).toBe(-1100);
    await nwOwner(NOW)((svc) => repushAccountingDay(svc, nw, DAY, { note: "late order" }));
    expect((await nwOwner(NOW)((svc) => accountingReconciliation(svc, nw, { days: [DAY] }))).drifts).toEqual([]);
  });
});

describe("gating and isolation", () => {
  it("without the add-on the push services refuse and the MCP tool is not offered", async () => {
    expect(isPageEnabled("accounting", DEMO_TENANTS.harbor.addons)).toBe(false);
    await expect(hhOwner((svc) => runAccountingPush(svc, hh))).rejects.toBeInstanceOf(AccountingError);
    await expect(hhOwner((svc) => accountingPushLog(svc))).rejects.toMatchObject({ code: "disabled" });
    await expect(hhOwner((svc) => repushAccountingDay(svc, hh, DAY))).rejects.toMatchObject({ code: "disabled" });
    const tool = ACCOUNTING_MCP_TOOLS[0]!;
    expect(toolDenial(tool, { role: "owner", activeAddons: DEMO_TENANTS.harbor.addons, scopes: ["read"] })).toBe("module");
    expect(toolDenial(tool, { role: "owner", activeAddons: DEMO_TENANTS.northwind.addons, scopes: ["read"] })).toBeNull();
    expect(toolDenial(tool, { role: "marketing", activeAddons: DEMO_TENANTS.northwind.addons, scopes: ["read"] })).toBe("role");
  });

  it("the MCP tool reports the push log of its tenant", async () => {
    const tool = ACCOUNTING_MCP_TOOLS[0]!;
    const out = await nwOwner()((svc) => tool.run({ ctx: svc, tenant: { ...nw, slug: "northwind-apparel" }, slug: "northwind-apparel", today: NOW, userId: ctx.userIds["owner@northwind.demo"]!, role: "owner", activeAddons: DEMO_TENANTS.northwind.addons }, { limit: 5 }));
    const data = out.data as { counts: Record<string, number>; days: { day: string; status: string }[]; link: string };
    expect(data.counts.pushed).toBeGreaterThan(0);
    expect(data.days).toHaveLength(5);
    expect(data.link).toBe("/t/northwind-apparel/accounting");
  });

  it("one tenant never reads or writes another tenant's journals or settings", async () => {
    const seen = await withTenant(harbor, (tx) => tx.select().from(schema.accountingJournals), pools.app);
    expect(seen).toHaveLength(0);
    const settingsSeen = await withTenant(harbor, (tx) => tx.select().from(schema.accountingSettings), pools.app);
    expect(settingsSeen).toHaveLength(0);
    await expect(withTenant(harbor, (tx) => tx.insert(schema.accountingJournals).values({ tenantId: northwind, day: "2024-01-01", provider: "x", currency: "EUR" }), pools.app)).rejects.toThrow();
    const updated = await withTenant(harbor, (tx) => tx.update(schema.accountingJournals).set({ note: "x" }).where(eq(schema.accountingJournals.tenantId, northwind)).returning(), pools.app);
    expect(updated).toHaveLength(0);
  });
});
