import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { HttpEmailSink, MockNotificationSink, SlackWebhookSink } from "./index";

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
  it("mock records", async () => {
    const m = new MockNotificationSink("email");
    await m.send(["x@y.z"], { subject: "a", text: "b" });
    expect(m.sent).toHaveLength(1);
  });
});
