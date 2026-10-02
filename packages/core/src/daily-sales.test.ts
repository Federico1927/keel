import { describe, expect, it } from "vitest";
import { bookedInSalesSummary, dailySalesSummary, orderTaxBuckets, refundSchedule, summaryDayAddsUp, summaryDayRange, type SalesSummaryOrder } from "./daily-sales";

const TZ = "Europe/Rome";
/** Deterministic generator (mulberry32) for the random baskets. */
function createRngForTest(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const base = (o: Partial<SalesSummaryOrder> & Pick<SalesSummaryOrder, "id" | "placedAt" | "totalMinor">): SalesSummaryOrder => ({
  name: `#${o.id}`,
  status: "confirmed",
  paymentStatus: "paid",
  country: "IT",
  pricesIncludeTax: true,
  rateBps: 2200,
  discountMinor: 0,
  shippingMinor: 0,
  taxMinor: 0,
  refundedMinor: 0,
  lines: [{ amountMinor: o.totalMinor, taxable: true }],
  refunds: [],
  paymentMethod: "card",
  feeMinor: 0,
  feeSource: "estimate",
  ...o,
});

describe("daily sales summary: hand-calculated cases", () => {
  it("a sale: 122.00 with 22 % VAT included, card fee 3.00", () => {
    const s = dailySalesSummary([base({ id: "A", placedAt: new Date("2026-03-10T10:00:00Z"), totalMinor: 12200, taxMinor: 2200, feeMinor: 300 })], { timeZone: TZ, fromDay: "2026-03-10", toDay: "2026-03-10" });
    const d = s.days[0]!;
    expect(d.rates).toEqual([{ rateKey: "IT|2200", country: "IT", rateBps: 2200, grossSalesMinor: 10000, discountsMinor: 0, refundsMinor: 0, netSalesMinor: 10000, shippingMinor: 0, taxMinor: 2200, totalMinor: 12200, saleOrders: 1, refundOrders: 0 }]);
    expect(d.fees).toEqual([{ method: "card", feeMinor: 300, orders: 1, estimatedOrders: 1 }]);
    expect(d.netMinor).toBe(11900);
    expect(summaryDayAddsUp(d)).toBe(true);
  });

  it("a partial refund three days later: discount and shipping net of tax on the sale day, refund and its tax on the refund day", () => {
    // goods 100.00 incl., discount 10.00, shipping 6.10 incl.; platform tax 17.33 (16.23 goods + 1.10 shipping); refund 48.80
    const o = base({ id: "B", placedAt: new Date("2026-03-10T09:00:00Z"), totalMinor: 9610, discountMinor: 1000, shippingMinor: 610, taxMinor: 1733, lines: [{ amountMinor: 10000, taxable: true }], status: "returned_partial", paymentStatus: "partially_refunded", refundedMinor: 4880, refunds: [{ at: new Date("2026-03-13T15:00:00Z"), amountMinor: 4880 }] });
    const s = dailySalesSummary([o], { timeZone: TZ, fromDay: "2026-03-10", toDay: "2026-03-13" });
    const sale = s.days.find((d) => d.day === "2026-03-10")!;
    // goods tax 16.23: discount net = 10.00 − round(10.00 × 16.23 / 90.00) = 8.20; gross net = 90.00 − 16.23 + 8.20 = 81.97
    expect(sale.rates[0]).toMatchObject({ grossSalesMinor: 8197, discountsMinor: 820, refundsMinor: 0, netSalesMinor: 7377, shippingMinor: 500, taxMinor: 1733, totalMinor: 9610 });
    const refund = s.days.find((d) => d.day === "2026-03-13")!;
    // refund tax = round(48.80 × 17.33 / 96.10) = 8.80
    expect(refund.rates[0]).toMatchObject({ grossSalesMinor: 0, refundsMinor: 4000, netSalesMinor: -4000, taxMinor: -880, totalMinor: -4880, saleOrders: 0, refundOrders: 1 });
    expect(s.days.filter((d) => d.day === "2026-03-11" || d.day === "2026-03-12").every((d) => d.rates.length === 0 && d.totalMinor === 0)).toBe(true);
    expect(s.totals.totalMinor).toBe(9610 - 4880);
    for (const d of s.days) expect(summaryDayAddsUp(d)).toBe(true);
  });

  it("a cancelled order: unpaid is never booked; paid then refunded is a sale and a refund", () => {
    const unpaid = base({ id: "C1", placedAt: new Date("2026-03-10T10:00:00Z"), totalMinor: 5000, taxMinor: 902, status: "cancelled", paymentStatus: "voided", feeMinor: 120 });
    const refunded = base({ id: "C2", placedAt: new Date("2026-03-10T11:00:00Z"), totalMinor: 6100, taxMinor: 1100, status: "cancelled", paymentStatus: "refunded", refundedMinor: 6100, refunds: [{ at: new Date("2026-03-11T08:00:00Z"), amountMinor: 6100 }], feeMinor: 150 });
    expect(bookedInSalesSummary(unpaid)).toBe(false);
    expect(bookedInSalesSummary({ status: "delivered", paymentStatus: "paid", replaced: true })).toBe(false);
    const s = dailySalesSummary([unpaid, refunded], { timeZone: TZ, fromDay: "2026-03-10", toDay: "2026-03-11" });
    const [d10, d11] = s.days;
    expect(d10!.orderIds).toEqual(["C2"]);
    expect(d10!.rates[0]).toMatchObject({ grossSalesMinor: 5000, taxMinor: 1100, totalMinor: 6100 });
    expect(d10!.feesMinor).toBe(150);
    expect(d11!.rates[0]).toMatchObject({ refundsMinor: 5000, taxMinor: -1100, totalMinor: -6100 });
    expect(s.totals.netMinor).toBe(-150);
  });

  it("a multi-rate basket: the zero-rated line gets its own row, shipping follows the order's rate", () => {
    // VAT included: a taxable item 122.00 (22 %) and a zero-rated one 50.00, shipping 12.20 incl.; platform tax 24.20
    const o = base({ id: "M", placedAt: new Date("2026-03-10T10:00:00Z"), totalMinor: 18420, shippingMinor: 1220, taxMinor: 2420, lines: [{ amountMinor: 12200, taxable: true }, { amountMinor: 5000, taxable: false }] });
    expect(orderTaxBuckets(o)).toEqual([
      { rateKey: "IT|2200", rateBps: 2200, grossMinor: 10000, discountMinor: 0, shippingMinor: 1000, taxMinor: 2420, chargedMinor: 13420 },
      { rateKey: "IT|0", rateBps: 0, grossMinor: 5000, discountMinor: 0, shippingMinor: 0, taxMinor: 0, chargedMinor: 5000 },
    ]);
    const d = dailySalesSummary([o], { timeZone: TZ, fromDay: "2026-03-10", toDay: "2026-03-10" }).days[0]!;
    expect(d.rates.map((r) => [r.rateKey, r.totalMinor])).toEqual([["IT|2200", 13420], ["IT|0", 5000]]);
    expect(d.totalMinor).toBe(18420);
    // prices without tax (US style): 7 % on the taxable goods only, the exempt line at 0 %
    const us = base({ id: "U", country: "US", pricesIncludeTax: false, rateBps: 700, placedAt: new Date("2026-03-10T10:00:00Z"), totalMinor: 15700, shippingMinor: 1000, taxMinor: 700, lines: [{ amountMinor: 10000, taxable: true }, { amountMinor: 4000, taxable: false }] });
    const rows = orderTaxBuckets(us);
    expect(rows.map((r) => [r.rateKey, r.grossMinor, r.shippingMinor, r.taxMinor, r.chargedMinor])).toEqual([["US|700", 10000, 1000, 700, 11700], ["US|0", 4000, 0, 0, 4000]]);
  });

  it("a day boundary in the tenant's time zone: 23:59 and 00:30 local fall on different days", () => {
    // 10 March (CET, UTC+1): 22:59Z = 23:59 local on the 10th; 23:30Z = 00:30 local on the 11th (the 10th in UTC)
    const late = base({ id: "L", placedAt: new Date("2026-03-10T22:59:00Z"), totalMinor: 1220, taxMinor: 220 });
    const early = base({ id: "E", placedAt: new Date("2026-03-10T23:30:00Z"), totalMinor: 2440, taxMinor: 440 });
    const s = dailySalesSummary([late, early], { timeZone: TZ, fromDay: "2026-03-10", toDay: "2026-03-11" });
    expect(s.days.map((d) => [d.day, d.totalMinor, d.orderIds])).toEqual([["2026-03-10", 1220, ["L"]], ["2026-03-11", 2440, ["E"]]]);
    // in New York both are on the 10th
    const ny = dailySalesSummary([late, early], { timeZone: "America/New_York", fromDay: "2026-03-10", toDay: "2026-03-11" });
    expect(ny.days.map((d) => d.totalMinor)).toEqual([3660, 0]);
  });
});

describe("refund dating", () => {
  it("caps dated refunds at the refunded total and puts the unexplained part on the placed day", () => {
    const placedAt = new Date("2026-03-01T10:00:00Z");
    expect(refundSchedule({ placedAt, totalMinor: 10000, refundedMinor: 3000, refunds: [{ at: new Date("2026-03-05T10:00:00Z"), amountMinor: 2000 }, { at: new Date("2026-03-04T10:00:00Z"), amountMinor: 2500 }] })).toEqual([{ at: new Date("2026-03-04T10:00:00Z"), amountMinor: 2500 }, { at: new Date("2026-03-05T10:00:00Z"), amountMinor: 500 }]);
    expect(refundSchedule({ placedAt, totalMinor: 10000, refundedMinor: 4000, refunds: [{ at: new Date("2026-03-04T10:00:00Z"), amountMinor: 1000 }] })).toEqual([{ at: new Date("2026-03-04T10:00:00Z"), amountMinor: 1000 }, { at: placedAt, amountMinor: 3000 }]);
    expect(refundSchedule({ placedAt, totalMinor: 1000, refundedMinor: 5000, refunds: [] })).toEqual([{ at: placedAt, amountMinor: 1000 }]);
  });
});

describe("the summary always adds up", () => {
  it("random baskets: rows sum to days, days to the period, and each order's sale minus refunds is what it kept", () => {
    const rng = createRngForTest(85);
    const orders: SalesSummaryOrder[] = [];
    for (let i = 0; i < 300; i++) {
      const incl = rng() < 0.6;
      const rate = [0, 400, 1000, 2200, 700][Math.floor(rng() * 5)]!;
      const lines = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => ({ amountMinor: 500 + Math.floor(rng() * 20000), taxable: rng() < 0.85 }));
      const goods = lines.reduce((s, l) => s + l.amountMinor, 0);
      const discount = rng() < 0.3 ? Math.floor(goods * 0.1) : 0;
      const shipping = rng() < 0.5 ? 590 : 0;
      const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + l.amountMinor, 0) * (1 - discount / goods);
      const tax = rate ? Math.round(incl ? (taxable * rate) / (10_000 + rate) : (taxable * rate) / 10_000) : 0;
      const total = goods - discount + shipping + (incl ? 0 : tax);
      const refunded = rng() < 0.2 ? Math.floor(total * rng()) : 0;
      const placedAt = new Date(Date.UTC(2026, 2, 1) + Math.floor(rng() * 20 * 864e5));
      orders.push({ id: `o${i}`, name: `#${i}`, placedAt, status: rng() < 0.1 ? "cancelled" : "delivered", paymentStatus: rng() < 0.1 ? "pending" : "paid", country: rng() < 0.8 ? "IT" : "DE", pricesIncludeTax: incl, rateBps: rate, totalMinor: total, discountMinor: discount, shippingMinor: shipping, taxMinor: tax, refundedMinor: refunded, lines, refunds: refunded && rng() < 0.7 ? [{ at: new Date(placedAt.getTime() + Math.floor(rng() * 5 * 864e5)), amountMinor: refunded }] : [], paymentMethod: ["card", "wallet", "cod", "bank_transfer"][i % 4]!, feeMinor: Math.round(total * 0.02), feeSource: rng() < 0.5 ? "actual" : "estimate" });
    }
    const s = dailySalesSummary(orders, { timeZone: TZ, fromDay: "2026-02-28", toDay: "2026-03-31" });
    for (const d of s.days) expect(summaryDayAddsUp(d), d.day).toBe(true);
    expect(s.days.reduce((t, d) => t + d.totalMinor, 0)).toBe(s.totals.totalMinor);
    expect(s.days.reduce((t, d) => t + d.netMinor, 0)).toBe(s.totals.netMinor);
    for (const o of orders.filter((x) => bookedInSalesSummary(x))) {
      const mine = s.entries.filter((e) => e.orderId === o.id);
      expect(mine.filter((e) => e.kind === "sale").reduce((t, e) => t + e.totalMinor, 0), o.id).toBe(o.totalMinor);
      expect(mine.reduce((t, e) => t + e.totalMinor, 0), o.id).toBe(o.totalMinor - Math.min(o.refundedMinor, o.totalMinor));
      expect(mine.every((e) => Number.isInteger(e.grossSalesMinor) && Number.isInteger(e.taxMinor))).toBe(true);
    }
    expect(s.entries.some((e) => e.rateKey.endsWith("|0"))).toBe(true);
  });
});

describe("summary period", () => {
  const now = new Date("2026-10-02T21:30:00Z"); // 23:30 in Rome, 17:30 in New York
  it("presets end today in the tenant's time zone", () => {
    expect(summaryDayRange({}, TZ, now)).toEqual({ fromDay: "2026-09-03", toDay: "2026-10-02", preset: "30d" });
    expect(summaryDayRange({ preset: "7d" }, "America/New_York", now)).toEqual({ fromDay: "2026-09-26", toDay: "2026-10-02", preset: "7d" });
    expect(summaryDayRange({ preset: "mtd" }, TZ, new Date("2026-10-31T23:30:00Z"))).toEqual({ fromDay: "2026-11-01", toDay: "2026-11-01", preset: "mtd" });
  });
  it("explicit local days, ordered and capped at a year", () => {
    expect(summaryDayRange({ from: "2026-09-01", to: "2026-09-10" }, TZ, now)).toEqual({ fromDay: "2026-09-01", toDay: "2026-09-10", preset: undefined });
    expect(summaryDayRange({ from: "2026-09-10", to: "2026-09-01" }, TZ, now).toDay).toBe("2026-09-10");
    expect(summaryDayRange({ from: "2024-01-01", to: "2026-09-01" }, TZ, now).toDay).toBe("2024-12-31");
  });
});
