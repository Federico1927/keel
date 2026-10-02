import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull, schema, sql, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { MockCommercePlatform } from "@keel/integrations";
import { PAYMENT_METHODS, SALE_STATUSES, monthRange, parseTenantSettings } from "@keel/core";
import { PaymentError, getCommercePlatformFor, orderEconomicsForPeriod, orderListWhere, parseOrderFilters, paymentMethodReport, payoutDetail, pnlForPeriod, recordManualPayment, refundOrder, resetMockPlatforms, runPayoutsSync, taxReportForPeriod, type AnalyticsTenant, type ServiceContext } from "../src";

const pools = testPools();
let seed: SeedContext;
let northwind = "";
let harbor = "";
const now = new Date();
const lastMonth = monthRange(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7));
const settings = parseTenantSettings({ paymentFeeBps: { card: 180, wallet: 250, bank_transfer: 0, cod: 0, bnpl: 400, other: 0 }, paymentFeeFixedMinor: { card: 25, wallet: 25, bank_transfer: 0, cod: 0, bnpl: 30, other: 0 } });
const nw = (): AnalyticsTenant => ({ id: northwind, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings });
const hh = (): AnalyticsTenant => ({ id: harbor, country: "US", currency: "USD", timezone: "America/New_York", settings });

beforeAll(async () => {
  seed = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, seed, { scale: 0.02 });
  northwind = seed.tenantIds.northwind;
  harbor = seed.tenantIds.harbor;
});
afterAll(() => pools.close());

const as = (tenant: () => string, email: string | null) => <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenant(), (tx) => fn({ tenantId: tenant(), tx, actor: email ? { type: "user", userId: seed.userIds[email]! } : { type: "system", userId: null } }), pools.app);
const ops = as(() => northwind, "ops@northwind.demo");
const sys = as(() => northwind, null);
const mock = () => new MockCommercePlatform({ currency: "EUR", country: "IT", orderNumberPrefix: "NW-", variants: [], locations: [], customers: [], startOrderNumber: 990000 });
let seq = 0;

/** A Northwind order of €50 (22 % VAT included) in an isolated month, with one line of two units of a real variant. */
async function makeOrder(input: { paymentMethod: string; paymentStatus: string; status: string; gateway: string; placedAt?: Date }) {
  seq++;
  return ops(async (s) => {
    const [v] = await s.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId }).from(schema.productVariants).where(eq(schema.productVariants.tenantId, northwind)).limit(1);
    const [o] = await s.tx.insert(schema.orders).values({ tenantId: northwind, externalId: `pay-test-${seq}`, currency: "EUR", shippingCountry: "IT", paymentGateways: [input.gateway], platformTags: [], orderNumber: 970000 + seq, name: `#PT-${seq}`, status: input.status, paymentMethod: input.paymentMethod, paymentStatus: input.paymentStatus, financialStatusRaw: input.paymentStatus, subtotalMinor: 5000, totalMinor: 5000, taxMinor: 902, placedAt: input.placedAt ?? new Date(`2019-0${(seq % 9) + 1}-10T10:00:00Z`) }).returning({ id: schema.orders.id, placedAt: schema.orders.placedAt });
    const [l] = await s.tx.insert(schema.orderLines).values({ tenantId: northwind, orderId: o!.id, externalId: `pay-test-${seq}-1`, variantId: v!.id, productId: v!.productId, title: "Test tee", quantity: 2, currentQuantity: 2, unitPriceMinor: 2500, totalMinor: 5000, unitCostMinor: 1000 }).returning({ id: schema.orderLines.id });
    return { id: o!.id, lineId: l!.id, variantId: v!.id, placedAt: o!.placedAt };
  });
}
const orderRow = (id: string) => sys((s) => s.tx.select().from(schema.orders).where(eq(schema.orders.id, id)).then((r) => r[0]!));
const monthOf = (d: Date) => monthRange(d.toISOString().slice(0, 7));

describe("mark as paid / manual payment", () => {
  it("marking a bank-transfer order paid moves it out of pending, and the timeline shows the author", async () => {
    const o = await makeOrder({ paymentMethod: "bank_transfer", paymentStatus: "pending", status: "pending_review", gateway: "bank_deposit" });
    const r = await ops((s) => recordManualPayment(s, { orderId: o.id, occurredAt: new Date(Date.now() - 864e5), method: "bank_transfer", note: "SEPA ref 123" }));
    expect(r).toMatchObject({ amountMinor: 5000, fullyPaid: true, outstandingMinor: 0, paymentStatus: "paid", previousPaymentStatus: "pending" });
    const row = await orderRow(o.id);
    expect(row.paymentStatus).toBe("paid");
    expect(row.status).not.toBe("pending_review");
    expect(row.status).toBe("confirmed");
    const events = await sys((s) => s.tx.select().from(schema.orderEvents).where(eq(schema.orderEvents.orderId, o.id)));
    const paid = events.find((e) => e.type === "payment_recorded")!;
    expect(paid.actorUserId).toBe(seed.userIds["ops@northwind.demo"]);
    expect(paid.actorType).toBe("user");
    expect(paid.diff).toEqual({ paymentStatus: { from: "pending", to: "paid" } });
    expect(paid.metadata).toMatchObject({ amountMinor: 5000, method: "bank_transfer", note: "SEPA ref 123" });
    expect(events.find((e) => e.type === "status_changed")!.actorUserId).toBe(seed.userIds["ops@northwind.demo"]);
    // pushed to the store through the outbox, keyed by the payment
    expect(r.write).toMatchObject({ kind: "order.mark_paid", status: "pending", idempotencyKey: `order:payment:${r.transactionId}` });
    expect(r.write!.payload).toMatchObject({ orderExternalId: `pay-test-${seq}`, amountMinor: 5000, fullBalance: true, method: "bank_transfer" });
    const [txn] = await sys((s) => s.tx.select().from(schema.orderTransactions).where(eq(schema.orderTransactions.orderId, o.id)));
    expect(txn).toMatchObject({ kind: "manual_payment", amountMinor: 5000, actorUserId: seed.userIds["ops@northwind.demo"] });
    // paid now: a second payment is refused
    await expect(ops((s) => recordManualPayment(s, { orderId: o.id, amountMinor: 100 }))).rejects.toMatchObject({ code: "not_pending" });
  });
  it("a partial payment leaves the rest outstanding until the payments cover the total", async () => {
    const o = await makeOrder({ paymentMethod: "bank_transfer", paymentStatus: "pending", status: "pending_review", gateway: "bank_deposit" });
    const first = await ops((s) => recordManualPayment(s, { orderId: o.id, amountMinor: 2000, method: "bank_transfer" }));
    expect(first).toMatchObject({ fullyPaid: false, outstandingMinor: 3000, paymentStatus: "pending" });
    expect(first.write!.payload).toMatchObject({ fullBalance: false, amountMinor: 2000 });
    expect((await orderRow(o.id)).status).toBe("pending_review");
    await expect(ops((s) => recordManualPayment(s, { orderId: o.id, amountMinor: 3001 }))).rejects.toMatchObject({ code: "exceeds_outstanding" });
    const second = await ops((s) => recordManualPayment(s, { orderId: o.id }));
    expect(second).toMatchObject({ amountMinor: 3000, fullyPaid: true, paymentStatus: "paid" });
  });
});

describe("partial refund", () => {
  it("a €10 refund on a €50 order shows in the P/L net revenue; more than what remains is rejected", async () => {
    const o = await makeOrder({ paymentMethod: "card", paymentStatus: "paid", status: "delivered", gateway: "shopify_payments" });
    const period = monthOf(o.placedAt);
    const before = await sys((s) => pnlForPeriod(s, nw(), period));
    const p = mock();
    const r = await ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 1000, note: "Goodwill" }));
    expect(r).toMatchObject({ amountMinor: 1000, refundedMinor: 1000, paymentStatus: "partially_refunded", previousRefundedMinor: 0, duplicate: false });
    expect(p.writeLog.find((w) => w.op === "refundOrder")!.args).toMatchObject({ orderExternalId: `pay-test-${seq}`, amountMinor: 1000, lines: [] });
    const after = await sys((s) => pnlForPeriod(s, nw(), period));
    // tax share 902/5000: net 50.00 → 40.98, after the refund 40.00 → 32.78
    expect(after.refundedMinor - before.refundedMinor).toBe(1000);
    expect(before.netRevenueMinor - after.netRevenueMinor).toBe(4098 - 3278);
    expect(after.orders).toBe(before.orders);
    const row = await orderRow(o.id);
    expect(row).toMatchObject({ refundedMinor: 1000, paymentStatus: "partially_refunded" });
    expect(SALE_STATUSES as readonly string[]).toContain(row.status);
    const ev = await sys((s) => s.tx.select().from(schema.orderEvents).where(and(eq(schema.orderEvents.orderId, o.id), eq(schema.orderEvents.type, "refund_issued"))));
    expect(ev[0]!.actorUserId).toBe(seed.userIds["ops@northwind.demo"]);
    expect(ev[0]!.diff).toEqual({ refundedMinor: { from: 0, to: 1000 }, paymentStatus: { from: "paid", to: "partially_refunded" } });
    const [w] = await sys((s) => s.tx.select().from(schema.platformWrites).where(and(eq(schema.platformWrites.entityId, o.id), eq(schema.platformWrites.kind, "order.refund"))));
    expect(w).toMatchObject({ mode: "sync", status: "succeeded" });
    // 40.00 remain: 40.01 is refused, nothing changes
    await expect(ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 4001 }))).rejects.toBeInstanceOf(PaymentError);
    await expect(ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 4001 }))).rejects.toMatchObject({ code: "exceeds_refundable" });
    expect((await orderRow(o.id)).refundedMinor).toBe(1000);
    // the rest refunds the order fully: out of the sale scope
    await ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 4000 }));
    expect(await orderRow(o.id)).toMatchObject({ refundedMinor: 5000, paymentStatus: "refunded", status: "refunded" });
    expect((await sys((s) => pnlForPeriod(s, nw(), period))).orders).toBe(before.orders - 1);
  });
  it("refunds units with restock, and the same request twice refunds once", async () => {
    const o = await makeOrder({ paymentMethod: "card", paymentStatus: "paid", status: "delivered", gateway: "shopify_payments" });
    const [loc] = await sys((s) => s.tx.select().from(schema.locations).where(and(eq(schema.locations.tenantId, northwind), eq(schema.locations.isDefault, true))));
    const level = () => sys((s) => s.tx.select({ a: schema.inventoryLevels.available }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.variantId, o.variantId), eq(schema.inventoryLevels.locationId, loc!.id))).then((r) => r[0]?.a ?? 0));
    const stockBefore = await level();
    const p = mock();
    const requestId = "9d4b7c1e-2f3a-4b5c-8d6e-7f8091a2b3c4";
    const r = await ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 2500, lines: [{ orderLineId: o.lineId, quantity: 1 }], restock: true, requestId }));
    expect(r).toMatchObject({ amountMinor: 2500, restocked: 1, duplicate: false });
    expect(await level()).toBe(stockBefore + 1);
    expect(p.writeLog.find((w) => w.op === "refundOrder")!.args).toMatchObject({ lines: [{ orderLineExternalId: `pay-test-${seq}-1`, quantity: 1, restock: true }], locationExternalId: loc!.externalId });
    const [line] = await sys((s) => s.tx.select().from(schema.orderLines).where(eq(schema.orderLines.id, o.lineId)));
    expect(line!.currentQuantity).toBe(1);
    const mv = await sys((s) => s.tx.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, o.id), eq(schema.inventoryMovements.reason, "refund_restock"))));
    expect(mv).toHaveLength(1);
    const again = await ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 2500, lines: [{ orderLineId: o.lineId, quantity: 1 }], restock: true, requestId }));
    expect(again.duplicate).toBe(true);
    expect((await orderRow(o.id)).refundedMinor).toBe(2500);
    expect(await level()).toBe(stockBefore + 1);
    // one unit left on the line: two are refused
    await expect(ops((s) => refundOrder(s, p, { orderId: o.id, amountMinor: 100, lines: [{ orderLineId: o.lineId, quantity: 2 }] }))).rejects.toMatchObject({ code: "line_invalid" });
  });
  it("only paid orders can be refunded", async () => {
    const o = await makeOrder({ paymentMethod: "bank_transfer", paymentStatus: "pending", status: "pending_review", gateway: "bank_deposit" });
    await expect(ops((s) => refundOrder(s, mock(), { orderId: o.id, amountMinor: 100 }))).rejects.toMatchObject({ code: "not_paid" });
  });
});

describe("actual payment fees from payouts", () => {
  it("in a month with mock payouts, P/L fees equal the sum of actual fees and the other orders fall back to the estimate", async () => {
    const pnl = await sys((s) => pnlForPeriod(s, nw(), lastMonth));
    const rows = await sys((s) => s.tx
      .select({ orderId: schema.balanceTransactions.orderId, fee: sql<number>`sum(${schema.balanceTransactions.feeMinor})::int` })
      .from(schema.balanceTransactions)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.balanceTransactions.orderId))
      .where(and(eq(schema.orders.tenantId, northwind), sql`${schema.orders.placedAt} >= ${lastMonth.from} and ${schema.orders.placedAt} < ${lastMonth.to}`, inArray(schema.orders.status, [...SALE_STATUSES]), isNull(schema.orders.replacedByOrderId), sql`exists (select 1 from balance_transactions c where c.order_id = ${schema.orders.id} and c.type = 'charge')`))
      .groupBy(schema.balanceTransactions.orderId));
    expect(rows.length).toBeGreaterThan(5);
    expect(pnl.paymentFeeActualOrders).toBe(rows.length);
    expect(pnl.paymentFeeActualMinor).toBe(rows.reduce((s, r) => s + r.fee, 0));
    expect(pnl.paymentFeeMinor).toBe(pnl.paymentFeeActualMinor + pnl.paymentFeeEstimatedMinor);
    expect(pnl.paymentFeeEstimatedOrders).toBe(pnl.orders - pnl.paymentFeeActualOrders);
    expect(pnl.paymentFeeEstimatedOrders).toBeGreaterThan(0);
    // per order: payout orders are flagged actual, the others (PayPal, BNPL, transfers, cash…) estimate with the tenant rate
    const econ = (await sys((s) => orderEconomicsForPeriod(s, nw(), lastMonth))).filter((e) => e.inScope);
    const withPayout = new Set(rows.map((r) => r.orderId));
    for (const e of econ) expect(e.paymentFeeSource).toBe(withPayout.has(e.orderId) ? "actual" : "estimate");
    const gateways = await sys((s) => s.tx.select({ id: schema.orders.id, g: schema.orders.paymentGateways, total: schema.orders.totalMinor, method: schema.orders.paymentMethod }).from(schema.orders).where(inArray(schema.orders.id, econ.map((e) => e.orderId))));
    for (const e of econ.filter((x) => x.paymentFeeSource === "estimate")) {
      const o = gateways.find((g) => g.id === e.orderId)!;
      expect(o.g.some((g) => ["shopify_payments", "apple_pay", "shop_pay"].includes(g))).toBe(false);
      const m = o.method as keyof typeof settings.paymentFeeBps;
      expect(e.paymentFeeMinor).toBe(Math.round((o.total * settings.paymentFeeBps[m]) / 10_000) + settings.paymentFeeFixedMinor[m]);
    }
    // the order list drill-down means the same thing
    const scope = { tenantId: northwind, userId: null, orderNumberPrefix: "NW-" };
    const count = (q: Record<string, string>) => sys((s) => s.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).where(and(orderListWhere(scope, parseOrderFilters({ from: lastMonth.from.toISOString().slice(0, 10), to: new Date(lastMonth.to.getTime() - 864e5).toISOString().slice(0, 10), status: SALE_STATUSES.join(","), ...q })), isNull(schema.orders.replacedByOrderId))).then((r) => r[0]!.n));
    expect(await count({ feeSource: "actual" })).toBe(pnl.paymentFeeActualOrders);
    expect(await count({ feeSource: "estimated" })).toBe(pnl.paymentFeeEstimatedOrders);
  });
  it("the seeded payouts add up from their transactions and a mock sync finds the same deposits", async () => {
    const before = await sys((s) => s.tx.select({ n: sql<number>`count(*)::int`, fee: sql<number>`coalesce(sum(fee_minor), 0)::int` }).from(schema.balanceTransactions).where(eq(schema.balanceTransactions.tenantId, northwind)).then((r) => r[0]!));
    const [p] = await sys((s) => s.tx.select().from(schema.payouts).where(and(eq(schema.payouts.tenantId, northwind), eq(schema.payouts.status, "paid"))).limit(1));
    const d = await sys((s) => payoutDetail(s, p!.id));
    expect(d!.matches).toBe(true);
    expect(d!.transactions.length).toBe(p!.transactionCount);
    resetMockPlatforms();
    const r = await sys(async (s) => runPayoutsSync(s, await getCommercePlatformFor(s, { id: northwind, currency: "EUR", country: "IT", orderNumberPrefix: "NW-" })));
    expect(r).toMatchObject({ finished: true, error: null });
    const after = await sys((s) => s.tx.select({ n: sql<number>`count(*)::int`, fee: sql<number>`coalesce(sum(fee_minor), 0)::int` }).from(schema.balanceTransactions).where(eq(schema.balanceTransactions.tenantId, northwind)).then((r) => r[0]!));
    expect(after).toEqual(before);
  });
  it("the payouts sync is resumable: it pauses at the time budget and continues from its cursor", async () => {
    const hhSys = as(() => harbor, null);
    await hhSys(async (s) => {
      await s.tx.delete(schema.balanceTransactions).where(eq(schema.balanceTransactions.tenantId, harbor));
      await s.tx.delete(schema.payouts).where(eq(schema.payouts.tenantId, harbor));
      await s.tx.delete(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, harbor), eq(schema.syncRuns.objectType, "payouts")));
    });
    resetMockPlatforms();
    const tenant = { id: harbor, currency: "USD", country: "US", orderNumberPrefix: "HH-" };
    let runs = 0;
    let last: Awaited<ReturnType<typeof runPayoutsSync>> | null = null;
    do {
      last = await hhSys(async (s) => runPayoutsSync(s, await getCommercePlatformFor(s, tenant), { budgetMs: 0, pageSize: 2 }));
      runs++;
    } while (!last.finished && !last.error && runs < 500);
    expect(last.error).toBeNull();
    expect(runs).toBeGreaterThan(2);
    const syncRuns = await hhSys((s) => s.tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, harbor), eq(schema.syncRuns.objectType, "payouts"))));
    expect(syncRuns).toHaveLength(1);
    expect(syncRuns[0]!.status).toBe("success");
    const expected = await hhSys(async (s) => {
      const platform = await getCommercePlatformFor(s, tenant);
      const all = await platform.fetchPayouts({ createdSince: new Date(Date.now() - 120 * 864e5), limit: 250 });
      return all.items.length;
    });
    const stored = await hhSys((s) => s.tx.select().from(schema.payouts).where(eq(schema.payouts.tenantId, harbor)));
    expect(stored.length).toBe(expected);
    for (const p of stored.slice(0, 5)) expect((await hhSys((s) => payoutDetail(s, p.id)))!.matches).toBe(true);
  });
});

describe("tax report and payment-method breakdown", () => {
  it("the tax report adds up to the P/L tax total, by country and rate", async () => {
    for (const [t, tenant] of [[() => northwind, nw], [() => harbor, hh]] as const) {
      for (const period of [lastMonth, { from: new Date(now.getTime() - 365 * 864e5), to: now }]) {
        const run = as(t, null);
        const [report, pnl] = [await run((s) => taxReportForPeriod(s, tenant(), period)), await run((s) => pnlForPeriod(s, tenant(), period))];
        expect(report.totals.taxMinor).toBe(pnl.taxMinor);
        expect(report.totals.orders).toBe(pnl.orders);
        expect(report.totals.grossMinor).toBe(pnl.grossRevenueMinor);
        expect(report.rows.reduce((s, r) => s + r.taxMinor, 0)).toBe(pnl.taxMinor);
      }
    }
    const it = await sys((s) => taxReportForPeriod(s, nw(), lastMonth));
    expect(it.rows.find((r) => r.country === "IT")!.rateBps).toBe(2200);
    const us = await as(() => harbor, null)((s) => taxReportForPeriod(s, hh(), lastMonth));
    expect(us.rows.map((r) => r.rateBps)).toContain(700);
  });
  it("every payment method gets a row and the breakdown adds up to the P/L", async () => {
    const r = await sys((s) => paymentMethodReport(s, nw(), lastMonth));
    const pnl = await sys((s) => pnlForPeriod(s, nw(), lastMonth));
    expect(r.rows.map((x) => x.method)).toEqual([...PAYMENT_METHODS]);
    expect(r.rows.reduce((s, x) => s + x.orders, 0)).toBe(pnl.orders);
    expect(r.rows.reduce((s, x) => s + x.placedOrders, 0)).toBe(pnl.placedOrders);
    expect(r.rows.reduce((s, x) => s + x.netRevenueMinor, 0)).toBe(pnl.netRevenueMinor);
    expect(r.rows.reduce((s, x) => s + x.feesMinor, 0)).toBe(pnl.paymentFeeMinor);
    expect(r.fees.actualMinor).toBe(pnl.paymentFeeActualMinor);
    const card = r.rows.find((x) => x.method === "card")!;
    expect(card.actualFeesMinor).toBeGreaterThan(0);
    expect(r.rows.find((x) => x.method === "bnpl")!.actualFeesMinor).toBe(0);
  });
});
