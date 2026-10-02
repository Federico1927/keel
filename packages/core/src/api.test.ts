import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEBHOOK_RETRY_SCHEDULE_SECONDS } from "@hullwise/config";
import { WEBHOOK_MAX_ATTEMPTS, apiPiiMode, checkWebhookUrl, classifyIp, decodeCursor, encodeCursor, formatWebhookSignature, isAllowedWebhookAddress, pageOf, parseApiLimit, parseApiScopes, parseWebhookSignature, verifyWebhookSignature, webhookRetryDelaySeconds, webhookSignedContent } from "./api";

const strict = { allowLoopback: false };
const test = { allowLoopback: true };

describe("cursors", () => {
  it("round-trips the sort values of a list and is URL-safe", () => {
    const c = encodeCursor("orders", ["2026-10-01T10:00:00.000Z", 1042, null]);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor("orders", c, 3)).toEqual(["2026-10-01T10:00:00.000Z", 1042, null]);
  });
  it("refuses a cursor of another list, of another arity, tampered or oversized", () => {
    const c = encodeCursor("orders", ["x", "y"]);
    expect(decodeCursor("customers", c, 2)).toBeNull();
    expect(decodeCursor("orders", c, 3)).toBeNull();
    expect(decodeCursor("orders", `${c}!`, 2)).toBeNull();
    expect(decodeCursor("orders", "bm90LWpzb24", 2)).toBeNull();
    expect(decodeCursor("orders", Buffer.from(JSON.stringify({ v: 1, l: "orders", k: [{}, "a"] })).toString("base64url"), 2)).toBeNull();
    expect(decodeCursor("orders", "a".repeat(600), 2)).toBeNull();
    expect(decodeCursor("orders", null, 2)).toBeNull();
  });
  it("pages from limit + 1 rows", () => {
    const p = pageOf([1, 2, 3], 2, (n) => `c${n}`);
    expect(p).toEqual({ data: [1, 2], hasMore: true, nextCursor: "c2" });
    expect(pageOf([1], 2, (n) => `c${n}`)).toEqual({ data: [1], hasMore: false, nextCursor: null });
  });
  it("limit: default, cap at 100, refuse junk", () => {
    expect(parseApiLimit(null)).toBe(25);
    expect(parseApiLimit("10")).toBe(10);
    expect(parseApiLimit("500")).toBe(100);
    expect(parseApiLimit("0")).toBeNull();
    expect(parseApiLimit("-3")).toBeNull();
    expect(parseApiLimit("ten")).toBeNull();
  });
});

describe("scopes and PII", () => {
  it("keeps only API scopes, nothing implied", () => {
    expect(parseApiScopes(["read", "write:notes", "orders:read", "bogus", "inventory:write"])).toEqual(["orders:read", "inventory:write"]);
    expect(parseApiScopes("orders:write customers:read")).toEqual(["orders:write", "customers:read"]);
    expect(parseApiScopes(null)).toEqual([]);
  });
  it("full PII needs the scope, a PII role and the tenant switch", () => {
    expect(apiPiiMode(["orders:read", "pii:read"], true, true)).toBe("full");
    expect(apiPiiMode(["orders:read"], true, true)).toBe("masked");
    expect(apiPiiMode(["pii:read"], false, true)).toBe("masked");
    expect(apiPiiMode(["pii:read"], true, false)).toBe("masked");
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const hmac = (k: string) => (content: string) => createHmac("sha256", k).update(content).digest("hex");
  const body = JSON.stringify({ id: "evt", type: "order.created" });
  const now = new Date("2026-10-02T12:00:00Z");
  const ts = Math.floor(now.getTime() / 1000);

  it("signs <timestamp>.<body> and verifies it", () => {
    expect(webhookSignedContent(ts, body)).toBe(`${ts}.${body}`);
    const header = formatWebhookSignature(ts, [hmac(secret)(`${ts}.${body}`)]);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ header, body, now, hmacHex: hmac(secret) })).toEqual({ ok: true });
  });
  it("accepts either secret during a rotation", () => {
    const header = formatWebhookSignature(ts, [hmac("new")(`${ts}.${body}`), hmac("old")(`${ts}.${body}`)]);
    expect(parseWebhookSignature(header)?.signatures).toHaveLength(2);
    expect(verifyWebhookSignature({ header, body, now, hmacHex: hmac("old") }).ok).toBe(true);
    expect(verifyWebhookSignature({ header, body, now, hmacHex: hmac("new") }).ok).toBe(true);
  });
  it("rejects a changed body, a wrong secret, a stale timestamp and junk", () => {
    const header = formatWebhookSignature(ts, [hmac(secret)(`${ts}.${body}`)]);
    expect(verifyWebhookSignature({ header, body: `${body} `, now, hmacHex: hmac(secret) })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature({ header, body, now, hmacHex: hmac("other") })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhookSignature({ header, body, now: new Date(now.getTime() + 301_000), hmacHex: hmac(secret) })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhookSignature({ header: "v1=abc", body, now, hmacHex: hmac(secret) })).toEqual({ ok: false, reason: "malformed" });
    expect(parseWebhookSignature(null)).toBeNull();
  });
});

describe("retry schedule", () => {
  it("10 s → 30 s → 2 min → 10 min → 30 min → 1 h → 2 h, then dead", () => {
    expect(WEBHOOK_RETRY_SCHEDULE_SECONDS[0]).toBe(10);
    expect(WEBHOOK_RETRY_SCHEDULE_SECONDS.at(-1)).toBe(7200);
    expect([1, 2, 3, 4, 5, 6, 7].map(webhookRetryDelaySeconds)).toEqual([10, 30, 120, 600, 1800, 3600, 7200]);
    expect(webhookRetryDelaySeconds(8)).toBeNull();
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
    for (let i = 1; i < 7; i++) expect(webhookRetryDelaySeconds(i + 1)!).toBeGreaterThan(webhookRetryDelaySeconds(i)!);
  });
});

describe("webhook URL guard", () => {
  it("classifies addresses", () => {
    expect(classifyIp("8.8.8.8")).toBe("public");
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.32.0.1")).toBe("public");
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("100.64.0.1")).toBe("private");
    expect(classifyIp("169.254.169.254")).toBe("link_local");
    expect(classifyIp("0.0.0.0")).toBe("reserved");
    expect(classifyIp("224.0.0.1")).toBe("reserved");
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("::")).toBe("reserved");
    expect(classifyIp("fd00:ec2::254")).toBe("private");
    expect(classifyIp("fe80::1")).toBe("link_local");
    expect(classifyIp("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIp("::ffff:169.254.169.254")).toBe("link_local");
    expect(classifyIp("::ffff:7f00:1")).toBe("loopback");
    expect(classifyIp("64:ff9b::a9fe:a9fe")).toBe("link_local");
    expect(classifyIp("2606:4700:4700::1111")).toBe("public");
    expect(classifyIp("999.1.1.1")).toBe("invalid");
    expect(classifyIp("not-an-ip")).toBe("invalid");
  });
  it("loopback only with the test policy, private never", () => {
    expect(isAllowedWebhookAddress("127.0.0.1", strict)).toBe(false);
    expect(isAllowedWebhookAddress("127.0.0.1", test)).toBe(true);
    expect(isAllowedWebhookAddress("10.0.0.1", test)).toBe(false);
    expect(isAllowedWebhookAddress("169.254.169.254", test)).toBe(false);
  });
  it("https only, no credentials or fragments, no internal names or private literals", () => {
    expect(checkWebhookUrl("https://hooks.example.com/in?x=1", strict).ok).toBe(true);
    expect(checkWebhookUrl("http://hooks.example.com/in", strict)).toEqual({ ok: false, problem: "scheme" });
    expect(checkWebhookUrl("ftp://hooks.example.com", strict)).toEqual({ ok: false, problem: "scheme" });
    expect(checkWebhookUrl("https://user:pw@hooks.example.com", strict)).toEqual({ ok: false, problem: "credentials" });
    expect(checkWebhookUrl("https://hooks.example.com/#x", strict)).toEqual({ ok: false, problem: "fragment" });
    expect(checkWebhookUrl("https://169.254.169.254/latest/meta-data", strict)).toEqual({ ok: false, problem: "private_address" });
    expect(checkWebhookUrl("https://[::1]/x", strict)).toEqual({ ok: false, problem: "private_address" });
    expect(checkWebhookUrl("https://10.0.0.5/x", strict)).toEqual({ ok: false, problem: "private_address" });
    expect(checkWebhookUrl("https://localhost/x", strict)).toEqual({ ok: false, problem: "private_address" });
    expect(checkWebhookUrl("https://metadata.google.internal/x", strict)).toEqual({ ok: false, problem: "host" });
    expect(checkWebhookUrl("https://intranet/x", strict)).toEqual({ ok: false, problem: "host" });
    expect(checkWebhookUrl("not a url", strict)).toEqual({ ok: false, problem: "invalid_url" });
  });
  it("the test policy allows http to loopback, and nothing else", () => {
    expect(checkWebhookUrl("http://127.0.0.1:4555/hook", test).ok).toBe(true);
    expect(checkWebhookUrl("http://localhost:4555/hook", test).ok).toBe(true);
    expect(checkWebhookUrl("http://hooks.example.com/in", test)).toEqual({ ok: false, problem: "scheme" });
    expect(checkWebhookUrl("http://10.0.0.5/in", test)).toEqual({ ok: false, problem: "scheme" });
  });
});
