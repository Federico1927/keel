import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { MockNotificationSink, SlackWebhookSink } from "./index";

describe("notification sinks", () => {
  it("posts a Slack message to the incoming webhook", async () => {
    let body = "";
    const sink = new SlackWebhookSink("https://hooks.slack.com/services/T000/B000/XXX", { fetchImpl: fixtureFetch([{ match: (u, i) => u.startsWith("https://hooks.slack.com/") && i?.method === "POST", body: (_u: string, i?: { body?: string }) => ((body = i?.body ?? ""), "ok") }]) });
    await sink.send([], { subject: "ROAS low", text: "MER 1.8", url: "https://app/x" });
    expect(JSON.parse(body).text).toContain("*ROAS low*");
    expect(() => new SlackWebhookSink("https://evil.example/hook")).toThrow();
  });
  it("mock records", async () => {
    const m = new MockNotificationSink("slack");
    await m.send(["x@y.z"], { subject: "a", text: "b" });
    expect(m.sent).toHaveLength(1);
  });
});
