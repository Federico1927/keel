import { describe, expect, it } from "vitest";
import { campaignExclusion, campaignMessageKey, campaignRetryDelayMs, canApproveCampaign, effectiveSendStart, isInSendWindow, isOverFrequencyCap, nextCampaignStatus, nextSendWindowStart, throttleAllowance, type CampaignCandidate } from "./customer-campaigns";

describe("campaign workflow", () => {
  it("one-off: draft → approval → approved → scheduled → sending → sent, nothing skipped", () => {
    expect(nextCampaignStatus("one_off", "draft", "submit")).toBe("pending_approval");
    expect(nextCampaignStatus("one_off", "pending_approval", "approve")).toBe("approved");
    expect(nextCampaignStatus("one_off", "pending_approval", "reject")).toBe("draft");
    expect(nextCampaignStatus("one_off", "approved", "schedule")).toBe("scheduled");
    expect(nextCampaignStatus("one_off", "scheduled", "unschedule")).toBe("approved");
    expect(nextCampaignStatus("one_off", "scheduled", "start")).toBe("sending");
    expect(nextCampaignStatus("one_off", "sending", "finish")).toBe("sent");
    expect(nextCampaignStatus("one_off", "draft", "approve")).toBeNull();
    expect(nextCampaignStatus("one_off", "draft", "schedule")).toBeNull();
    expect(nextCampaignStatus("one_off", "sent", "reopen")).toBeNull();
    expect(nextCampaignStatus("one_off", "sending", "reopen")).toBeNull();
    expect(nextCampaignStatus("one_off", "approved", "activate")).toBeNull();
  });
  it("sequence: approved → active ⇄ paused", () => {
    expect(nextCampaignStatus("sequence", "approved", "activate")).toBe("active");
    expect(nextCampaignStatus("sequence", "active", "pause")).toBe("paused");
    expect(nextCampaignStatus("sequence", "paused", "activate")).toBe("active");
    expect(nextCampaignStatus("sequence", "approved", "schedule")).toBeNull();
  });
  it("the author approves only as owner", () => {
    expect(canApproveCampaign({ roleCanApprove: true, isOwner: false, isAuthor: false })).toBe(true);
    expect(canApproveCampaign({ roleCanApprove: true, isOwner: false, isAuthor: true })).toBe(false);
    expect(canApproveCampaign({ roleCanApprove: true, isOwner: true, isAuthor: true })).toBe(true);
    expect(canApproveCampaign({ roleCanApprove: false, isOwner: false, isAuthor: false })).toBe(false);
  });
});

describe("send window", () => {
  const rome = { startHour: 9, endHour: 20, timeZone: "Europe/Rome" };
  it("reads local hours in the tenant zone", () => {
    // 07:30 UTC in July = 09:30 in Rome
    expect(isInSendWindow(new Date("2026-07-01T07:30:00Z"), rome)).toBe(true);
    expect(isInSendWindow(new Date("2026-07-01T06:59:00Z"), rome)).toBe(false);
    expect(isInSendWindow(new Date("2026-07-01T18:00:00Z"), rome)).toBe(false);
    expect(isInSendWindow(new Date("2026-07-01T03:00:00Z"), { startHour: 0, endHour: 24, timeZone: "UTC" })).toBe(true);
    expect(isInSendWindow(new Date("2026-07-01T23:30:00Z"), { startHour: 22, endHour: 6, timeZone: "UTC" })).toBe(true);
    expect(isInSendWindow(new Date("2026-07-01T12:00:00Z"), { startHour: 22, endHour: 6, timeZone: "UTC" })).toBe(false);
  });
  it("moves a time outside the window to the next opening, across DST", () => {
    expect(nextSendWindowStart(new Date("2026-07-01T05:00:00Z"), rome).toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(nextSendWindowStart(new Date("2026-07-01T19:00:00Z"), rome).toISOString()).toBe("2026-07-02T07:00:00.000Z");
    // the night of the change to summer time (29 March 2026): 09:00 local is 07:00 UTC
    expect(nextSendWindowStart(new Date("2026-03-28T21:00:00Z"), rome).toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(nextSendWindowStart(new Date("2026-01-11T02:00:00Z"), { ...rome, timeZone: "America/New_York" }).toISOString()).toBe("2026-01-11T14:00:00.000Z");
    const inside = new Date("2026-07-01T10:00:00Z");
    expect(nextSendWindowStart(inside, rome)).toBe(inside);
  });
  it("a request in the past starts now (or at the next opening)", () => {
    const now = new Date("2026-07-01T10:00:00Z");
    expect(effectiveSendStart(new Date("2026-06-01T10:00:00Z"), now, rome)).toEqual(now);
    expect(effectiveSendStart(new Date("2026-07-03T21:00:00Z"), now, rome).toISOString()).toBe("2026-07-04T07:00:00.000Z");
  });
});

describe("throttle, cap, retries, key", () => {
  it("allowance per minute never goes negative", () => {
    expect(throttleAllowance(60, 0)).toBe(60);
    expect(throttleAllowance(60, 59)).toBe(1);
    expect(throttleAllowance(60, 80)).toBe(0);
  });
  it("cap: N messages in the window block the next one", () => {
    expect(isOverFrequencyCap(2, 3)).toBe(false);
    expect(isOverFrequencyCap(3, 3)).toBe(true);
  });
  it("backoff grows and the key is stable", () => {
    expect(campaignRetryDelayMs(1)).toBe(60_000);
    expect(campaignRetryDelayMs(2)).toBe(240_000);
    expect(campaignMessageKey("c", "u", "email")).toBe(campaignMessageKey("c", "u", "email"));
    expect(campaignMessageKey("c", "u", "email")).not.toBe(campaignMessageKey("c", "u", "sms"));
  });
});

describe("exclusions", () => {
  const ok: CampaignCandidate = { acceptsMarketing: true, suppressed: false, recentMessages: 0, hasOpenOrder: false, inMeasurement: false, group: "treated" };
  const rules = { frequencyCap: 3, excludeOpenOrders: true, measurementLock: true };
  it("first matching reason, holdout last", () => {
    expect(campaignExclusion(ok, rules)).toBeNull();
    expect(campaignExclusion({ ...ok, acceptsMarketing: false, suppressed: true }, rules)).toBe("no_consent");
    expect(campaignExclusion({ ...ok, suppressed: true, recentMessages: 9 }, rules)).toBe("suppressed");
    expect(campaignExclusion({ ...ok, recentMessages: 3, hasOpenOrder: true }, rules)).toBe("over_cap");
    expect(campaignExclusion({ ...ok, hasOpenOrder: true, inMeasurement: true }, rules)).toBe("open_order");
    expect(campaignExclusion({ ...ok, inMeasurement: true, group: "holdout" }, rules)).toBe("in_measurement");
    expect(campaignExclusion({ ...ok, group: "holdout" }, rules)).toBe("holdout");
  });
  it("open orders and the measurement lock can be switched off", () => {
    expect(campaignExclusion({ ...ok, hasOpenOrder: true }, { ...rules, excludeOpenOrders: false })).toBeNull();
    expect(campaignExclusion({ ...ok, inMeasurement: true }, { ...rules, measurementLock: false })).toBeNull();
  });
});
