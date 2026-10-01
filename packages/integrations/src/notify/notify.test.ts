import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { HttpEmailSink, MockNotificationSink, SlackWebhookSink, parseEmailDeliveryEvent } from "./index";

describe("notification sinks", () => {
  it("posts a Slack message to the incoming webhook", async () => {
    let body = "";
    const sink = new SlackWebhookSink("https://hooks.slack.com/services/T000/B000/XXX", { fetchImpl: fixtureFetch([{ match: (u, i) => u.startsWith("https://hooks.slack.com/") && i?.method === "POST", body: (_u: string, i?: { body?: string }) => ((body = i?.body ?? ""), "ok") }]) });
    await sink.send([], { subject: "ROAS low", text: "MER 1.8", url: "https://app/x" });
    expect(JSON.parse(body).text).toContain("*ROAS low*");
    expect(() => new SlackWebhookSink("https://evil.example/hook")).toThrow();
  });
  it("sends an email through the provider API and returns its id", async () => {
    const sink = new HttpEmailSink({ apiKey: "k", from: "alerts@keel.test" }, { fetchImpl: fixtureFetch([{ match: (u) => u.endsWith("/emails"), body: { id: "em_1" } }]) });
    expect(await sink.send(["a@b.c"], { subject: "s", text: "t" })).toEqual({ id: "em_1" });
    expect(await sink.send([], { subject: "s", text: "t" })).toEqual({ id: null });
  });
  it("sends html, headers and tags when given", async () => {
    let body = "";
    const sink = new HttpEmailSink({ apiKey: "k", from: "a@keel.test" }, { fetchImpl: fixtureFetch([{ match: (u) => u.endsWith("/emails"), body: (_u: string, i?: { body?: string }) => ((body = i?.body ?? ""), { id: "em_2" }) }]) });
    await sink.send(["a@b.c"], { subject: "s", text: "t", html: "<p>t</p>", headers: { "List-Unsubscribe": "<https://x/u>" }, tags: { tenant_id: "t1" } });
    const sent = JSON.parse(body);
    expect(sent.html).toBe("<p>t</p>");
    expect(sent.headers["List-Unsubscribe"]).toBe("<https://x/u>");
    expect(sent.tags).toEqual([{ name: "tenant_id", value: "t1" }]);
  });
  it("parses bounce and complaint events", () => {
    const tid = "11111111-2222-4333-8444-555555555555";
    expect(parseEmailDeliveryEvent({ type: "email.bounced", data: { to: ["A@B.c"], tags: [{ name: "tenant_id", value: tid }] } })).toEqual({ kind: "bounce", emails: ["a@b.c"], tenantId: tid });
    expect(parseEmailDeliveryEvent({ type: "email.complained", data: { to: "x@y.z", tags: { tenant_id: "nope" } } })).toEqual({ kind: "complaint", emails: ["x@y.z"], tenantId: null });
    expect(parseEmailDeliveryEvent({ type: "email.delivered", data: { to: ["a@b.c"] } })).toBeNull();
    expect(parseEmailDeliveryEvent("junk")).toBeNull();
  });
  it("mock records", async () => {
    const m = new MockNotificationSink("email");
    await m.send(["x@y.z"], { subject: "a", text: "b" });
    expect(m.sent).toHaveLength(1);
  });
});
