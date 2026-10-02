import { beforeAll, describe, expect, it } from "vitest";
import { createSignInGrant, verifySignInGrant } from "./sign-in-grant";

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-secret";
});

describe("sign-in grant", () => {
  it("verifies its own grants until they expire, refuses tampered ones", () => {
    const now = Date.now();
    const g = createSignInGrant("u1", 3, now);
    expect(verifySignInGrant(g, now)).toEqual({ userId: "u1", sessionVersion: 3 });
    expect(verifySignInGrant(g, now + 61_000)).toBeNull();
    expect(verifySignInGrant(g.replace("u1.3", "u2.3"), now)).toBeNull();
    expect(verifySignInGrant(g.replace(".3.", ".4."), now)).toBeNull();
    expect(verifySignInGrant("garbage", now)).toBeNull();
    expect(verifySignInGrant(null, now)).toBeNull();
  });
});
