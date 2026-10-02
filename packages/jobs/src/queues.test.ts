import { describe, expect, it } from "vitest";
import { QUEUES, historyImportJobs, jobTypeOf, resyncJobsFor, runNowJob, syncSingletonKey } from "./queues";

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
  it("a stale Meta ad account re-pulls that account alone (#82)", () => {
    const [one] = resyncJobsFor("t1", "meta:act_200", now);
    expect(one).toMatchObject({ data: { provider: "meta", accountExternalId: "act_200" }, singletonKey: "t1:meta:2026-10-02:act_200" });
    for (const source of ["meta", "meta:entities", "meta:writes"]) expect(resyncJobsFor("t1", source, now)[0]!.data).not.toHaveProperty("accountExternalId");
  });
});

describe("subscription app resync (addon.subscriptions)", () => {
  it("re-reads a stale subscription app through the add-on's tick", () => {
    for (const source of ["shopify_subscriptions", "recharge", "loop"]) expect(resyncJobsFor("t1", source)).toEqual([{ queue: QUEUES.tick, data: { kind: "subscriptions" }, singletonKey: "t1:subscriptions" }]);
    expect(runNowJob("tick:subscriptions", null)).toEqual({ queue: QUEUES.tick, data: { kind: "subscriptions" } });
  });
});

describe("history import jobs (#87)", () => {
  it("queues exactly one initial orders job, the full catalog and the returns, each with its own per-tenant key", () => {
    const jobs = historyImportJobs("t1");
    expect(jobs.filter((j) => j.queue === QUEUES.syncOrders)).toEqual([{ queue: QUEUES.syncOrders, data: { tenantId: "t1", kind: "initial" }, singletonKey: "t1:initial" }]);
    expect(jobs.map((j) => j.singletonKey)).toEqual(["t1:catalog:initial", "t1:initial", "t1:returns:initial"]);
    // a resume queues only what is not finished
    expect(historyImportJobs("t1", ["orders"]).map((j) => j.queue)).toEqual([QUEUES.syncOrders]);
    // never the delta lanes' keys, so a resync cannot swallow the import
    expect(syncSingletonKey(QUEUES.syncCatalog, "t1", "delta")).toBe("t1:catalog:catalog");
    expect(syncSingletonKey(QUEUES.syncReturns, "t1", "delta")).toBe("t1:returns");
  });
});
