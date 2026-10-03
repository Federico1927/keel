import { describe, expect, it } from "vitest";
import { jobLogLine, summarize } from "./job-log";
import { QUEUES } from "./queues";

describe("worker log lines", () => {
  it("summarizes counts and identifiers, never free text or addresses", () => {
    expect(summarize({ imported: 250, done: false, cursor: "eyJ0IjoxfQ==", status: "running", note: "Mario Rossi", email: "a@b.it" })).toBe("imported=250 done=false status=running");
    expect(summarize(null)).toBe("");
  });
  it("names the queue, job type, tenant and outcome on one line", () => {
    const line = jobLogLine("failed", QUEUES.syncOrders, { tenantId: "t-1", kind: "history" }, Date.now() - 1500, "Shopify answered 401\nretry later");
    expect(line).toMatch(/^\[jobs\] failed sync\.orders type=\S+ tenant=t-1 1\.\ds Shopify answered 401 retry later$/);
  });
});
