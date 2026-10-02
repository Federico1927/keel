import type { NextAuthConfig } from "next-auth";
import { cookieDomain } from "@hullwise/config";
import { routeForHost } from "./server/host-routing";
import { verifySessionVersion } from "./server/session-proof";

/**
 * With COOKIE_DOMAIN (e.g. `.hullwise.app`) the session cookie is shared by the app, console and API
 * hosts, so a sign-in on one host is valid on the others and OAuth callbacks on the API host see it.
 */
const sharedDomain = cookieDomain();
const sessionCookie = sharedDomain
  ? {
      sessionToken: {
        name: process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token",
        options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production", domain: sharedDomain },
      },
    }
  : undefined;

/**
 * Edge-safe part of the Auth.js configuration (no database, no Node-only
 * modules). Used by the middleware; `auth.ts` extends it with providers.
 */
export const authConfig = {
  pages: { signIn: "/login", verifyRequest: "/verify", error: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  trustHost: true,
  ...(sessionCookie ? { cookies: sessionCookie } : {}),
  callbacks: {
    authorized({ auth, request }) {
      const route = routeForHost(request.headers.get("host"), request.nextUrl.pathname);
      // a page that belongs to another host is redirected there first; that host applies its own rules
      if (route.kind === "redirect") return true;
      const pathname = route.path;
      const isProtected = pathname.startsWith("/t/") || pathname.startsWith("/admin") || pathname === "/" || pathname === "/welcome";
      if (!isProtected) return true;
      return Boolean(auth?.user);
    },
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.uid = user.id;
        token.isSuperAdmin = Boolean((user as { isSuperAdmin?: boolean }).isSuperAdmin);
        token.locale = (user as { locale?: string | null }).locale ?? null;
        token.sv = (user as { sessionVersion?: number }).sessionVersion ?? 0;
      }
      if (trigger === "update" && session && typeof session === "object") {
        const s = session as { locale?: string | null; sv?: number; svProof?: string };
        if ("locale" in s) token.locale = s.locale ?? null;
        // a new session version (password change, "sign out other sessions") only with the server's proof
        if ("sv" in s && token.uid && (await verifySessionVersion(String(token.uid), s.sv, s.svProof))) token.sv = s.sv;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = String(token.uid ?? "");
      session.user.isSuperAdmin = Boolean(token.isSuperAdmin);
      session.user.locale = (token.locale as string | null) ?? null;
      session.user.sessionVersion = typeof token.sv === "number" ? token.sv : 0;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
