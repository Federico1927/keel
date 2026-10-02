import { describe, expect, it } from "vitest";
import { historyImportSince, parseTenantSettings } from "./tenant-settings";

describe("historyImportSince", () => {
  it("goes back whole calendar months and keeps the time of day", () => {
    expect(historyImportSince(new Date("2026-10-02T13:45:00Z"), 24)?.toISOString()).toBe("2024-10-02T13:45:00.000Z");
    expect(historyImportSince(new Date("2026-01-15T00:00:00Z"), 1)?.toISOString()).toBe("2025-12-15T00:00:00.000Z");
  });

  it("clamps to the last day of a shorter month", () => {
    expect(historyImportSince(new Date("2026-03-31T08:00:00Z"), 1)?.toISOString()).toBe("2026-02-28T08:00:00.000Z");
    expect(historyImportSince(new Date("2024-03-31T08:00:00Z"), 1)?.toISOString()).toBe("2024-02-29T08:00:00.000Z");
  });

  it("reads every order when the window is 0", () => {
    expect(historyImportSince(new Date("2026-10-02T00:00:00Z"), 0)).toBeNull();
  });

  it("defaults to 24 months and rejects out-of-range values", () => {
    expect(parseTenantSettings({}).historyImportMonths).toBe(24);
    expect(parseTenantSettings({ historyImportMonths: 0 }).historyImportMonths).toBe(0);
    // an invalid settings object falls back to the defaults as a whole
    expect(parseTenantSettings({ historyImportMonths: 500 }).historyImportMonths).toBe(24);
  });
});
