import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe part of the Auth.js configuration (no database, no Node-only
 * modules). Used by the middleware; `auth.ts` extends it with providers.
 */
export const authConfig = {
  pages: { signIn: "/login", verifyRequest: "/verify", error: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isProtected = pathname.startsWith("/t/") || pathname.startsWith("/admin") || pathname === "/";
      if (!isProtected) return true;
      return Boolean(auth?.user);
    },
    jwt({ token, user, trigger, session }) {
      if (user) {
        token.uid = user.id;
        token.isSuperAdmin = Boolean((user as { isSuperAdmin?: boolean }).isSuperAdmin);
        token.locale = (user as { locale?: string | null }).locale ?? null;
      }
      if (trigger === "update" && session && typeof session === "object") {
        const s = session as { locale?: string | null };
        if ("locale" in s) token.locale = s.locale ?? null;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = String(token.uid ?? "");
      session.user.isSuperAdmin = Boolean(token.isSuperAdmin);
      session.user.locale = (token.locale as string | null) ?? null;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
