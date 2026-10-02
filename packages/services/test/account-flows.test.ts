import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { and, eq, schema, withTenant } from "@hullwise/db";
import { testPools } from "@hullwise/db/test-utils";
import { seedPlatform, type SeedContext } from "@hullwise/db/seed";
import {
  RESETS_PER_EMAIL_PER_HOUR,
  RESETS_PER_IP_PER_HOUR,
  acceptInvitationAsNewUser,
  acceptInvitationAsUser,
  changePassword,
  completePasswordReset,
  createInvitation,
  drainEmailJobs,
  findInvitationByToken,
  inspectPasswordReset,
  listInvitations,
  mockEmailOutbox,
  recordSignIn,
  requestPasswordReset,
  resendInvitation,
  revokeInvitation,
  setSignInNotifications,
  type ServiceContext,
} from "../src";

const pools = testPools();
let ctx: SeedContext;
let A = "";
let B = "";
let ownerA = "";
const stamp = Date.now().toString(36);
const run = <T>(tenantId: string, fn: (s: ServiceContext) => Promise<T>, userId = ownerA) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId } }), pools.app);
const names = { inviterName: "Giulia", tenantName: "Northwind Apparel", tenantLocale: "it" };
/** The last email the mock captured for an address, after delivering the queue. */
const lastMail = async (to: string) => {
  await drainEmailJobs(pools.admin);
  return mockEmailOutbox().to(to).at(-1);
};
const tokenIn = (text: string, path: "invite" | "reset-password") => new RegExp(`/${path}/([A-Za-z0-9_-]{43,})`).exec(text)?.[1] ?? null;

beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  A = ctx.tenantIds.northwind;
  B = ctx.tenantIds.harbor;
  ownerA = ctx.userIds["owner@northwind.demo"]!;
});
afterAll(() => pools.close());

describe("invitations", () => {
  it("invite → email with a single-use link → new user with name and password → member of the inviting tenant only", async () => {
    const email = `new-${stamp}@test.local`;
    const created = await run(A, (s) => createInvitation(s, { email: email.toUpperCase(), role: "marketing", ...names }, { actorRole: "owner" }));
    expect(created.email).toBe(email);
    const mail = await lastMail(email);
    expect(mail!.message.subject).toBe("Giulia ti ha invitato in Northwind Apparel su Hullwise come marketing");
    const raw = tokenIn(mail!.message.text, "invite")!;
    expect(raw.length).toBeGreaterThanOrEqual(43);
    // only the hash is stored, never the token
    const [row] = await pools.admin.select().from(schema.invitations).where(eq(schema.invitations.id, created.id));
    expect(row!.tokenHash).not.toBe(raw);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(7 * 86_400_000);
    const view = await findInvitationByToken(pools.admin, raw);
    expect(view).toMatchObject({ tenantId: A, email, role: "marketing", state: "pending", existingUserId: null, inviterName: "Giulia" });

    await expect(acceptInvitationAsNewUser(pools.admin, raw, { name: "New Person", password: "Strong-pass-2026!", privacyAccepted: false })).rejects.toMatchObject({ code: "privacy_required" });
    await expect(acceptInvitationAsNewUser(pools.admin, raw, { name: "New Person", password: "short", privacyAccepted: true })).rejects.toMatchObject({ code: "weak_password" });
    await expect(acceptInvitationAsNewUser(pools.admin, raw, { name: " ", password: null, privacyAccepted: true })).rejects.toMatchObject({ code: "invalid_input" });
    const done = await acceptInvitationAsNewUser(pools.admin, raw, { name: "New Person", preferredName: "Newt", password: "Strong-pass-2026!", privacyAccepted: true, locale: "en" });
    expect(done.tenantSlug).toBe("northwind-apparel");
    const [user] = await pools.admin.select().from(schema.users).where(eq(schema.users.id, done.userId));
    expect(user).toMatchObject({ email, name: "New Person", preferredName: "Newt" });
    expect(user!.emailVerified).not.toBeNull();
    expect(user!.privacyAcceptedAt).not.toBeNull();
    expect(await bcrypt.compare("Strong-pass-2026!", user!.passwordHash!)).toBe(true);
    const memberships = await pools.admin.select().from(schema.tenantMemberships).where(eq(schema.tenantMemberships.userId, done.userId));
    expect(memberships.map((m) => [m.tenantId, m.role])).toEqual([[A, "marketing"]]);
    // welcome email: profile link, no integration guide for a non-owner
    const welcome = await lastMail(email);
    expect(welcome!.message.tags?.template).toBe("welcome");
    expect(welcome!.message.text).toContain("/t/northwind-apparel/profile");
    expect(welcome!.message.text).not.toContain("/integrations/guide");
    // single use
    await expect(acceptInvitationAsNewUser(pools.admin, raw, { name: "Again", password: null, privacyAccepted: true })).rejects.toMatchObject({ code: "used_token" });
    expect((await findInvitationByToken(pools.admin, raw))?.state).toBe("accepted");
    // audited, never with the token
    const audits = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityType, "invitation"), eq(schema.auditLogs.entityId, created.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["invitation.accepted", "invitation.sent"]);
    expect(JSON.stringify(audits)).not.toContain(raw);
  });

  it("refuses expired, revoked, replaced and forged tokens; resend issues a new link and the old one stops working", async () => {
    const email = `exp-${stamp}@test.local`;
    const past = new Date(Date.now() - 8 * 86_400_000);
    await withTenant(A, (tx) => createInvitation({ tenantId: A, tx, actor: { type: "user", userId: ownerA }, now: past }, { email, role: "viewer", ...names }), pools.app);
    const expired = tokenIn((await lastMail(email))?.message.text ?? "", "invite");
    // an invitation email is never delivered after its link expired
    expect(expired).toBeNull();
    const [row] = await pools.admin.select().from(schema.invitations).where(and(eq(schema.invitations.tenantId, A), eq(schema.invitations.email, email)));
    expect((await run(A, (s) => listInvitations(s))).find((i) => i.id === row!.id)?.state).toBe("expired");

    const fresh = await run(A, (s) => createInvitation(s, { email, role: "viewer", ...names }));
    const first = tokenIn((await lastMail(email))!.message.text, "invite")!;
    await run(A, (s) => resendInvitation(s, fresh.id, names));
    const second = tokenIn((await lastMail(email))!.message.text, "invite")!;
    expect(second).not.toBe(first);
    expect(await findInvitationByToken(pools.admin, first)).toBeNull();
    await run(A, (s) => revokeInvitation(s, fresh.id));
    await expect(acceptInvitationAsNewUser(pools.admin, second, { name: "X", password: null, privacyAccepted: true })).rejects.toMatchObject({ code: "revoked_token" });
    await expect(acceptInvitationAsNewUser(pools.admin, "A".repeat(43), { name: "X", password: null, privacyAccepted: true })).rejects.toMatchObject({ code: "invalid_token" });
    await expect(acceptInvitationAsNewUser(pools.admin, "../../etc", { name: "X", password: null, privacyAccepted: true })).rejects.toMatchObject({ code: "invalid_token" });
    await expect(run(A, (s) => revokeInvitation(s, fresh.id))).rejects.toMatchObject({ code: "not_pending" });
    // a time past the expiry refuses the token at acceptance
    const late = await run(A, (s) => createInvitation(s, { email: `late-${stamp}@test.local`, role: "viewer", ...names }));
    const lateRaw = tokenIn((await lastMail(`late-${stamp}@test.local`))!.message.text, "invite")!;
    await expect(acceptInvitationAsNewUser(pools.admin, lateRaw, { name: "X", password: null, privacyAccepted: true }, new Date(Date.now() + 8 * 86_400_000))).rejects.toMatchObject({ code: "expired_token" });
    expect(late.id).toBeTruthy();
  });

  it("isolation: tenant B cannot list, resend or revoke tenant A's invitations, and A's invitation never grants B", async () => {
    const email = `iso-${stamp}@test.local`;
    const inv = await run(A, (s) => createInvitation(s, { email, role: "admin", ...names }));
    const raw = tokenIn((await lastMail(email))!.message.text, "invite")!;
    const ownerB = ctx.userIds["owner@harborhome.demo"]!;
    expect((await run(B, (s) => listInvitations(s), ownerB)).map((i) => i.id)).not.toContain(inv.id);
    await expect(run(B, (s) => revokeInvitation(s, inv.id), ownerB)).rejects.toMatchObject({ code: "not_found" });
    await expect(run(B, (s) => resendInvitation(s, inv.id, names), ownerB)).rejects.toMatchObject({ code: "not_found" });
    const done = await acceptInvitationAsNewUser(pools.admin, raw, { name: "Iso Person", password: null, privacyAccepted: true });
    const memberships = await pools.admin.select().from(schema.tenantMemberships).where(eq(schema.tenantMemberships.userId, done.userId));
    expect(memberships.map((m) => m.tenantId)).toEqual([A]);
    // the account has no password: it signs in with email links
    const [u] = await pools.admin.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, done.userId));
    expect(u!.hash).toBeNull();
  });

  it("an existing account accepts after signing in, only for its own address; members cannot be invited twice; admins cannot invite owners", async () => {
    const multi = ctx.userIds["multi@hullwise.demo"]!;
    await expect(run(B, (s) => createInvitation(s, { email: "multi@hullwise.demo", role: "viewer", ...names }))).rejects.toMatchObject({ code: "already_member" });
    await expect(run(A, (s) => createInvitation(s, { email: "x@test.local", role: "owner", ...names }, { actorRole: "admin" }))).rejects.toMatchObject({ code: "forbidden" });
    await pools.admin.update(schema.tenantMemberships).set({ isActive: false }).where(and(eq(schema.tenantMemberships.tenantId, B), eq(schema.tenantMemberships.userId, multi)));
    try {
      await run(B, (s) => createInvitation(s, { email: "multi@hullwise.demo", role: "marketing", ...names }));
      const raw = tokenIn((await lastMail("multi@hullwise.demo"))!.message.text, "invite")!;
      expect((await findInvitationByToken(pools.admin, raw))?.existingUserId).toBe(multi);
      await expect(acceptInvitationAsUser(pools.admin, raw, ownerA)).rejects.toMatchObject({ code: "email_mismatch" });
      await expect(acceptInvitationAsNewUser(pools.admin, raw, { name: "Dup", password: null, privacyAccepted: true })).rejects.toMatchObject({ code: "account_exists" });
      expect(await acceptInvitationAsUser(pools.admin, raw, multi)).toEqual({ tenantSlug: "harbor-home" });
      const [m] = await pools.admin.select().from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, B), eq(schema.tenantMemberships.userId, multi)));
      expect(m).toMatchObject({ role: "marketing", isActive: true });
    } finally {
      await pools.admin.update(schema.tenantMemberships).set({ role: "viewer", isActive: true }).where(and(eq(schema.tenantMemberships.tenantId, B), eq(schema.tenantMemberships.userId, multi)));
    }
  });
});

describe("forgotten password", () => {
  let userId = "";
  let email = "";
  beforeAll(async () => {
    email = `reset-${stamp}@test.local`;
    const [u] = await pools.admin.insert(schema.users).values({ email, name: "Reset Person", passwordHash: await bcrypt.hash("Old-password-2026", 4) }).returning({ id: schema.users.id });
    userId = u!.id;
    await pools.admin.insert(schema.tenantMemberships).values({ tenantId: B, userId, role: "viewer" });
  });

  it("answers the same for unknown addresses and sends nothing; a known one gets a single-use link that a newer request invalidates", async () => {
    const before = mockEmailOutbox().sent.length;
    expect(await requestPasswordReset(pools.admin, { email: `nobody-${stamp}@test.local`, ip: "198.51.100.1" })).toEqual({ sent: false });
    // an account without any active workspace is not active either
    const [lonely] = await pools.admin.insert(schema.users).values({ email: `lonely-${stamp}@test.local`, name: "Lonely" }).returning({ id: schema.users.id });
    expect(await requestPasswordReset(pools.admin, { email: `lonely-${stamp}@test.local`, ip: "198.51.100.1" })).toEqual({ sent: false });
    await drainEmailJobs(pools.admin);
    expect(mockEmailOutbox().sent.length).toBe(before);
    expect(lonely).toBeTruthy();

    expect(await requestPasswordReset(pools.admin, { email: email.toUpperCase(), ip: "198.51.100.2" })).toEqual({ sent: true });
    const first = tokenIn((await lastMail(email))!.message.text, "reset-password")!;
    expect(await requestPasswordReset(pools.admin, { email, ip: "198.51.100.2" })).toEqual({ sent: true });
    const second = tokenIn((await lastMail(email))!.message.text, "reset-password")!;
    expect((await inspectPasswordReset(pools.admin, first)).state).toBe("used");
    expect(await inspectPasswordReset(pools.admin, second)).toEqual({ state: "valid", email });
    await expect(completePasswordReset(pools.admin, first, "Brand-new-Pass-77")).rejects.toMatchObject({ code: "used_token" });

    const [row] = await pools.admin.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, userId)).limit(1);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.expiresAt!.getTime() - row!.createdAt.getTime()).toBe(60 * 60_000);

    // a weak password does not consume the link
    await expect(completePasswordReset(pools.admin, second, "short")).rejects.toMatchObject({ code: "weak_password" });
    const [{ sv: v0 }] = (await pools.admin.select({ sv: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, userId))) as [{ sv: number }];
    const done = await completePasswordReset(pools.admin, second, "Brand-new-Pass-77", { ip: "198.51.100.2" });
    expect(done).toEqual({ userId, sessionVersion: v0 + 1 });
    const [u] = await pools.admin.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(await bcrypt.compare("Brand-new-Pass-77", u!.passwordHash!)).toBe(true);
    await expect(completePasswordReset(pools.admin, second, "Another-pass-88")).rejects.toMatchObject({ code: "used_token" });
    const notice = await lastMail(email);
    expect(notice!.message.tags?.template).toBe("password_changed");
    const audits = await pools.admin.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityType, "user"), eq(schema.auditLogs.entityId, userId)));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["account.password_reset_requested", "account.password_reset_completed"]));
    expect(JSON.stringify(audits)).not.toContain(second);
  });

  it("expires links after 60 minutes and refuses forged ones", async () => {
    await expect(completePasswordReset(pools.admin, "B".repeat(43), "Brand-new-Pass-99")).rejects.toMatchObject({ code: "invalid_token" });
    expect((await inspectPasswordReset(pools.admin, "nope")).state).toBe("invalid");
    await requestPasswordReset(pools.admin, { email });
    const live = tokenIn((await lastMail(email))!.message.text, "reset-password")!;
    const later = new Date(Date.now() + 61 * 60_000);
    expect((await inspectPasswordReset(pools.admin, live, later)).state).toBe("expired");
    await expect(completePasswordReset(pools.admin, live, "Brand-new-Pass-99", { now: later })).rejects.toMatchObject({ code: "expired_token" });
  });

  it("rate-limits requests per address and per IP with one generic error", async () => {
    const target = `limit-${stamp}@test.local`;
    for (let i = 0; i < RESETS_PER_EMAIL_PER_HOUR; i++) await requestPasswordReset(pools.admin, { email: target, ip: `203.0.113.${i}` });
    await expect(requestPasswordReset(pools.admin, { email: target, ip: "203.0.113.99" })).rejects.toMatchObject({ code: "rate_limited" });
    const ip = "192.0.2.77";
    for (let i = 0; i < RESETS_PER_IP_PER_HOUR; i++) await requestPasswordReset(pools.admin, { email: `ip-${i}-${stamp}@test.local`, ip });
    await expect(requestPasswordReset(pools.admin, { email: `ip-last-${stamp}@test.local`, ip })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("security notices", () => {
  it("new sign-in from an unseen browser, never on the first sign-in, never when turned off; password change notice", async () => {
    const email = `notice-${stamp}@test.local`;
    const [u] = await pools.admin.insert(schema.users).values({ email, name: "Notice Person", passwordHash: await bcrypt.hash("Old-password-2026", 4) }).returning({ id: schema.users.id });
    const userId = u!.id;
    const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
    const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
    expect(await recordSignIn(pools.admin, { userId, method: "credentials", userAgent: MAC, notifyNewDevice: true })).toEqual({ newDeviceNotice: false });
    expect(await recordSignIn(pools.admin, { userId, method: "credentials", userAgent: MAC, notifyNewDevice: true })).toEqual({ newDeviceNotice: false });
    expect(await recordSignIn(pools.admin, { userId, method: "credentials", userAgent: WIN, ip: "203.0.113.5", notifyNewDevice: true })).toEqual({ newDeviceNotice: true });
    const mail = await lastMail(email);
    expect(mail!.message.subject).toBe("New sign-in to your Hullwise account");
    expect(mail!.message.text).toContain("Firefox · Windows");
    await setSignInNotifications({ db: pools.admin, userId }, false);
    expect(await recordSignIn(pools.admin, { userId, method: "credentials", userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile Safari/537.36", notifyNewDevice: true })).toEqual({ newDeviceNotice: false });

    await changePassword({ db: pools.admin, userId }, "Old-password-2026", "Brand-new-Pass-77");
    expect((await lastMail(email))!.message.tags?.template).toBe("password_changed");
  });
});
