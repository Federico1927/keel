import { describe, expect, it } from "vitest";
import { decryptJson, decryptSecret, encryptJson, encryptSecret } from "./crypto";

process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

describe("credential encryption", () => {
  it("round-trips and never repeats ciphertext", () => {
    const a = encryptSecret("shpat_secret");
    const b = encryptSecret("shpat_secret");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("shpat_secret");
    expect(decryptJson(encryptJson({ token: "x" }))).toEqual({ token: "x" });
  });
  it("detects tampering", () => {
    const c = Buffer.from(encryptSecret("abc"), "base64");
    c[c.length - 1] = (c[c.length - 1]! + 1) & 0xff;
    expect(() => decryptSecret(c.toString("base64"))).toThrow();
  });
});
