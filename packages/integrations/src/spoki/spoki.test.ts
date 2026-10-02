import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../http";
import { IntegrationError } from "../types";
import { MockSpokiChannel, SPOKI_API_BASE, SpokiChannel, mapSpokiTemplate, parseSpokiWebhook, spokiErrorCode, spokiEventKey, spokiPhone } from "./index";
import { CONTACTS_EMPTY, CONTACTS_ONE, SEND_CREDIT, SEND_NO_ID, SEND_OK, TEMPLATES_PAGE_1, TEMPLATES_PAGE_2, WEBHOOK_DELIVERED, WEBHOOK_ERROR, WEBHOOK_INBOUND_BUTTON, WEBHOOK_INBOUND_MEDIA, WEBHOOK_INBOUND_STOP, WEBHOOK_PENDING, WEBHOOK_READ, WEBHOOK_SENT } from "./__fixtures__/spoki";

type Routes = Parameters<typeof fixtureFetch>[0];
const calls: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] = [];
const make = (routes: Routes) => {
  calls.length = 0;
  const f = fixtureFetch(routes);
  return new SpokiChannel({ apiKey: "spk-test-key" }, { sleep: async () => undefined, minIntervalMs: 0, fetchImpl: async (url, init) => { calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body }); return f(url, init); } });
};

describe("SpokiChannel sends", () => {
  it("sends a template with custom fields and the key in the header", async () => {
    const s = make([{ match: (u, i) => u === `${SPOKI_API_BASE}/messages/send/` && i?.method === "POST", body: SEND_OK }]);
    const r = await s.sendMessage({ to: "+393331234567", template: "7001", variables: { FIRST_NAME: "Ana", ORDER_NAME: "#1001" } });
    expect(r.messageId).toBe(SEND_OK.uuid);
    expect(calls[0]!.headers!["x-spoki-api-key"]).toBe("spk-test-key");
    expect(calls[0]!.url).not.toContain("spk-test-key");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: "Template", phone: "+393331234567", template: 7001, custom_fields: { FIRST_NAME: "Ana", ORDER_NAME: "#1001" } });
  });
  it("sends free text (Message + content_type Text) when the template is not a Spoki id", async () => {
    const s = make([{ match: (u) => u.endsWith("/messages/send/"), body: SEND_OK }]);
    await s.sendMessage({ to: "+393331234567", template: "conferma", variables: { body: "Confermi l'ordine?" } });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: "Message", content_type: "Text", phone: "+393331234567", text: "Confermi l'ordine?" });
  });
  it("refuses an answer without a message id and maps credit exhaustion to a non-retryable error", async () => {
    await expect(make([{ match: () => true, body: SEND_NO_ID }]).sendText("+393331234567", "hi")).rejects.toMatchObject({ code: "invalid_request" });
    const err = await make([{ match: () => true, status: 402, body: SEND_CREDIT }]).sendText("+393331234567", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).code).toBe("permission");
    expect(spokiErrorCode(err)).toBe("spoki::1029");
  });
  it("retries a rate limit with Retry-After, then succeeds", async () => {
    let n = 0;
    const s = make([{ match: () => true, status: 200, body: () => SEND_OK }]);
    const flaky = new SpokiChannel({ apiKey: "k" }, { sleep: async () => undefined, minIntervalMs: 0, fetchImpl: async (url, init) => (n++ === 0 ? { status: 429, headers: { get: (h: string) => (h === "retry-after" ? "1" : null) }, text: async () => "slow down" } : fixtureFetch([{ match: () => true, body: SEND_OK }])(url, init)) });
    expect((await flaky.sendText("+393331234567", "hi")).messageId).toBe(SEND_OK.uuid);
    expect(n).toBe(2);
    expect(s.provider).toBe("spoki");
  });
});

describe("SpokiChannel account data", () => {
  it("lists approved and other templates across pages, with their fields", async () => {
    const s = make([
      { match: (u) => u === `${SPOKI_API_BASE}/templates/?page_size=100`, body: TEMPLATES_PAGE_1 },
      { match: (u) => u.includes("page=2"), body: TEMPLATES_PAGE_2 },
    ]);
    const t = await s.listTemplates();
    expect(t.map((x) => [x.id, x.name, x.status, x.language])).toEqual([["7001", "order_shipped", "approved", "en"], ["7002", "cod_confirm", "approved", "it"], ["7003", "promo_draft", "rejected", "en"]]);
    expect(t[0]!.fields).toEqual(["FIRST_NAME", "ORDER_NAME", "TRACKING_URL"]);
    expect(mapSpokiTemplate({ id: 1, status: 1 })).toMatchObject({ status: "pending", fields: [] });
  });
  it("finds a contact by digits, then with the plus, and upserts", async () => {
    const s = make([
      { match: (u) => u.endsWith("/contacts/?phone=393331234567"), body: CONTACTS_EMPTY },
      { match: (u) => u.endsWith("/contacts/?phone=%2B393331234567"), body: CONTACTS_ONE },
      { match: (u, i) => u.endsWith("/contacts/4455/") && i?.method === "PATCH", body: { id: 4455, chat_link: "https://app.spoki.it/chats/abc" } },
    ]);
    expect(await s.findContact("+39 333 1234567")).toEqual({ id: "4455", phone: "+393331234567", chatLink: "https://app.spoki.it/chats/abc", subscribed: true });
    const c = await s.upsertContact({ phone: "+393331234567", firstName: "Ana", customFields: { CITY: "Milano" } });
    expect(c.id).toBe("4455");
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ phone: "+393331234567", first_name: "Ana", custom_fields: { CITY: "Milano" } });
  });
  it("tests the connection with one template page and reports errors readably", async () => {
    expect(await make([{ match: () => true, body: { count: 12, results: [] } }]).testConnection()).toEqual({ ok: true, accountName: "Spoki (12 templates)" });
    const bad = await make([{ match: () => true, status: 401, body: { detail: "Invalid API key" } }]).testConnection();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("401");
  });
});

describe("webhook mapping", () => {
  it("normalises status receipts with every phone fallback", () => {
    expect(parseSpokiWebhook(WEBHOOK_SENT)).toMatchObject({ kind: "status", messageId: SEND_OK.uuid, status: "sent", phone: "+393331234567", templateId: null, contactId: "4455" });
    expect(parseSpokiWebhook(WEBHOOK_DELIVERED)).toMatchObject({ kind: "status", status: "delivered", templateId: "7001", phone: "+393331234567" });
    expect(parseSpokiWebhook(WEBHOOK_READ)).toMatchObject({ kind: "status", status: "read", phone: "+393331234567" });
    expect(parseSpokiWebhook(WEBHOOK_ERROR)).toMatchObject({ kind: "status", status: "failed", errorCode: "whatsapp::131050", phone: "+393339876543" });
    expect(parseSpokiWebhook(WEBHOOK_PENDING)).toBeNull();
    expect(parseSpokiWebhook({ event: "message.outbound", data: {} })).toBeNull();
    expect(parseSpokiWebhook("nope")).toBeNull();
  });
  it("normalises inbound messages, button replies and media", () => {
    expect(parseSpokiWebhook(WEBHOOK_INBOUND_BUTTON)).toMatchObject({ kind: "inbound", messageId: "in-001", phone: "+393331234567", text: "Yes, confirm", replyToMessageId: SEND_OK.uuid, hasMedia: false });
    expect(parseSpokiWebhook(WEBHOOK_INBOUND_MEDIA)).toMatchObject({ kind: "inbound", phone: "+447700900123", text: "", hasMedia: true });
    expect(parseSpokiWebhook(WEBHOOK_INBOUND_STOP)).toMatchObject({ kind: "inbound", text: "STOP", phone: "+393339876543" });
  });
  it("keys events per message and status, so a replay is a duplicate and a new status is not", () => {
    const sent = spokiEventKey(parseSpokiWebhook(WEBHOOK_SENT)!);
    const delivered = spokiEventKey(parseSpokiWebhook(WEBHOOK_DELIVERED)!);
    expect(sent).toEqual({ topic: "message.status", externalId: SEND_OK.uuid, sourceUpdatedAt: "sent" });
    expect(delivered.externalId).toBe(sent.externalId);
    expect(delivered.sourceUpdatedAt).not.toBe(sent.sourceUpdatedAt);
    expect(spokiEventKey(parseSpokiWebhook(WEBHOOK_INBOUND_STOP)!)).toEqual({ topic: "message.inbound", externalId: "in-003", sourceUpdatedAt: "" });
  });
  it("cleans phones", () => {
    expect(spokiPhone("393331234567@c.us")).toBe("+393331234567");
    expect(spokiPhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(spokiPhone("123")).toBeNull();
  });
});

describe("MockSpokiChannel", () => {
  it("answers a repeated idempotency key with the first id and builds bodies the mapper reads", async () => {
    const m = new MockSpokiChannel();
    const a = await m.sendMessage({ to: "+393331234567", template: "40101", variables: { FIRST_NAME: "Ana" }, idempotencyKey: "k1" });
    const b = await m.sendMessage({ to: "+393331234567", template: "40101", variables: { FIRST_NAME: "Ana" }, idempotencyKey: "k1" });
    expect(b.messageId).toBe(a.messageId);
    expect(m.sent).toHaveLength(1);
    await expect(m.sendMessage({ to: "+393331234567", template: "40106", variables: {} })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(m.sendText("12", "hi")).rejects.toThrow(/131026/);
    expect(parseSpokiWebhook(MockSpokiChannel.statusBody(a.messageId, "read", { phone: "+393331234567" }))).toMatchObject({ kind: "status", messageId: a.messageId, status: "read", phone: "+393331234567" });
    expect(parseSpokiWebhook(MockSpokiChannel.statusBody(a.messageId, "failed", { errorCode: "whatsapp::131026" }))).toMatchObject({ status: "failed", errorCode: "whatsapp::131026" });
    expect(parseSpokiWebhook(MockSpokiChannel.inboundBody("+393331234567", "YES", { replyTo: a.messageId }))).toMatchObject({ kind: "inbound", text: "YES", replyToMessageId: a.messageId, phone: "+393331234567" });
    m.failures.failNext("rate_limited");
    await expect(m.sendText("+393331234567", "x")).rejects.toMatchObject({ code: "rate_limited" });
  });
});
