import { describe, expect, it } from "vitest";
import { attributionWeights, creditBy, type AttributedOrder, type Touchpoint } from "./attribution-models";

const at = (d: number) => new Date(Date.UTC(2026, 8, d));
const touches: Touchpoint[] = [
  { at: at(1), channel: "paid_social", campaignId: "meta-1", paid: true },
  { at: at(8), channel: "email", campaignId: null, paid: false },
  { at: at(14), channel: "paid_search", campaignId: "g-1", paid: true },
  { at: at(15), channel: "direct", campaignId: null, paid: false },
];
const orderAt = at(15);
const w = (m: Parameters<typeof attributionWeights>[0]) => attributionWeights(m, touches, orderAt).map((x) => Math.round(x.weight * 1000) / 1000);

describe("attribution models", () => {
  it("single-touch models give everything to one touch", () => {
    expect(w("last_click")).toEqual([0, 0, 0, 1]);
    expect(w("first_click")).toEqual([1, 0, 0, 0]);
    // the platform claim skips the organic closing visit
    expect(w("last_platform_click")).toEqual([0, 0, 1, 0]);
  });
  it("multi-touch models split one unit of credit", () => {
    expect(w("linear")).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(w("position_based")).toEqual([0.4, 0.1, 0.1, 0.4]);
    const decay = w("time_decay");
    expect(decay.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 2);
    expect(decay[3]).toBeGreaterThan(decay[2]!);
    expect(decay[0]).toBeLessThan(decay[1]!);
  });
  it("ignores touches after the order and outside the lookback; no paid touch → no platform credit", () => {
    expect(attributionWeights("last_click", [...touches, { at: at(20), channel: "x", campaignId: null, paid: true }], orderAt).length).toBe(4);
    expect(attributionWeights("linear", touches, orderAt, { lookbackDays: 3 }).map((x) => x.touch.channel)).toEqual(["paid_search", "direct"]);
    expect(attributionWeights("last_platform_click", touches.filter((t) => !t.paid), orderAt)).toEqual([]);
    expect(attributionWeights("position_based", touches.slice(0, 2), orderAt).map((x) => x.weight)).toEqual([0.5, 0.5]);
  });
  it("credits revenue and fractional orders per key", () => {
    const orders: AttributedOrder[] = [{ orderId: "o1", at: orderAt, netMinor: 10_000, marginMinor: 4_000, touches }];
    expect(creditBy("linear", orders, (t) => t.channel)).toEqual([
      { key: "paid_social", orders: 0.25, netMinor: 2500, marginMinor: 1000 },
      { key: "email", orders: 0.25, netMinor: 2500, marginMinor: 1000 },
      { key: "paid_search", orders: 0.25, netMinor: 2500, marginMinor: 1000 },
      { key: "direct", orders: 0.25, netMinor: 2500, marginMinor: 1000 },
    ]);
    expect(creditBy("last_platform_click", orders, (t) => t.campaignId)).toEqual([{ key: "g-1", orders: 1, netMinor: 10_000, marginMinor: 4_000 }]);
  });
});

describe("survey blend", () => {
  const at = new Date("2026-09-30T12:00:00Z");
  const touch = (daysAgo: number, channel: string) => ({ at: new Date(at.getTime() - daysAgo * 864e5), channel, campaignId: channel === "paid_social" ? "c1" : null, paid: channel.startsWith("paid") });
  it("splits an answered order between the clicks and the reported channel", async () => {
    const { creditBy } = await import("./attribution-models");
    const rows = creditBy("survey_blend", [{ orderId: "o1", at, netMinor: 1000, marginMinor: 400, touches: [touch(1, "paid_social")], surveyChannel: "podcast" }], (t) => t.channel, { surveyBlend: 0.6 });
    expect(rows.find((r) => r.key === "podcast")).toMatchObject({ orders: 0.6, netMinor: 600 });
    expect(rows.find((r) => r.key === "paid_social")).toMatchObject({ orders: 0.4, netMinor: 400 });
  });
  it("is time decay without an answer, and all to the answer without clicks", async () => {
    const { creditBy } = await import("./attribution-models");
    const plain = creditBy("survey_blend", [{ orderId: "o1", at, netMinor: 1000, marginMinor: 0, touches: [touch(1, "email")] }], (t) => t.channel);
    expect(plain).toEqual([{ key: "email", orders: 1, netMinor: 1000, marginMinor: 0 }]);
    const noClicks = creditBy("survey_blend", [{ orderId: "o2", at, netMinor: 500, marginMinor: 0, touches: [], surveyChannel: "word_of_mouth" }], (t) => t.channel);
    expect(noClicks).toEqual([{ key: "word_of_mouth", orders: 1, netMinor: 500, marginMinor: 0 }]);
    const byCampaign = creditBy("survey_blend", [{ orderId: "o3", at, netMinor: 1000, marginMinor: 0, touches: [touch(1, "paid_social")], surveyChannel: "friend" }], (t) => t.campaignId);
    expect(byCampaign).toEqual([{ key: "c1", orders: 0.5, netMinor: 500, marginMinor: 0 }]);
  });
});
