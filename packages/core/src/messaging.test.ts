import { describe, expect, it } from "vitest";
import { customFieldsFor, isInServiceWindow, isOptOutErrorCode, messageTemplateVariables, missingTemplateVariables, nextMessageStatus, normalizeReply, orderMessageEventFor, renderMessageTemplate, replyMatches } from "./messaging";

describe("message status precedence", () => {
  it("only moves forward: sent < failed < delivered < read < replied", () => {
    expect(nextMessageStatus("queued", "sent")).toBe("sent");
    expect(nextMessageStatus("sent", "delivered")).toBe("delivered");
    expect(nextMessageStatus("delivered", "read")).toBe("read");
    expect(nextMessageStatus("read", "replied")).toBe("replied");
    // late or repeated updates are ignored
    expect(nextMessageStatus("read", "sent")).toBeNull();
    expect(nextMessageStatus("read", "delivered")).toBeNull();
    expect(nextMessageStatus("delivered", "delivered")).toBeNull();
    // a failure after a delivery is ignored; a delivery after a failure wins (the provider retried)
    expect(nextMessageStatus("delivered", "failed")).toBeNull();
    expect(nextMessageStatus("failed", "delivered")).toBe("delivered");
    expect(nextMessageStatus("sent", "failed")).toBe("failed");
    // inbound messages never change
    expect(nextMessageStatus("received", "read")).toBeNull();
    expect(nextMessageStatus("sent", "received")).toBeNull();
  });
});

describe("template variables", () => {
  it("fills internal and provider placeholders case-insensitively and tidies the gaps", () => {
    expect(renderMessageTemplate("Hi {{first_name}}, order {{ order_name }} is on its way: %%TRACKING_URL%% {{unknown}}.", { first_name: "Ana", order_name: "#1001", tracking_url: "https://t.example/1" })).toBe("Hi Ana, order #1001 is on its way: https://t.example/1.");
    expect(renderMessageTemplate("Hello {{FIRST_NAME}} !", { first_name: "" })).toBe("Hello!");
    expect(messageTemplateVariables("{{a}} %%B%% {{a}} %%b%%")).toEqual(["a", "b"]);
    expect(missingTemplateVariables("{{first_name}} {{tracking_url}} {{total}}", { first_name: "Ana", tracking_url: "", total: null })).toEqual(["tracking_url", "total"]);
  });
  it("maps variables to provider custom fields, upper case by default", () => {
    expect(customFieldsFor({ first_name: "Ana", order_name: "#1", total: null })).toEqual({ FIRST_NAME: "Ana", ORDER_NAME: "#1", TOTAL: "" });
    expect(customFieldsFor({ first_name: "Ana", order_name: "#1" }, { NOME: "first_name", ORDINE: "order_name", X: "missing" })).toEqual({ NOME: "Ana", ORDINE: "#1", X: "" });
  });
});

describe("reply keywords", () => {
  it("normalises accents, case and punctuation", () => {
    expect(normalizeReply("  Sì!!  ")).toBe("si");
    expect(normalizeReply("CONFIRMO, grazie.")).toBe("confirmo grazie");
    expect(normalizeReply(null)).toBe("");
  });
  it("matches the whole reply or the first words of a short reply, never a word inside a long message", () => {
    expect(replyMatches("Yes please", ["yes"])).toBe(true);
    expect(replyMatches("YES", ["yes", "confirm"])).toBe(true);
    expect(replyMatches("Sì", ["si"])).toBe(true);
    expect(replyMatches("stop", ["STOP", "unsubscribe"])).toBe(true);
    expect(replyMatches("not now", ["no"])).toBe(false);
    expect(replyMatches("I would like to know if there is no way to change the address", ["no"])).toBe(false);
    expect(replyMatches("cancel the order", ["cancel order", "cancel"])).toBe(true);
    expect(replyMatches("", ["yes"])).toBe(false);
    expect(replyMatches("yes", ["", "  "])).toBe(false);
  });
});

describe("service window and order events", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  it("allows free-form messages only within 24 hours of the last inbound message", () => {
    expect(isInServiceWindow(new Date(now.getTime() - 23 * 3600e3), now)).toBe(true);
    expect(isInServiceWindow(new Date(now.getTime() - 25 * 3600e3), now)).toBe(false);
    expect(isInServiceWindow(null, now)).toBe(false);
    expect(isInServiceWindow(new Date(now.getTime() + 60e3), now)).toBe(false);
  });
  it("notifies forward moves to confirmed, shipped and delivered only", () => {
    expect(orderMessageEventFor("pending_review", "confirmed")).toBe("order_confirmed");
    expect(orderMessageEventFor("on_hold", "confirmed")).toBe("order_confirmed");
    expect(orderMessageEventFor("fulfilling", "shipped")).toBe("order_shipped");
    expect(orderMessageEventFor("shipped", "delivered")).toBe("order_delivered");
    expect(orderMessageEventFor(null, "shipped")).toBe("order_shipped");
    expect(orderMessageEventFor("delivered", "shipped")).toBeNull();
    expect(orderMessageEventFor("shipped", "shipped")).toBeNull();
    expect(orderMessageEventFor("confirmed", "cancelled")).toBeNull();
    expect(orderMessageEventFor("confirmed", "fulfilling")).toBeNull();
  });
  it("recognises the provider's stopped-marketing error", () => {
    expect(isOptOutErrorCode("whatsapp::131050")).toBe(true);
    expect(isOptOutErrorCode("whatsapp::131026")).toBe(false);
    expect(isOptOutErrorCode(null)).toBe(false);
  });
});
