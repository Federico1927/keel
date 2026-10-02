import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { and, desc, eq, like, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedPlatform, type SeedContext } from "@keel/db/seed";
import {
  type AccountError,
  changePassword,
  confirmEmailChange,
  drainEmailJobs,
  mockEmailOutbox,
  getAccountProfile,
  getBrandLogo,
  getTenantBranding,
  listRecentSignIns,
  pendingEmailChange,
  recordSignIn,
  requestEmailChange,
  saveBrandColor,
  saveBrandLogo,
  setAvatar,
  signOutOtherSessions,
  updatePreferences,
  updateProfile,
  type AccountContext,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let userId = "";
let otherId = "";
const ac = (over: Partial<AccountContext> = {}): AccountContext => ({ db: pools.admin, userId, ...over });
const audits = (action: string, who = userId) => pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.actorUserId, who), eq(schema.auditLogs.action, action)));
const confirmUrl = (t: string) => `http://x/account/confirm-email?token=${t}`;
/** Token from the confirmation email the mock captured for an address (the links never reach the log). */
const tokenSentTo = async (address: string) => {
  await drainEmailJobs(pools.admin);
  const mail = mockEmailOutbox().to(address).at(-1)!;
  return new URL(/http:\/\/x\/account\/confirm-email\?token=[\w-]+/.exec(mail.message.text)![0]).searchParams.get("token")!;
};

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  // a throwaway user per run so the demo users keep their password and email
  const email = `profile-${Date.now()}@test.local`;
  const [u] = await pools.admin.insert(schema.users).values({ email, name: "Test Person", passwordHash: await bcrypt.hash("Old-password-2026", 4) }).returning({ id: schema.users.id });
  userId = u!.id;
  otherId = ctx.userIds["owner@northwind.demo"]!;
});
afterAll(async () => {
  await pools.admin.delete(schema.users).where(eq(schema.users.id, userId));
  await pools.close();
});

describe("account profile", () => {
  it("updates identity and preferences on the acting user only, with an audit diff", async () => {
    const before = await getAccountProfile(pools.admin, otherId);
    const p = await updateProfile(ac(), { name: "Test Person", preferredName: "Tess", jobTitle: "Ops lead" });
    expect(p.preferredName).toBe("Tess");
    const { profile, changed } = await updatePreferences(ac(), { locale: "it", theme: "dark", density: "compact", timeZone: "America/New_York" });
    expect(profile).toMatchObject({ locale: "it", theme: "dark", density: "compact", timeZone: "America/New_York" });
    expect(changed.sort()).toEqual(["density", "locale", "theme", "timeZone"]);
    const [row] = await audits("profile.preferences_updated");
    expect(row!.tenantId).toBeNull();
    expect(row!.diff).toMatchObject({ theme: { from: "system", to: "dark" } });
    expect(await getAccountProfile(pools.admin, otherId)).toEqual(before);
  });

  it("rejects an empty name and an unknown time zone", async () => {
    await expect(updateProfile(ac(), { name: "  ", preferredName: null, jobTitle: null })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(updatePreferences(ac(), { locale: null, theme: "system", density: "comfortable", timeZone: "Mars/Base" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stores and removes the photo without logging its bytes", async () => {
    await setAvatar(ac(), { data: Buffer.from("img"), contentType: "image/webp" });
    expect((await getAccountProfile(pools.admin, userId))!.hasAvatar).toBe(true);
    await setAvatar(ac(), null);
    expect((await getAccountProfile(pools.admin, userId))!.hasAvatar).toBe(false);
    const [row] = await audits("profile.avatar_updated");
    expect(JSON.stringify(row!.diff)).not.toContain("img");
  });
});

describe("account security", () => {
  it("changes the password only with the current one and a strong new one, ending other sessions", async () => {
    await expect(changePassword(ac(), "wrong", "Brand-new-Pass-77")).rejects.toMatchObject({ code: "wrong_password" });
    await expect(changePassword(ac(), "Old-password-2026", "short")).rejects.toMatchObject({ code: "weak_password" });
    const v0 = (await getAccountProfile(pools.admin, userId))!.sessionVersion;
    const { sessionVersion } = await changePassword(ac(), "Old-password-2026", "Brand-new-Pass-77");
    expect(sessionVersion).toBe(v0 + 1);
    const [row] = await audits("profile.password_changed");
    expect(JSON.stringify(row)).not.toContain("Brand-new");
    expect((await signOutOtherSessions(ac())).sessionVersion).toBe(v0 + 2);
  });

  it("rate-limits password attempts", async () => {
    const e = await Promise.resolve()
      .then(async () => {
        for (let i = 0; i < 6; i++) await changePassword(ac(), "nope", "Whatever-Strong-99").catch((x: AccountError) => { if (x.code === "rate_limited") throw x; });
      })
      .catch((x: AccountError) => x);
    expect(e).toMatchObject({ code: "rate_limited" });
  });

  it("changes the email only after the new address confirms, and tells the old one", async () => {
    const profile = (await getAccountProfile(pools.admin, userId))!;
    await expect(requestEmailChange(ac(), "owner@northwind.demo", confirmUrl)).rejects.toMatchObject({ code: "email_taken" });
    const target = `new-${Date.now()}@test.local`;
    await requestEmailChange(ac(), target.toUpperCase(), confirmUrl);
    const token = await tokenSentTo(target);
    const notice = mockEmailOutbox().to(profile.email).at(-1)!;
    expect(notice.message.text).toContain(target);
    expect(notice.message.text).not.toContain("token=");
    expect((await getAccountProfile(pools.admin, userId))!.email).toBe(profile.email);
    expect((await pendingEmailChange(pools.admin, userId))?.email).toBe(target);
    await expect(confirmEmailChange(pools.admin, "forged")).rejects.toMatchObject({ code: "invalid_token" });
    expect(await confirmEmailChange(pools.admin, token)).toEqual({ userId, email: target });
    expect((await getAccountProfile(pools.admin, userId))!.email).toBe(target);
    await expect(confirmEmailChange(pools.admin, token)).rejects.toMatchObject({ code: "invalid_token" });
    expect(await pendingEmailChange(pools.admin, userId)).toBeNull();
  });

  it("expires email links, and never sends a confirmation whose link is dead", async () => {
    const target = `old-${Date.now()}@test.local`;
    await requestEmailChange(ac({ now: new Date(Date.now() - 2 * 86400_000) }), target, confirmUrl);
    await drainEmailJobs(pools.admin);
    expect(mockEmailOutbox().to(target)).toHaveLength(0);
    const [row] = await pools.admin.select({ status: schema.emailMessages.status }).from(schema.emailMessages).where(and(eq(schema.emailMessages.template, "email_change_confirm"), eq(schema.emailMessages.recipientMasked, "ol•••@te•••.local"))).orderBy(desc(schema.emailMessages.createdAt)).limit(1);
    expect(row?.status).toBe("expired");
    const fresh = `fresh-${Date.now()}@test.local`;
    await requestEmailChange(ac(), fresh, confirmUrl);
    const token = await tokenSentTo(fresh);
    await pools.admin.update(schema.verificationTokens).set({ expires: new Date(Date.now() - 1000) }).where(like(schema.verificationTokens.identifier, `email-change:${userId}:%`));
    await expect(confirmEmailChange(pools.admin, token)).rejects.toMatchObject({ code: "expired_token" });
  });

  it("lists only the user's own sign-ins, newest first", async () => {
    await recordSignIn(pools.admin, { userId, method: "credentials", ip: "10.0.0.1", userAgent: "UA1", now: new Date(Date.now() - 1000) });
    await recordSignIn(pools.admin, { userId, method: "email", ip: "10.0.0.2", userAgent: "UA2" });
    await recordSignIn(pools.admin, { userId: otherId, method: "credentials" });
    const list = await listRecentSignIns(ac());
    expect(list.map((s) => s.method)).toEqual(["email", "credentials"]);
  });
});

describe("tenant branding", () => {
  const run = <T>(tenantId: string, fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId: otherId } }), pools.app);
  it("saves colour and logos per tenant, audited, invisible to the other tenant", async () => {
    const a = ctx.tenantIds.northwind;
    const b = ctx.tenantIds.harbor;
    const bBefore = await run(b, getTenantBranding);
    await run(a, (s) => saveBrandColor(s, "#FF5A5F"));
    await expect(run(a, (s) => saveBrandColor(s, "red"))).rejects.toMatchObject({ code: "invalid_color" });
    await run(a, (s) => saveBrandLogo(s, "light", { data: Buffer.from("png"), contentType: "image/png" }));
    const got = await run(a, getTenantBranding);
    expect(got.brandColor).toBe("#ff5a5f");
    expect(got.logoLight).not.toBeNull();
    expect(got.logoDark).toBeNull();
    expect((await run(a, (s) => getBrandLogo(s, "dark")))?.contentType).toBe("image/png");
    expect(await run(b, getTenantBranding)).toEqual(bBefore);
    await run(a, (s) => saveBrandLogo(s, "light", null));
    await run(a, (s) => saveBrandColor(s, null));
    expect(await run(a, (s) => getBrandLogo(s, "light"))).toBeNull();
    const rows = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, a), eq(schema.auditLogs.action, "branding.color_updated")));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
