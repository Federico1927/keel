import { describe, expect, it } from "vitest";
import { decryptJson, decryptSecret, emailAddressHash, encryptJson, encryptSecret, maskEmail } from "./crypto";

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
  it("hashes addresses after normalizing and masks them for display", () => {
    expect(emailAddressHash(" Owner@Northwind.demo ")).toBe(emailAddressHash("owner@northwind.demo"));
    expect(emailAddressHash("owner@northwind.demo")).toMatch(/^[0-9a-f]{64}$/);
    expect(emailAddressHash("a@b.c")).not.toBe(emailAddressHash("a@b.d"));
    expect(maskEmail("Owner@Northwind.demo")).toBe("ow•••@no•••.demo");
    expect(maskEmail("a@x.io")).toBe("a•••@x•••.io");
    expect(maskEmail("nope")).toBe("•••");
  });
});
