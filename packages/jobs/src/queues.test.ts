import { describe, expect, it } from "vitest";
import { QUEUES, jobTypeOf, resyncJobsFor, runNowJob } from "./queues";

describe("ads resyncs (watchdog, run now)", () => {
  const now = new Date("2026-10-02T06:00:00Z");
  it("re-pulls every ad platform's stale source, TikTok included", () => {
    for (const source of ["meta", "google", "tiktok", "tiktok:entities"]) {
      const [job] = resyncJobsFor("t1", source, now);
      expect(job).toMatchObject({ queue: QUEUES.syncAds, data: { tenantId: "t1", provider: source.split(":")[0], until: "2026-10-02" } });
    }
    expect(resyncJobsFor("t1", "snapchat", now)).toEqual([]);
    expect(jobTypeOf(QUEUES.syncAds, { provider: "tiktok" })).toBe("sync.ads:tiktok");
    expect(runNowJob("sync.ads:tiktok", "t1", now)).toMatchObject({ queue: QUEUES.syncAds, data: { provider: "tiktok" } });
  });
});

describe("subscription app resync (addon.subscriptions)", () => {
  it("re-reads a stale subscription app through the add-on's tick", () => {
    for (const source of ["shopify_subscriptions", "recharge", "loop"]) expect(resyncJobsFor("t1", source)).toEqual([{ queue: QUEUES.tick, data: { kind: "subscriptions" }, singletonKey: "t1:subscriptions" }]);
    expect(runNowJob("tick:subscriptions", null)).toEqual({ queue: QUEUES.tick, data: { kind: "subscriptions" } });
  });
});
