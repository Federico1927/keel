import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { decryptJson, decryptSecret, emailAddressHash, encryptJson, encryptSecret } from "@hullwise/integrations";
import * as schema from "../src/schema";
import { rotateEncryptionKey } from "../src/rotate-key";
import { testPools } from "../src/test-utils";
import { seedPlatform } from "../src/seed";

const pools = testPools();
const OLD = process.env.APP_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");
const NEW = Buffer.alloc(32, 9).toString("base64");
const FOREIGN = Buffer.alloc(32, 3).toString("base64");
const ORIGINAL = { current: process.env.APP_ENCRYPTION_KEY, previous: process.env.APP_ENCRYPTION_KEY_PREVIOUS };
const withKeys = (current: string, previous?: string) => {
  process.env.APP_ENCRYPTION_KEY = current;
  if (previous) process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous;
  else delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
};
let tenant = "";
let endpointId = "";
const knownEmail = "rotation-known@example.test";
const unknownEmail = "rotation-gone@example.test";

beforeAll(async () => {
  const ctx = await seedPlatform(pools.admin);
  tenant = ctx.tenantIds.harbor;
  await pools.admin.delete(schema.integrations).where(and(eq(schema.integrations.tenantId, tenant), eq(schema.integrations.provider, "rotation_test")));
  await pools.admin.delete(schema.adAccounts).where(and(eq(schema.adAccounts.tenantId, tenant), eq(schema.adAccounts.provider, "rotation_test")));
  withKeys(OLD);
  await pools.admin.insert(schema.integrations).values({ tenantId: tenant, provider: "rotation_test", status: "connected", mode: "live", credentialsEncrypted: encryptJson({ accessToken: "tok-old" }), config: { app: { clientId: "c1", secretEncrypted: encryptJson({ clientSecret: "sec-old" }) }, keep: 1 } });
  const [ep] = await pools.admin.insert(schema.webhookEndpoints).values({ tenantId: tenant, url: "https://example.test/hook", secretEnc: encryptSecret("whsec_old"), secretPrefix: "whsec_", eventTypes: ["order.created"] }).returning();
  endpointId = ep!.id;
  await pools.admin.insert(schema.users).values({ email: knownEmail, name: "Rotation" }).onConflictDoNothing();
  await pools.admin.insert(schema.emailAddressSuppressions).values([
    { emailHash: emailAddressHash(knownEmail), emailMasked: "ro•••@ex•••.test", reason: "bounce" },
    { emailHash: emailAddressHash(unknownEmail), emailMasked: "ro•••@ex•••.test", reason: "bounce" },
  ]).onConflictDoNothing();
  withKeys(FOREIGN);
  await pools.admin.insert(schema.adAccounts).values({ tenantId: tenant, provider: "rotation_test", externalAccountId: "lost", name: "Lost", credentialsEncrypted: encryptJson({ accessToken: "unrecoverable" }) });
});
afterEach(() => withKeys(OLD));
afterAll(async () => {
  // rotate back, so the files after this one find their payloads under the usual key
  withKeys(OLD, NEW);
  await rotateEncryptionKey(pools.admin);
  if (ORIGINAL.current) process.env.APP_ENCRYPTION_KEY = ORIGINAL.current;
  if (ORIGINAL.previous) process.env.APP_ENCRYPTION_KEY_PREVIOUS = ORIGINAL.previous;
  else delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
  await pools.admin.delete(schema.adAccounts).where(and(eq(schema.adAccounts.tenantId, tenant), eq(schema.adAccounts.provider, "rotation_test")));
  await pools.close();
});

const row = async () => (await pools.admin.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, tenant), eq(schema.integrations.provider, "rotation_test"))))[0]!;
const endpoint = async () => (await pools.admin.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpointId)))[0]!;
const target = (r: Awaited<ReturnType<typeof rotateEncryptionKey>>, label: string) => r.targets.find((t) => t.label === label)!;

describe("APP_ENCRYPTION_KEY rotation", () => {
  it("a dry run reports what would change and writes nothing", async () => {
    withKeys(NEW, OLD);
    const before = await row();
    const r = await rotateEncryptionKey(pools.admin, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(target(r, "integrations.credentials_encrypted").reencrypted).toBeGreaterThanOrEqual(1);
    expect(target(r, "integrations.config.app.secretEncrypted").reencrypted).toBeGreaterThanOrEqual(1);
    expect(target(r, "webhook_endpoints.secret_enc").reencrypted).toBeGreaterThanOrEqual(1);
    expect(target(r, "ad_accounts.credentials_encrypted").unreadable).toBe(1);
    expect(r.suppressionsRehashed).toBeGreaterThanOrEqual(1);
    expect((await row()).credentialsEncrypted).toBe(before.credentialsEncrypted);
  });

  it("re-encrypts every payload with the new key, keeps the rest of the jsonb, and twins known suppressions", async () => {
    withKeys(NEW, OLD);
    const r = await rotateEncryptionKey(pools.admin);
    expect(r.unreadable).toBe(1);
    withKeys(NEW);
    const after = await row();
    expect(decryptJson<{ accessToken: string }>(after.credentialsEncrypted!).accessToken).toBe("tok-old");
    const cfg = after.config as { app: { clientId: string; secretEncrypted: string }; keep: number };
    expect(decryptJson<{ clientSecret: string }>(cfg.app.secretEncrypted).clientSecret).toBe("sec-old");
    expect(cfg.app.clientId).toBe("c1");
    expect(cfg.keep).toBe(1);
    expect(decryptSecret((await endpoint()).secretEnc)).toBe("whsec_old");
    const hashes = (await pools.admin.select().from(schema.emailAddressSuppressions)).map((s) => s.emailHash);
    expect(hashes).toContain(emailAddressHash(knownEmail));
    // the unknown address has no plain text anywhere: only the old-key row exists
    expect(hashes).not.toContain(emailAddressHash(unknownEmail));
    // the unreadable payload is left untouched
    withKeys(FOREIGN);
    const [lost] = await pools.admin.select().from(schema.adAccounts).where(and(eq(schema.adAccounts.tenantId, tenant), eq(schema.adAccounts.provider, "rotation_test")));
    expect(decryptJson<{ accessToken: string }>(lost!.credentialsEncrypted!).accessToken).toBe("unrecoverable");
  });

  it("is idempotent, and without the previous key it only verifies", async () => {
    withKeys(NEW, OLD);
    const again = await rotateEncryptionKey(pools.admin);
    expect(again.targets.every((t) => t.reencrypted === 0)).toBe(true);
    expect(again.suppressionsRehashed).toBe(0);
    withKeys(NEW);
    const verify = await rotateEncryptionKey(pools.admin);
    expect(verify.previousKeySet).toBe(false);
    expect(verify.unreadable).toBe(1);
    expect(target(verify, "integrations.credentials_encrypted").current).toBe(target(verify, "integrations.credentials_encrypted").total);
  });

  it("refuses the same key twice", async () => {
    withKeys(NEW, NEW);
    await expect(rotateEncryptionKey(pools.admin, { dryRun: true })).rejects.toThrow(/equals/);
  });
});
