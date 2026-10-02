import { describe, expect, it } from "vitest";
import { EmailSendError, MockEmailProvider, ResendEmailProvider, parseResendEvent, signSvixPayload, verifySvixSignature, type EmailFetch, type EmailMessage } from "./index";
import { RESEND_ERRORS, RESEND_SENT, RESEND_WEBHOOKS, SVIX_SECRET } from "./__fixtures__/resend";

const msg: EmailMessage = { from: "Keel <no-reply@keel.example>", to: "owner@northwind.demo", subject: "Hi", html: "<p>Hi</p>", text: "Hi", replyTo: "support@keel.example", tags: { template: "magic_link", tenant_id: "none" }, headers: { "List-Unsubscribe": "<https://x/u>" }, idempotencyKey: "k-1" };

/** Recorded-response fetch: captures the request, answers with one fixture. */
function recorded(res: { status: number; headers?: Record<string, string>; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl: EmailFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const h = new Map(Object.entries(res.headers ?? {}));
    return { status: res.status, headers: { get: (n) => h.get(n.toLowerCase()) ?? null }, text: async () => JSON.stringify(res.body) };
  };
  return { calls, fetchImpl };
}

describe("ResendEmailProvider", () => {
  it("posts the message with the idempotency key and returns the provider id", async () => {
    const r = recorded({ status: 200, body: RESEND_SENT });
    const p = new ResendEmailProvider({ apiKey: "re_test", fetchImpl: r.fetchImpl });
    expect(await p.send(msg)).toEqual({ id: RESEND_SENT.id });
    const call = r.calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.headers.authorization).toBe("Bearer re_test");
    expect(call.headers["idempotency-key"]).toBe("k-1");
    expect(call.body).toMatchObject({ from: msg.from, to: ["owner@northwind.demo"], subject: "Hi", html: "<p>Hi</p>", text: "Hi", reply_to: "support@keel.example", headers: { "List-Unsubscribe": "<https://x/u>" } });
    expect((call.body as { tags: unknown }).tags).toEqual([{ name: "template", value: "magic_link" }, { name: "tenant_id", value: "none" }]);
  });

  it("maps provider errors to codes that say whether to retry", async () => {
    const codes: Record<string, [string, boolean]> = { rateLimit: ["rate_limit", true], dailyQuota: ["rate_limit", true], invalidTo: ["invalid_recipient", false], domainNotVerified: ["domain_not_verified", false], invalidKey: ["auth", false], missingKey: ["auth", false], concurrent: ["transient", true], server: ["transient", true] };
    for (const [name, [code, retryable]] of Object.entries(codes)) {
      const p = new ResendEmailProvider({ apiKey: "re_test", fetchImpl: recorded(RESEND_ERRORS[name as keyof typeof RESEND_ERRORS]).fetchImpl });
      const e = await p.send(msg).catch((x: unknown) => x);
      expect(e, name).toBeInstanceOf(EmailSendError);
      expect((e as EmailSendError).code, name).toBe(code);
      expect((e as EmailSendError).retryable, name).toBe(retryable);
    }
    const rl = (await new ResendEmailProvider({ apiKey: "k", fetchImpl: recorded(RESEND_ERRORS.rateLimit).fetchImpl }).send(msg).catch((x: unknown) => x)) as EmailSendError;
    expect(rl.retryAfterMs).toBe(2000);
  });

  it("times out and maps network failures as transient", async () => {
    const hang: EmailFetch = (_u, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const e = (await new ResendEmailProvider({ apiKey: "k", fetchImpl: hang, timeoutMs: 20 }).send(msg).catch((x: unknown) => x)) as EmailSendError;
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
    const down: EmailFetch = async () => {
      throw new Error("ECONNRESET");
    };
    expect(((await new ResendEmailProvider({ apiKey: "k", fetchImpl: down }).send(msg).catch((x: unknown) => x)) as EmailSendError).code).toBe("transient");
    expect(() => new ResendEmailProvider({ apiKey: "" })).toThrow(EmailSendError);
  });
});

describe("MockEmailProvider", () => {
  it("records once per idempotency key and can fail on demand", async () => {
    const m = new MockEmailProvider();
    const a = await m.send(msg);
    expect(await m.send(msg)).toEqual(a);
    expect(m.sent).toHaveLength(1);
    m.failNext("transient");
    await expect(m.send({ ...msg, idempotencyKey: "k-2" })).rejects.toMatchObject({ code: "transient" });
    expect(m.sent).toHaveLength(1);
    m.failNext("timeout", 1, true);
    await expect(m.send({ ...msg, idempotencyKey: "k-3" })).rejects.toMatchObject({ code: "timeout" });
    expect(m.sent).toHaveLength(2);
    await m.send({ ...msg, idempotencyKey: "k-3" });
    expect(m.sent).toHaveLength(2);
    expect(m.to("OWNER@northwind.demo")).toHaveLength(2);
  });
});

describe("Resend webhooks", () => {
  const body = JSON.stringify(RESEND_WEBHOOKS.bouncedHard);
  const now = Date.parse("2026-10-01T09:00:10Z");
  const ts = Math.floor(now / 1000);
  it("verifies Svix signatures and rejects forged, stale or missing ones", () => {
    const sig = signSvixPayload("msg_2a", ts, body, SVIX_SECRET);
    const headers = { "svix-id": "msg_2a", "svix-timestamp": String(ts), "svix-signature": `v1,bm9wZQ== ${sig}` };
    expect(verifySvixSignature(headers, body, SVIX_SECRET, now)).toBe("msg_2a");
    expect(verifySvixSignature(headers, body.replace("gone", "kept"), SVIX_SECRET, now)).toBeNull();
    expect(verifySvixSignature(headers, body, "whsec_b3RoZXI=", now)).toBeNull();
    expect(verifySvixSignature(headers, body, SVIX_SECRET, now + 6 * 60_000)).toBeNull();
    expect(verifySvixSignature({ ...headers, "svix-signature": undefined }, body, SVIX_SECRET, now)).toBeNull();
  });

  it("normalizes delivery, bounce and complaint events", () => {
    expect(parseResendEvent(RESEND_WEBHOOKS.delivered)).toMatchObject({ type: "delivered", providerMessageId: RESEND_SENT.id, recipients: ["owner@northwind.demo"], bounce: null, tags: { template: "magic_link" } });
    expect(parseResendEvent(RESEND_WEBHOOKS.bouncedHard)).toMatchObject({ type: "bounced", bounce: "hard", recipients: ["gone@example.com"], tags: { template: "digest" } });
    expect(parseResendEvent(RESEND_WEBHOOKS.bouncedSoft)?.bounce).toBe("soft");
    expect(parseResendEvent(RESEND_WEBHOOKS.complained)?.type).toBe("complained");
    expect(parseResendEvent(RESEND_WEBHOOKS.opened)?.type).toBe("other");
    expect(parseResendEvent("junk")).toBeNull();
  });
});
