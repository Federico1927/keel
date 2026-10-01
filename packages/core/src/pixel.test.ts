import { describe, expect, it } from "vitest";
import { pixelBatchSchema, pixelEventTime, sessionTouch } from "./pixel";

describe("pixel", () => {
  it("validates batches and rejects junk ids", () => {
    const ok = pixelBatchSchema.safeParse({ events: [{ event: "page_view", anonymousId: "a1b2c3d4e5", sessionId: "s1b2c3d4e5", url: "https://shop.example/" }] });
    expect(ok.success).toBe(true);
    expect(pixelBatchSchema.safeParse({ events: [{ event: "page_view", anonymousId: "<script>", sessionId: "s1b2c3d4e5" }] }).success).toBe(false);
    expect(pixelBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });
  it("clamps client time to the server clock when it drifts", () => {
    const now = new Date("2026-10-01T10:00:00Z");
    expect(pixelEventTime(now.getTime() - 60_000, now).getTime()).toBe(now.getTime() - 60_000);
    expect(pixelEventTime(now.getTime() - 3_600_000, now)).toEqual(now);
  });
  it("derives the session's channel from click ids, UTMs and external referrers only", () => {
    expect(sessionTouch("https://shop.example/p/1?fbclid=IwAR1&utm_source=facebook", null)).toMatchObject({ channel: "paid_social", clickId: "IwAR1", paid: true });
    expect(sessionTouch("https://shop.example/?gclid=Cj0", null).channel).toBe("paid_search");
    expect(sessionTouch("https://shop.example/", "https://www.google.com/").channel).toBe("organic_search");
    expect(sessionTouch("https://shop.example/cart", "https://shop.example/p/1").channel).toBe("direct");
  });
});
