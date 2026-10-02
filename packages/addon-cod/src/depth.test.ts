import { describe, expect, it } from "vitest";
import { outcomeOfText, parseAmount, parseCarrierCsv, parseDay } from "./carrier-import";
import { isBottleneck, riskEconomics } from "./economics";
import { classifyCodReply, renderTemplate, templateVariablesIn, warehouseLines } from "./messages";
import { applyOutcome, bucketStats, rowAging, splitEvenly } from "./queue";
import { computeDeliveryScore, type ScoreInput } from "./scoring";
import { parseCodSettings } from "./settings";
import { isFeeLine } from "./services/modify";

const settings = parseCodSettings({});
const now = new Date("2026-10-02T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3600e3);

describe("aging and tiles", () => {
  it("colours rows by the last call, or by time in queue when never contacted", () => {
    const t = { agingWarnHours: 4, agingAlertHours: 24 };
    expect(rowAging({ lastAttemptAt: h(1), enteredAt: h(30), callBackAt: null }, now, t)).toEqual({ level: "fresh", hours: 1, neverContacted: false });
    expect(rowAging({ lastAttemptAt: h(5), enteredAt: h(30), callBackAt: null }, now, t).level).toBe("warn");
    expect(rowAging({ lastAttemptAt: null, enteredAt: h(26), callBackAt: null }, now, t)).toEqual({ level: "alert", hours: 26, neverContacted: true });
    // a call-back not yet due is never stale
    expect(rowAging({ lastAttemptAt: h(48), enteredAt: h(60), callBackAt: new Date(now.getTime() + 3600e3) }, now, t).level).toBe("fresh");
    expect(settings.agingWarnHours).toBe(4);
  });
  it("averages bucket ages and splits selections evenly", () => {
    expect(bucketStats([], now)).toEqual({ count: 0, avgAgeHours: null });
    expect(bucketStats([{ enteredAt: h(2) }, { enteredAt: h(6) }], now)).toEqual({ count: 2, avgAgeHours: 4 });
    const split = splitEvenly(["a", "b", "c", "d", "e"], [{ userId: "u2", load: 0 }, { userId: "u1", load: 0 }]);
    expect(split.get("u1")).toEqual(["a", "c", "e"]);
    expect(split.get("u2")).toEqual(["b", "d"]);
    expect(splitEvenly(["a"], []).size).toBe(0);
  });
  it("schedules a confirmation as an open status", () => {
    expect(applyOutcome({ status: "pending", noAnswerCount: 1 }, "confirm_scheduled", settings)).toEqual({ status: "confirm_scheduled", noAnswerCount: 1, callBackAt: null });
  });
});

describe("messages", () => {
  it("fills variables and lists the warehouse lines", () => {
    expect(renderTemplate("Ciao {{first_name}}, ordine {{ order_name }} da {{total}}. {{unknown}}", { first_name: "Anna", order_name: "#1001", total: "€ 49,00" })).toBe("Ciao Anna, ordine #1001 da € 49,00.");
    expect(templateVariablesIn("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
    expect(warehouseLines([{ sku: "TS-01-M", title: "T-shirt", quantity: 2 }, { sku: null, title: "Gift card", variantTitle: "50", quantity: 1 }, { sku: "FEE", title: "Fee", quantity: 1, isAncillary: true }, { sku: "X", title: "Removed", quantity: 0 }])).toBe("TS-01-M × 2\nGift card 50 × 1");
  });
});

describe("messaging replies", () => {
  it("turns a reply into confirm or cancel with the tenant's keywords, cancel first, nothing otherwise", () => {
    expect(settings.messagingReplies).toEqual({ confirm: ["yes", "confirm"], cancel: ["no", "cancel"] });
    expect(classifyCodReply("Yes!", settings.messagingReplies)).toBe("confirm");
    expect(classifyCodReply("No, cancel", settings.messagingReplies)).toBe("cancel");
    expect(classifyCodReply("When will it arrive?", settings.messagingReplies)).toBeNull();
    const it = parseCodSettings({ messagingReplies: { confirm: ["sì", "confermo"], cancel: ["annulla"] } }).messagingReplies;
    expect(classifyCodReply("SI", it)).toBe("confirm");
    expect(classifyCodReply("Confermo grazie", it)).toBe("confirm");
    expect(classifyCodReply("annulla l'ordine", it)).toBe("cancel");
    expect(classifyCodReply("yes", it)).toBeNull();
  });
});

describe("carrier import", () => {
  it("parses a semicolon CSV with Italian headers, day-first dates and decimal commas", () => {
    const r = parseCarrierCsv("Riferimento;Esito;Data;Costo\n#1001;Consegnato;03/09/2026;6,90\nTRK-2;RIFIUTATO;2026-09-04;12,50\n;consegnato;;\nTRK-3;smarrito;;\nTRK-4;reso;31/02/x;\n");
    expect(r.missingColumns).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ reference: "#1001", outcome: "delivered", costMinor: 690 });
    expect(r.rows[0]!.occurredAt!.toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(r.rows[1]).toMatchObject({ reference: "TRK-2", outcome: "refused", costMinor: 1250 });
    expect(r.errors.map((e) => e.code)).toEqual(["missing_reference", "unknown_outcome", "bad_date"]);
  });
  it("detects missing columns and other separators", () => {
    expect(parseCarrierCsv("foo,bar\n1,2").missingColumns).toEqual(["reference", "outcome"]);
    expect(parseCarrierCsv("tracking,status\nA,delivered\n").rows).toHaveLength(1);
    expect(outcomeOfText(" Returned ")).toBe("refused");
    expect(parseAmount("1.234,50")).toBe(123450);
    expect(parseAmount("")).toBeNull();
    expect(parseDay("nope")).toBe("bad");
  });
});

describe("risk economics and supervisor", () => {
  it("computes refused share, wasted cost and expected value", () => {
    expect(riskEconomics({ score: 80, marginMinor: 3000, totalMinor: 6000, refusalCostMinor: 1000, ordersTotal: 4, ordersRefused: 1 })).toEqual({ refusedPct: 25, wastedMinor: 1000, expectedValueMinor: 2200 });
    expect(riskEconomics({ score: null, marginMinor: null, totalMinor: 6000, refusalCostMinor: 1000, ordersTotal: 0, ordersRefused: 0, knownWastedMinor: 0 })).toEqual({ refusedPct: null, wastedMinor: 0, expectedValueMinor: null });
    expect(riskEconomics({ score: 20, marginMinor: null, totalMinor: 5000, refusalCostMinor: 1000, ordersTotal: 2, ordersRefused: 2, knownWastedMinor: 2600 })).toEqual({ refusedPct: 100, wastedMinor: 2600, expectedValueMinor: 200 });
    expect(isBottleneck(9, 4, 1.5)).toBe(true);
    expect(isBottleneck(5, 4, 1.5)).toBe(false);
    expect(isBottleneck(2, 0, 1.5)).toBe(false);
  });
});

describe("address provider and fee lines", () => {
  const base: ScoreInput = { customerOrders: null, prepaidDelivered: 0, attempts: 0, hoursSinceOrder: 2, closed: false, lines: [], address: { phone: "+393331234567", address1: "Via Roma 10", zip: "20121", city: "Milano", province: "MI", country: "IT" }, similarOrders: null, totalMinor: 5000, aovMinor: 5000, localHour: 12, recentCancellations: { count: 0, sharesProduct: false }, duplicates: "none", riskTier: null };
  it("turns a provider 'not found' into a critical address factor and a validated address into a stronger positive", () => {
    const bad = computeDeliveryScore({ ...base, addressCheck: { valid: false, issues: ["address1_not_found"] } }, settings).factors.find((f) => f.key === "address_quality")!;
    expect(bad).toMatchObject({ raw: 15, severity: "critical" });
    expect(bad.detail.problems).toEqual(["provider_address1_not_found"]);
    expect(computeDeliveryScore({ ...base, addressCheck: { valid: true, issues: [] } }, settings).factors.find((f) => f.key === "address_quality")!.raw).toBe(95);
  });
  it("matches COD fee lines by SKU or title with prefix wildcards", () => {
    expect(isFeeLine(["COD-FEE", "Contrassegno*"], { sku: "cod-fee", title: "x" })).toBe(true);
    expect(isFeeLine(["COD-FEE", "Contrassegno*"], { sku: null, title: "Contrassegno 3€" })).toBe(true);
    expect(isFeeLine([], { sku: "COD-FEE", title: "x" })).toBe(false);
  });
});
