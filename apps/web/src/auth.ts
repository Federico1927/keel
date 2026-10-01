import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { adminDb, eq, schema } from "@keel/db";
import { z } from "zod";
import { renderEmail, sendPlatformEmail } from "@keel/services";
import { authConfig } from "./auth.config";

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function db() {
  return adminDb();
}

/**
 * Magic-link "provider": the email is rendered from the `magic_link` template in the user's
 * language. A real mailer plugs in through MAGIC_LINK_WEBHOOK_URL or the platform email provider
 * (live mode with KEEL_EMAIL_API_KEY); otherwise, in development, the email text with the link is
 * printed to the console (CLAUDE.md §2).
 */
const magicLink = {
  id: "email",
  type: "email" as const,
  name: "Email",
  from: "no-reply@keel.local",
  maxAge: 15 * 60,
  options: {},
  async sendVerificationRequest({ identifier, url }: { identifier: string; url: string }) {
    const [user] = await db().select({ locale: schema.users.locale }).from(schema.users).where(eq(schema.users.email, identifier.toLowerCase())).limit(1);
    const data = { url, minutes: 15 };
    const hook = process.env.MAGIC_LINK_WEBHOOK_URL;
    if (hook) {
      const mail = renderEmail("magic_link", user?.locale, data);
      await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: identifier, url, subject: mail.subject, text: mail.text, html: mail.html }) });
      return;
    }
    const sent = await sendPlatformEmail({ to: identifier, template: "magic_link", data, locale: user?.locale });
    if (sent.outcome === "mock") console.info(`\n[auth] Magic link for ${identifier}:\n${url}\n\n--- ${sent.rendered.subject} ---\n${sent.rendered.text}\n`);
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
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
        return { id: user.id, email: user.email, name: user.name, isSuperAdmin: user.isSuperAdmin, locale: user.locale };
      },
    }),
    magicLink,
  ],
  events: {
    async signIn({ user }) {
      if (user.id) await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    },
  },
});
