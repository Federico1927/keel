import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { audienceMatchKeys, normalizeMatchEmail } from "./audience";
import { MockAudienceDestination } from "./mock/audience";

const m = { customerId: "c1", email: "  Ada.Lovelace@Example.COM ", phoneE164: "+393491234567", firstName: "Ada", lastName: "Lovelace", country: "IT" };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

describe("audience match keys", () => {
  it("hashes normalised identifiers for ad platforms and never sends them in clear", () => {
    const meta = audienceMatchKeys("meta_custom_audience", m)!;
    expect(meta.keys.email_sha256).toBe(sha("ada.lovelace@example.com"));
    expect(meta.keys.phone_sha256).toBe(sha("393491234567"));
    expect(JSON.stringify(meta)).not.toContain("example.com");
    const google = audienceMatchKeys("google_customer_match", m)!;
    expect(google.keys.phone_sha256).toBe(sha("+393491234567"));
  });
  it("sends plain profile fields to email tools, and skips customers with nothing to match", () => {
    expect(audienceMatchKeys("email_tool", m)!.keys).toEqual({ email: "ada.lovelace@example.com", first_name: "Ada", last_name: "Lovelace", country: "IT" });
    expect(audienceMatchKeys("email_tool", { ...m, email: null })).toBeNull();
    expect(audienceMatchKeys("meta_custom_audience", { ...m, email: "not-an-email", phoneE164: null })).toBeNull();
    expect(normalizeMatchEmail("x@y")).toBeNull();
  });
});

describe("MockAudienceDestination", () => {
  it("creates, fills and empties an audience, and can fail on demand", async () => {
    const d = new MockAudienceDestination("meta_custom_audience");
    const { audienceId } = await d.ensureAudience("VIP", null);
    expect((await d.ensureAudience("VIP", audienceId)).audienceId).toBe(audienceId);
    const k = audienceMatchKeys("meta_custom_audience", m)!;
    await d.addMembers(audienceId, [k]);
    expect(d.audiences.get(audienceId)!.members.size).toBe(1);
    expect((await d.removeMembers(audienceId, [k])).removed).toBe(1);
    d.failures.failNext("rate_limited");
    await expect(d.addMembers(audienceId, [k])).rejects.toThrow(/rate limit/);
  });
});
