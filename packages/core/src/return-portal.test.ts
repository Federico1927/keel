import { describe, expect, it } from "vitest";
import { isValidIban, matchesOrderLookup, needsBankDetails, normalizeTrackingCode, parsePortalConfig, pickLocalized, proposedReturnAmount, rateLimitDecision, validatePortalAnswers } from "./return-portal";

describe("return portal", () => {
  it("parses a partial config with defaults and rejects bad colours", () => {
    const c = parsePortalConfig({ enabled: true, title: { it: "Resi" } });
    expect(c.enabled).toBe(true);
    expect(c.resolutions).toEqual(["refund", "exchange", "voucher"]);
    expect(parsePortalConfig({ primaryColor: "red" }).enabled).toBe(false);
  });
  it("picks text by language with fallbacks", () => {
    expect(pickLocalized({ it: "Ciao", en: "Hi" }, "es", "it")).toBe("Ciao");
    expect(pickLocalized({ en: "Hi" }, "es", "it")).toBe("Hi");
    expect(pickLocalized({}, "es", "it")).toBe("");
  });
  it("validates custom answers", () => {
    const fields = [
      { key: "size", type: "select" as const, label: {}, required: true, options: ["S", "M"], optionLabels: {} },
      { key: "worn", type: "checkbox" as const, label: {}, required: false, options: [], optionLabels: {} },
    ];
    expect(validatePortalAnswers(fields, { size: "M" })).toEqual({ ok: true, values: { size: "M", worn: false } });
    expect(validatePortalAnswers(fields, { size: "XL" })).toEqual({ ok: false, errors: ["size"] });
    expect(validatePortalAnswers(fields, {})).toEqual({ ok: false, errors: ["size"] });
  });
  it("checks IBANs with mod 97", () => {
    expect(isValidIban("IT60 X054 2811 1010 0000 0123 456")).toBe(true);
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("IT60X0542811101000000123457")).toBe(false);
    expect(isValidIban("hello")).toBe(false);
  });
  it("asks bank details only for configured methods and refunds", () => {
    const c = parsePortalConfig({ bankDetailsFor: ["cod", "bank_transfer"] });
    expect(needsBankDetails(c, "cod", "refund")).toBe(true);
    expect(needsBankDetails(c, "cod", "voucher")).toBe(false);
    expect(needsBankDetails(c, "card", "refund")).toBe(false);
  });
  it("matches the order by number with or without prefix and by email or phone", () => {
    const o = { name: "#NW-1042", email: "Anna.Rossi@Example.com", phone: "+39 333 123 4567" };
    expect(matchesOrderLookup(o, { orderNumber: "1042", contact: "anna.rossi@example.com" }, "NW-", "email")).toBe(true);
    expect(matchesOrderLookup(o, { orderNumber: "#nw-1042", contact: "anna.rossi@example.com" }, "NW-", "email")).toBe(true);
    expect(matchesOrderLookup(o, { orderNumber: "1043", contact: "anna.rossi@example.com" }, "NW-", "email")).toBe(false);
    expect(matchesOrderLookup(o, { orderNumber: "1042", contact: "333 1234567" }, "NW-", "email")).toBe(false);
    expect(matchesOrderLookup(o, { orderNumber: "1042", contact: "333 1234567" }, "NW-", "email_or_phone")).toBe(true);
    expect(matchesOrderLookup(o, { orderNumber: "1042", contact: "other@example.com" }, "NW-", "email_or_phone")).toBe(false);
  });
  it("normalizes tracking codes", () => {
    expect(normalizeTrackingCode(" 1z 999.aa1 ")).toBe("1Z999AA1");
    expect(normalizeTrackingCode("abc")).toBeNull();
  });
  it("deducts return shipping only when the customer is at fault", () => {
    const lines = [{ quantity: 2, unitNetMinor: 2500 }];
    expect(proposedReturnAmount(lines, "customer", 600)).toEqual({ goodsMinor: 5000, deductionMinor: 600, proposedMinor: 4400 });
    expect(proposedReturnAmount(lines, "merchant", 600).proposedMinor).toBe(5000);
    expect(proposedReturnAmount([{ quantity: 1, unitNetMinor: 300 }], "customer", 600).proposedMinor).toBe(0);
  });
  it("limits attempts in a fixed window", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    let st: { windowStart: Date; count: number } | null = null;
    for (let i = 0; i < 5; i++) {
      const d = rateLimitDecision(st, now, 900, 5);
      expect(d.allowed).toBe(true);
      st = d;
    }
    const blocked = rateLimitDecision(st, new Date(now.getTime() + 60_000), 900, 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(840);
    expect(rateLimitDecision(st, new Date(now.getTime() + 900_000), 900, 5).allowed).toBe(true);
  });
});
