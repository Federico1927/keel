import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { adminDb, and, eq, schema } from "@keel/db";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import { isLocale } from "@keel/config";
import { createHash } from "node:crypto";
import { emailSettings, queueEmail, recordSignIn } from "@keel/services";
import { THEME_COOKIE, isThemePreference } from "@keel/ui/tokens";
import { authConfig } from "./auth.config";
import { LOCALE_COOKIE } from "./i18n/request";
import "./server/email";

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function db() {
  return adminDb();
}

/**
 * Magic-link "provider": the `magic_link` security template in the user's language, queued through
 * the platform mailer (Resend in live mode with RESEND_API_KEY, the recording mock otherwise; never
 * sent after the link expires). In development, with the mock, the link is also printed to the
 * console (CLAUDE.md §2) and the email shows in /dev/emails.
 */
const MAGIC_LINK_MINUTES = 15;
const magicLink = {
  id: "email",
  type: "email" as const,
  name: "Email",
  from: "no-reply@keel.local",
  maxAge: MAGIC_LINK_MINUTES * 60,
  options: {},
  async sendVerificationRequest({ identifier, url, expires }: { identifier: string; url: string; expires: Date }) {
    const [user] = await db().select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.email, identifier.toLowerCase())).limit(1);
    await queueEmail({ db: db() }, { to: identifier, template: "magic_link", data: { url, minutes: MAGIC_LINK_MINUTES }, locale: user?.locale, event: `magic:${createHash("sha256").update(url).digest("hex")}`, expiresAt: expires });
    if (process.env.NODE_ENV === "development" && emailSettings().provider === "mock") console.info(`\n[auth] Magic link for ${identifier}:\n${url}\n`);
  },
};

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  providers: [
    Credentials({
      name: "Password",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase().trim();
        const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
        if (!user?.passwordHash) return null;
        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;
        await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
        return { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin, locale: user.locale, sessionVersion: user.sessionVersion };
      },
    }),
    magicLink,
  ],
  events: {
    async signIn({ user, account }) {
      if (!user.id) return;
      await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
      const h = await headers();
      await recordSignIn(db(), { userId: user.id, method: account?.provider ?? "unknown", ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip"), userAgent: h.get("user-agent") });
      const jar = await cookies();
      const year = { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" as const };
      // a language chosen on the profile (or with the picker) follows the user to every device;
      // without one, the language of the user's first tenant ("empty = tenant default")
      const [row] = await db()
        .select({ locale: schema.users.locale, theme: schema.users.theme, tenantLocale: schema.tenants.defaultLocale })
        .from(schema.users)
        .leftJoin(schema.tenantMemberships, and(eq(schema.tenantMemberships.userId, schema.users.id), eq(schema.tenantMemberships.isActive, true)))
        .leftJoin(schema.tenants, eq(schema.tenants.id, schema.tenantMemberships.tenantId))
        .where(eq(schema.users.id, user.id))
        .orderBy(schema.tenants.name)
        .limit(1);
      const locale = row?.locale ?? row?.tenantLocale;
      if (isLocale(locale)) jar.set(LOCALE_COOKIE, locale, year);
      // mirror of the saved theme, so signed-out pages on this device keep it without a flash
      jar.set(THEME_COOKIE, isThemePreference(row?.theme) ? row.theme : "system", year);
    },
  },
});
