import { describe, expect, it } from "vitest";
import { dashboardPeriod, localMonthKey, parseNoteMarkdown, projectMonthEnd, safeHref, targetForMonth } from "./dashboards";

describe("dashboard periods", () => {
  const now = new Date("2026-10-15T10:30:00Z");
  it("today and rolling windows start at local midnight", () => {
    expect(dashboardPeriod("today", now, "Europe/Rome").from.toISOString()).toBe("2026-10-14T22:00:00.000Z");
    expect(dashboardPeriod("7d", now, "UTC").from.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(dashboardPeriod("30d", now, "America/New_York").from.toISOString()).toBe("2026-09-16T04:00:00.000Z");
    expect(dashboardPeriod("30d", now, "UTC").to).toBe(now);
  });
  it("month to date, last month and year to date follow the tenant calendar", () => {
    expect(dashboardPeriod("mtd", now, "Europe/Rome").from.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    const lm = dashboardPeriod("last_month", now, "UTC");
    expect([lm.from.toISOString(), lm.to.toISOString()]).toEqual(["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    expect(dashboardPeriod("last_month", new Date("2026-01-10T12:00:00Z"), "UTC").from.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(dashboardPeriod("ytd", now, "UTC").from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
  it("month key in the tenant time zone", () => {
    expect(localMonthKey(new Date("2026-09-30T23:30:00Z"), "Europe/Rome")).toBe("2026-10");
    expect(localMonthKey(new Date("2026-09-30T23:30:00Z"), "UTC")).toBe("2026-09");
  });
});

describe("targets", () => {
  it("a month uses its own target or carries the latest earlier one forward", () => {
    const t = [{ month: "2026-08", target: 100 }, { month: "2026-10", target: 300 }];
    expect(targetForMonth(t, "2026-09")?.target).toBe(100);
    expect(targetForMonth(t, "2026-10")?.target).toBe(300);
    expect(targetForMonth(t, "2026-07")).toBeNull();
  });
  it("projects additive metrics with the run rate and keeps rates", () => {
    expect(projectMonthEnd(1000, true, 10, 30)).toBe(3000);
    expect(projectMonthEnd(0.25, false, 10, 30)).toBe(0.25);
    expect(projectMonthEnd(null, true, 10, 30)).toBeNull();
  });
});

describe("note markdown", () => {
  it("parses headings, lists and inline marks into data", () => {
    const b = parseNoteMarkdown("## Daily routine\nCheck **late** orders first.\n\n- one\n- *two*\n1. a\n2. b");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol"]);
    expect(b[1]).toEqual({ t: "p", inl: [{ t: "text", v: "Check " }, { t: "strong", v: "late" }, { t: "text", v: " orders first." }] });
  });
  it("never lets markup or unsafe links through", () => {
    const b = parseNoteMarkdown("<script>alert(1)</script> [x](javascript:alert(1)) [ok](/t/a/orders)");
    const inl = b[0]!.t === "p" ? b[0]!.inl : [];
    expect(inl[0]).toEqual({ t: "text", v: "<script>alert(1)</script> " });
    expect(inl.filter((i) => i.t === "link")).toEqual([{ t: "link", v: "ok", href: "/t/a/orders" }]);
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  });
});
