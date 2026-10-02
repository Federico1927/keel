import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "./auth.config";
import { routeForHost } from "./server/host-routing";

const { auth } = NextAuth(authConfig);
const authGuard = auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;

/**
 * Host routing first (console on ADMIN_URL, API on API_URL; see server/host-routing.ts), then the
 * Auth.js guard. Rewrites are built from the raw request URL: Auth.js rebases its copy on AUTH_URL,
 * which would turn an internal rewrite into a proxy call to the app host. A rewritten console page is
 * still protected server-side by `requireSuperAdmin` in the console layout, and API routes check
 * their own credentials.
 */
export default async function middleware(req: NextRequest, ev: NextFetchEvent) {
  const route = routeForHost(req.headers.get("host"), req.nextUrl.pathname, req.nextUrl.search);
  if (route.kind === "redirect") return NextResponse.redirect(route.url);
  if (route.kind === "rewrite") return NextResponse.rewrite(new URL(`${route.path}${req.nextUrl.search}`, req.url));
  return authGuard(req, ev);
}

export const config = {
  matcher: ["/((?!api/auth|api/mcp|api/oauth|api/v1|\\.well-known|_next/static|_next/image|favicon.ico|screenshots|.*\\.(?:png|svg|jpg|webp|ico|css)).*)"],
};
