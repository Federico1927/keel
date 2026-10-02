import { afterEach, describe, expect, it } from "vitest";
import { codMessagingToken, verifyCodMessagingToken } from "./cod-webhook";
import { spokiWebhookToken, verifySpokiWebhookToken } from "./spoki-webhook";

const OLD = Buffer.alloc(32, 7).toString("base64");
const NEW = Buffer.alloc(32, 9).toString("base64");
const TENANT = "00000000-0000-4000-8000-000000000001";
const setKeys = (current: string, previous?: string) => {
  process.env.APP_ENCRYPTION_KEY = current;
  if (previous) process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous;
  else delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
};
afterEach(() => setKeys(OLD));

describe.each([
  ["Spoki", spokiWebhookToken, verifySpokiWebhookToken],
  ["COD messaging", codMessagingToken, verifyCodMessagingToken],
] as const)("%s webhook URL token across an APP_ENCRYPTION_KEY rotation", (_name, token, verify) => {
  it("the old URL works while APP_ENCRYPTION_KEY_PREVIOUS is set, the new one from then on", () => {
    setKeys(OLD);
    const old = token(TENANT);
    expect(verify(TENANT, old)).toBe(true);
    setKeys(NEW, OLD);
    const fresh = token(TENANT);
    expect(fresh).not.toBe(old);
    expect(verify(TENANT, old)).toBe(true);
    expect(verify(TENANT, fresh)).toBe(true);
    expect(verify("00000000-0000-4000-8000-000000000002", old)).toBe(false);
    setKeys(NEW);
    expect(verify(TENANT, old)).toBe(false);
    expect(verify(TENANT, fresh)).toBe(true);
  });
});
