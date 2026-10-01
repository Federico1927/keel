import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "./http";
import { GoogleConversionsSink, MetaConversionsSink, MockConversionSink, fbcFromClickId, googleConversionPayload, hashUserData, metaEventPayload, type ConversionEvent } from "./conversions";

const at = (key: string, body: unknown) => fixtureFetch([{ match: (url, init) => `${init?.method ?? "GET"} ${url.split("?")[0]}` === key, body }]);
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const user = hashUserData({ email: " Ada@Example.com ", phoneE164: "+393491234567", firstName: "Ada", lastName: "Lovelace", city: "San Donà", zip: "20 121", country: "IT", externalId: "cust-1" });
const event: ConversionEvent = { eventId: "keel-order-5001", eventName: "Purchase", eventTime: new Date("2026-09-30T10:00:00Z"), orderExternalId: "5001", valueMinor: 12990, currency: "EUR", user, clickIds: { fbclid: "IwAR1", gclid: "Cj0K" }, fbp: "fb.1.1700000000000.123", fbc: null, clientIp: "203.0.113.9", userAgent: "Mozilla/5.0", sourceUrl: "https://shop.example/checkout/thank_you" };

describe("hashing", () => {
  it("normalises then hashes with Meta's rules", () => {
    expect(user.em).toBe(sha("ada@example.com"));
    expect(user.ph).toBe(sha("393491234567"));
    expect(user.phE164).toBe(sha("+393491234567"));
    expect(user.ct).toBe(sha("sandonà"));
    expect(user.zp).toBe(sha("20121"));
    expect(user.country).toBe(sha("it"));
    expect(hashUserData({ email: "nope" }).em).toBeUndefined();
    expect(fbcFromClickId("IwAR1", new Date(1700000000000))).toBe("fb.1.1700000000000.IwAR1");
  });
});

describe("Meta Conversions API", () => {
  it("builds the documented payload with hashed user data only", () => {
    const p = metaEventPayload(event) as { user_data: Record<string, unknown>; custom_data: Record<string, unknown>; event_time: number; event_id: string };
    expect(p.event_id).toBe("keel-order-5001");
    expect(p.event_time).toBe(1790762400);
    expect(p.user_data.em).toEqual([user.em]);
    expect(p.user_data.client_ip_address).toBe("203.0.113.9");
    expect(p.custom_data).toEqual({ currency: "EUR", value: 129.9, order_id: "5001" });
    expect(JSON.stringify(p)).not.toContain("example.com");
  });
  it("posts the batch to the dataset with the test code, and maps errors", async () => {
    const ok = new MetaConversionsSink({ accessToken: "tok", adAccountId: "act_1" }, "999", { testEventCode: "TEST123", fetchImpl: at("POST https://graph.facebook.com/v21.0/999/events", { events_received: 1 }) });
    expect(await ok.send([event])).toEqual([{ eventId: "keel-order-5001", ok: true }]);
    const body = JSON.parse(ok.http.calls[0]!.body!);
    expect(body.test_event_code).toBe("TEST123");
    expect(body.data).toHaveLength(1);
    const bad = new MetaConversionsSink({ accessToken: "tok", adAccountId: "act_1" }, "999", { fetchImpl: at("POST https://graph.facebook.com/v21.0/999/events", { error: { message: "Invalid OAuth access token", code: 190 } }) });
    await expect(bad.send([event])).rejects.toMatchObject({ code: "token_expired" });
  });
});

describe("Google click conversions", () => {
  it("needs a click id or an identifier and reports partial failures per row", async () => {
    expect(googleConversionPayload({ ...event, clickIds: {}, user: {} }, "x")).toBeNull();
    const second = { ...event, eventId: "keel-order-5002", orderExternalId: "5002" };
    const empty = { ...event, eventId: "keel-order-5003", clickIds: {}, user: {} };
    const sink = new GoogleConversionsSink({ developerToken: "d", clientId: "c", clientSecret: "s", refreshToken: "r", customerId: "123-456-7890" }, "777", {
      accessToken: "at",
      fetchImpl: at("POST https://googleads.googleapis.com/v18/customers/1234567890:uploadClickConversions", { partialFailureError: { message: "1 failed", details: [{ errors: [{ message: "The click was too old", location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }] } }] }] } }),
    });
    const r = await sink.send([event, second, empty]);
    expect(r[0]).toEqual({ eventId: "keel-order-5001", ok: true });
    expect(r[1]).toMatchObject({ ok: false, error: "The click was too old" });
    expect(r[2]).toMatchObject({ skipped: true });
    const body = JSON.parse(sink.http.calls[0]!.body!);
    expect(body.partialFailure).toBe(true);
    expect(body.conversions[0]).toMatchObject({ gclid: "Cj0K", conversionAction: "customers/1234567890/conversionActions/777", conversionDateTime: "2026-09-30 10:00:00+00:00", conversionValue: 129.9, orderId: "5001" });
    expect(body.conversions[0].userIdentifiers[0].hashedEmail).toBe(user.em);
  });
});

describe("MockConversionSink", () => {
  it("records events and fails on demand", async () => {
    const m = new MockConversionSink("meta");
    await m.send([event]);
    expect(m.received).toHaveLength(1);
    m.failures.failNext("rate_limited");
    await expect(m.send([event])).rejects.toThrow();
  });
});
