import { describe, expect, it } from "vitest";
import { failedInARow, failureAlertSignature, nextZeroRowRuns, retentionCutoff, sourceStaleness, sourceStatus, windowElapsed, type IntegrationSourceState } from "./reliability";

const now = new Date("2026-10-02T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const base: IntegrationSourceState = { source: "meta", lastSuccessAt: ago(30), connectedAt: ago(10_000), freshnessMinutes: 120, consecutiveFailures: 0, zeroRowRuns: 0 };

describe("source status (#32)", () => {
  it("is ok inside the freshness window and stale once the last success is older than it", () => {
    expect(sourceStatus(base, now)).toBe("ok");
    expect(sourceStaleness({ ...base, lastSuccessAt: ago(119) }, now).stale).toBe(false);
    const late = sourceStaleness({ ...base, lastSuccessAt: ago(150) }, now);
    expect(late).toEqual({ stale: true, minutesLate: 30 });
    expect(sourceStatus({ ...base, lastSuccessAt: ago(150) }, now)).toBe("stale");
  });
  it("counts a never-synced source from when it was connected", () => {
    expect(sourceStatus({ ...base, lastSuccessAt: null, connectedAt: ago(60) }, now)).toBe("unknown");
    expect(sourceStatus({ ...base, lastSuccessAt: null, connectedAt: ago(600) }, now)).toBe("stale");
  });
  it("stale wins over errors; errors win over idle", () => {
    expect(sourceStatus({ ...base, consecutiveFailures: 5, lastSuccessAt: ago(500) }, now)).toBe("stale");
    expect(sourceStatus({ ...base, consecutiveFailures: 3 }, now)).toBe("error");
    expect(sourceStatus({ ...base, consecutiveFailures: 1, zeroRowRuns: 9 }, now)).toBe("degraded");
  });
  it("is idle after N zero-row runs, N per provider", () => {
    expect(sourceStatus({ ...base, zeroRowRuns: 2 }, now)).toBe("ok");
    expect(sourceStatus({ ...base, zeroRowRuns: 3 }, now)).toBe("idle");
    expect(sourceStatus({ ...base, source: "shopify", freshnessMinutes: 30, zeroRowRuns: 3 }, now)).toBe("ok");
    expect(sourceStatus({ ...base, source: "shopify", freshnessMinutes: 30, zeroRowRuns: 96 }, now)).toBe("idle");
  });
  it("never marks event-driven sources (webhooks, writes) stale or idle", () => {
    expect(sourceStatus({ ...base, source: "shopify:webhooks", lastSuccessAt: ago(5000), zeroRowRuns: 50 }, now)).toBe("ok");
    expect(sourceStatus({ ...base, source: "shopify:writes", consecutiveFailures: 3, lastSuccessAt: ago(5000) }, now)).toBe("error");
    expect(sourceStatus({ ...base, source: "shopify:returns", lastSuccessAt: ago(5000) }, now)).toBe("stale");
  });
  it("moves the zero-row streak only on successful runs with a row count", () => {
    expect(nextZeroRowRuns(2, true, 0)).toBe(3);
    expect(nextZeroRowRuns(2, true, 5)).toBe(0);
    expect(nextZeroRowRuns(2, false, 0)).toBe(2);
    expect(nextZeroRowRuns(2, true, undefined)).toBe(2);
  });
});

describe("failure alerts (#32)", () => {
  it("one signature per kind, tenant and subject", () => {
    expect(failureAlertSignature("job_failure", "t1", "sync.ads")).toBe("job_failure:t1:sync.ads");
    expect(failureAlertSignature("job_failure", null, "tick:billing")).toBe("job_failure:platform:tick:billing");
  });
  it("needs the newest N runs to have failed", () => {
    expect(failedInARow(["failed", "failed", "failed", "succeeded"], 3)).toBe(true);
    expect(failedInARow(["failed", "succeeded", "failed", "failed"], 3)).toBe(false);
    expect(failedInARow(["failed", "failed"], 3)).toBe(false);
  });
  it("notifies again only after the window", () => {
    expect(windowElapsed(null, 360, now)).toBe(true);
    expect(windowElapsed(ago(359), 360, now)).toBe(false);
    expect(windowElapsed(ago(360), 360, now)).toBe(true);
  });
  it("retention cutoff is N days back", () => {
    expect(retentionCutoff(180, now).toISOString()).toBe("2026-04-05T12:00:00.000Z");
  });
});
