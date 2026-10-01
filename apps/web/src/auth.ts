import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { adminDb, and, eq, schema } from "@keel/db";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import { isLocale } from "@keel/config";
import { recordSignIn } from "@keel/services";
import { THEME_COOKIE, isThemePreference } from "@keel/ui/tokens";
import { authConfig } from "./auth.config";
import { LOCALE_COOKIE } from "./i18n/request";

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function db() {
  return adminDb();
}

/**
 * Magic-link "provider": in development the link is printed to the console
 * (CLAUDE.md §2). A real mailer plugs in here through MAGIC_LINK_WEBHOOK_URL.
 */
const magicLink = {
  id: "email",
  type: "email" as const,
  name: "Email",
  from: "no-reply@keel.local",
  maxAge: 15 * 60,
  options: {},
  async sendVerificationRequest({ identifier, url }: { identifier: string; url: string }) {
    const hook = process.env.MAGIC_LINK_WEBHOOK_URL;
    if (hook) {
      await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: identifier, url }) });
      return;
    }
    console.info(`\n[auth] Magic link for ${identifier}:\n${url}\n`);
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
