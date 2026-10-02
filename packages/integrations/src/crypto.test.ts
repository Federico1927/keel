import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptJson, decryptSecret, emailAddressHash, emailAddressHashes, encryptJson, encryptSecret, encryptionKeyOf, encryptionKeyStrings, hasPreviousEncryptionKey, maskEmail, reencryptSecret, signState, verifyState } from "./crypto";

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

describe("encryption key rotation", () => {
  const OLD = Buffer.alloc(32, 7).toString("base64");
  const NEW = Buffer.alloc(32, 9).toString("base64");
  const OTHER = Buffer.alloc(32, 3).toString("base64");
  const withKeys = (current: string, previous?: string) => {
    process.env.APP_ENCRYPTION_KEY = current;
    if (previous) process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous;
    else delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
  };
  beforeEach(() => withKeys(OLD));
  afterEach(() => withKeys(OLD));

  it("decrypts old payloads with APP_ENCRYPTION_KEY_PREVIOUS and new ones with the current key", () => {
    const old = encryptJson({ token: "shpat_old" });
    withKeys(NEW);
    expect(() => decryptJson(old)).toThrow();
    expect(encryptionKeyOf(old)).toBeNull();
    withKeys(NEW, OLD);
    expect(hasPreviousEncryptionKey()).toBe(true);
    expect(decryptJson(old)).toEqual({ token: "shpat_old" });
    expect(encryptionKeyOf(old)).toBe("previous");
    const fresh = encryptSecret("new");
    expect(encryptionKeyOf(fresh)).toBe("current");
    withKeys(NEW);
    expect(decryptSecret(fresh)).toBe("new");
  });

  it("re-encrypts only what the previous key opens, so a second pass changes nothing", () => {
    const old = encryptSecret("whsec_1");
    withKeys(NEW, OLD);
    const first = reencryptSecret(old);
    expect(first.changed).toBe(true);
    expect(encryptionKeyOf(first.payload)).toBe("current");
    const second = reencryptSecret(first.payload);
    expect(second).toEqual({ payload: first.payload, changed: false });
    withKeys(NEW);
    expect(decryptSecret(first.payload)).toBe("whsec_1");
  });

  it("refuses a payload neither key opens", () => {
    withKeys(OTHER);
    const foreign = encryptSecret("x");
    withKeys(NEW, OLD);
    expect(encryptionKeyOf(foreign)).toBeNull();
    expect(() => reencryptSecret(foreign)).toThrow(/neither/);
  });

  it("matches an address under both keys during the rotation window", () => {
    const oldHash = emailAddressHash("a@b.co");
    withKeys(NEW, OLD);
    const [current, previous] = emailAddressHashes("A@b.co ");
    expect(previous).toBe(oldHash);
    expect(current).not.toBe(oldHash);
    withKeys(NEW);
    expect(emailAddressHashes("a@b.co")).toEqual([current]);
  });

  it("verifies a signed state from before the switch while the previous key is set", () => {
    const token = signState({ tenant: "t1" }, 600);
    withKeys(NEW);
    expect(verifyState(token)).toBeNull();
    withKeys(NEW, OLD);
    expect(verifyState<{ tenant: string }>(token)?.tenant).toBe("t1");
  });

  it("lists the key strings that may verify a keyed token", () => {
    withKeys(NEW, OLD);
    expect(encryptionKeyStrings()).toEqual([NEW, OLD]);
    withKeys(NEW, NEW);
    expect(encryptionKeyStrings()).toEqual([NEW]);
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
    expect(encryptionKeyStrings("dev")).toEqual(["dev"]);
  });
});
