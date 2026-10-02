import { describe, expect, it } from "vitest";
import { accountingRetryDelayMs, accountingWindow, buildDailyJournal, dayClosesAt, dayReadiness, journalIsBalanced, parseAccountingSettings, type AccountingMapping } from "./accounting";
import { dailySalesSummary, type SalesSummaryOrder } from "./daily-sales";

const TZ = "Europe/Rome";
const MAPPING: AccountingMapping = { sales: "4000", tax: "2200", shipping: "4090", discounts: "4900", refunds: "4910", fees: "6100", clearing: "1100", byRate: { "IT|0": { sales: "4010", tax: null } } };
const order = (o: Partial<SalesSummaryOrder> & Pick<SalesSummaryOrder, "id" | "placedAt" | "totalMinor">): SalesSummaryOrder => ({ name: o.id, status: "delivered", paymentStatus: "paid", country: "IT", pricesIncludeTax: true, rateBps: 2200, discountMinor: 0, shippingMinor: 0, taxMinor: 0, refundedMinor: 0, lines: [{ amountMinor: o.totalMinor, taxable: true }], refunds: [], paymentMethod: "card", feeMinor: 0, feeSource: "actual", ...o });

describe("daily journal", () => {
  const s = dailySalesSummary(
    [
      order({ id: "A", placedAt: new Date("2026-03-10T10:00:00Z"), totalMinor: 18420, shippingMinor: 1220, discountMinor: 0, taxMinor: 2420, lines: [{ amountMinor: 12200, taxable: true }, { amountMinor: 5000, taxable: false }], feeMinor: 400 }),
      order({ id: "B", placedAt: new Date("2026-03-01T10:00:00Z"), totalMinor: 6100, taxMinor: 1100, refundedMinor: 2440, refunds: [{ at: new Date("2026-03-10T12:00:00Z"), amountMinor: 2440 }] }),
    ],
    { timeZone: TZ, fromDay: "2026-03-10", toDay: "2026-03-11" },
  );

  it("credits sales and tax per rate and shipping, debits refunds, fees and the clearing account, and balances", () => {
    const { journal, missing } = buildDailyJournal(s.days[0]!, MAPPING, { currency: "EUR", version: 1 });
    expect(missing).toEqual([]);
    expect(journal.reference).toBe("sales-2026-03-10-v1");
    expect(journal.lines.map((l) => [l.accountCode, l.description, l.debitMinor, l.creditMinor])).toEqual([
      ["4000", "Sales IT 22%", 0, 10000],
      ["2200", "Output tax IT 22%", 0, 2420 - 440],
      ["4010", "Sales IT 0%", 0, 5000],
      ["4090", "Shipping income", 0, 1000],
      ["4910", "Refunds", 2000, 0],
      ["6100", "Payment fees", 400, 0],
      ["1100", "Payment processors clearing", 18420 - 2440 - 400, 0],
    ]);
    expect(journal.debitMinor).toBe(journal.creditMinor);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it("a day of refunds only moves the clearing to the credit side", () => {
    const refundsOnly = dailySalesSummary([order({ id: "B", placedAt: new Date("2026-03-01T10:00:00Z"), totalMinor: 6100, taxMinor: 1100, refundedMinor: 6100, status: "refunded", paymentStatus: "refunded", refunds: [{ at: new Date("2026-03-11T09:00:00Z"), amountMinor: 6100 }] })], { timeZone: TZ, fromDay: "2026-03-11", toDay: "2026-03-11" });
    const { journal } = buildDailyJournal(refundsOnly.days[0]!, MAPPING, { currency: "EUR", version: 2 });
    expect(journal.lines.map((l) => [l.accountCode, l.debitMinor, l.creditMinor])).toEqual([["2200", 1100, 0], ["4910", 5000, 0], ["1100", 0, 6100]]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it("reports unmapped lines and leaves them out (the day then waits)", () => {
    const { journal, missing } = buildDailyJournal(s.days[0]!, { ...MAPPING, shipping: null, byRate: {}, sales: null }, { currency: "EUR", version: 1 });
    expect(missing).toEqual([{ line: "sales", rateKey: "IT|2200" }, { line: "sales", rateKey: "IT|0" }, { line: "shipping", rateKey: null }]);
    expect(journalIsBalanced(journal)).toBe(false);
  });
});

describe("readiness", () => {
  const empty = { day: "2026-03-10", currency: "EUR", narration: "", reference: "", lines: [], debitMinor: 0, creditMinor: 0 };
  const settings = parseAccountingSettings({ closeDelayHours: 2 });

  it("a day closes at the next local midnight plus the delay", () => {
    expect(dayClosesAt("2026-03-10", TZ, 2).toISOString()).toBe("2026-03-11T01:00:00.000Z");
    // the night clocks go forward in Rome (29 March): midnight is still UTC+1
    expect(dayClosesAt("2026-03-28", TZ, 0).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(dayClosesAt("2026-03-29", TZ, 0).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("waits while the day is open, an order is syncing or waits for a platform write, a line is unmapped or the journal does not balance", () => {
    const base = { day: "2026-03-10", timeZone: TZ, settings, journal: empty, missing: [], syncingOrders: [], pendingWriteOrders: [] };
    expect(dayReadiness({ ...base, now: new Date("2026-03-11T00:30:00Z") }).reasons).toEqual([{ code: "day_open", closesAt: "2026-03-11T01:00:00.000Z" }]);
    expect(dayReadiness({ ...base, now: new Date("2026-03-11T01:00:00Z") })).toEqual({ ready: true, reasons: [] });
    const r = dayReadiness({ ...base, now: new Date("2026-03-12T00:00:00Z"), syncingOrders: ["#2", "#1", "#2"], pendingWriteOrders: ["#9"], journal: { ...empty, debitMinor: 100, creditMinor: 90 } });
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual([{ code: "unbalanced", differenceMinor: 10 }, { code: "orders_syncing", count: 2, orders: ["#1", "#2"] }, { code: "orders_pending_write", count: 1, orders: ["#9"] }]);
    // an unmapped line is reported alone (the journal without it cannot balance)
    expect(dayReadiness({ ...base, now: new Date("2026-03-12T00:00:00Z"), missing: [{ line: "shipping", rateKey: null }], journal: { ...empty, debitMinor: 100, creditMinor: 90 } }).reasons).toEqual([{ code: "mapping_incomplete", lines: ["shipping"] }]);
    expect(dayReadiness({ ...base, settings: { ...settings, startDay: "2026-03-15" }, now: new Date("2026-04-01T00:00:00Z") }).reasons).toEqual([{ code: "before_start", startDay: "2026-03-15" }]);
  });

  it("the window runs from the start day or the look-back to the last closed day", () => {
    const now = new Date("2026-03-20T00:30:00Z"); // 01:30 in Rome: the 19th is not closed yet with a 2 h delay
    expect(accountingWindow(now, TZ, { startDay: null, lookbackDays: 5, closeDelayHours: 2 }, "2026-03-20")).toEqual(["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18"]);
    expect(accountingWindow(now, TZ, { startDay: "2026-03-17", lookbackDays: 5, closeDelayHours: 0 }, "2026-03-20")).toEqual(["2026-03-17", "2026-03-18", "2026-03-19"]);
  });

  it("retries back off and honour the provider's wait", () => {
    expect(accountingRetryDelayMs(1)).toBe(15 * 60e3);
    expect(accountingRetryDelayMs(3)).toBe(60 * 60e3);
    expect(accountingRetryDelayMs(20)).toBe(12 * 3600e3);
    expect(accountingRetryDelayMs(1, 2 * 3600e3)).toBe(2 * 3600e3);
  });

  it("settings fall back to safe defaults", () => {
    expect(parseAccountingSettings({ lookbackDays: 500 })).toMatchObject({ lookbackDays: 35, closeDelayHours: 2, journalStatus: "draft", mapping: { sales: null, byRate: {} } });
  });
});
