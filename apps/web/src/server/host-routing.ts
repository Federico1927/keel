import { adminOrigin, apiOrigin, appUrl, hostOf } from "@hullwise/config";

/**
 * Host-based routing (edge-safe, pure). One Next.js app serves three hosts:
 *
 * - APP_URL (e.g. my.hullwise.app): everything, the console included at /admin.
 * - ADMIN_URL (e.g. admin.hullwise.app): the console at the root; `/tenants` is served by `/admin/tenants`.
 *   Sign-in pages, auth routes and assets stay as they are; tenant pages redirect to the app host.
 * - API_URL (e.g. api.hullwise.app): API routes without the `/api` prefix (`/mcp` → `/api/mcp`,
 *   `/webhooks/shopify` → `/api/webhooks/shopify`); `/api/*` and `/.well-known/*` keep working.
 *
 * Without ADMIN_URL / API_URL (local development) nothing is rewritten.
 */

export type HostRoute = { kind: "next"; path: string } | { kind: "rewrite"; path: string } | { kind: "redirect"; url: string };

type Env = Record<string, string | undefined>;

/** Paths every host serves unchanged: framework assets, auth, public files. */
const SHARED = [/^\/_next\//, /^\/api\//, /^\/\.well-known(\/|$)/, /^\/favicon/, /^\/icon/, /^\/apple-icon/, /^\/manifest/, /^\/robots\.txt$/, /^\/brand\//, /^\/avatar\//];
/** Account pages the console host also serves directly (sign-in happens on the host the user is on). */
const ADMIN_PASSTHROUGH = [/^\/admin(\/|$)/, /^\/login(\/|$)/, /^\/verify(\/|$)/, /^\/forgot-password(\/|$)/, /^\/reset-password(\/|$)/, /^\/invite(\/|$)/, /^\/account(\/|$)/, /^\/oauth(\/|$)/];
/** Tenant-facing pages: on the console host they belong to the app host. */
const APP_ONLY = [/^\/t(\/|$)/, /^\/welcome(\/|$)/, /^\/r\//, /^\/s\//, /^\/u\//, /^\/supplier\//, /^\/suspended(\/|$)/];

const matches = (rules: RegExp[], path: string) => rules.some((r) => r.test(path));

export function routeForHost(host: string | null | undefined, pathname: string, search = "", env: Env = process.env): HostRoute {
  const h = (host ?? "").toLowerCase();
  const adminHost = hostOf(adminOrigin(env));
  const apiHost = hostOf(apiOrigin(env));

  if (apiHost && h === apiHost) {
    if (matches(SHARED, pathname)) return { kind: "next", path: pathname };
    return { kind: "rewrite", path: pathname === "/" ? "/api/health" : `/api${pathname}` };
  }

  if (adminHost && h === adminHost) {
    if (matches(SHARED, pathname) || matches(ADMIN_PASSTHROUGH, pathname)) return { kind: "next", path: pathname };
    if (matches(APP_ONLY, pathname)) return { kind: "redirect", url: `${appUrl(env)}${pathname}${search}` };
    return { kind: "rewrite", path: pathname === "/" ? "/admin" : `/admin${pathname}` };
  }

  return { kind: "next", path: pathname };
}

/** The path the request is finally served by: what access rules must look at. */
export function effectivePath(host: string | null | undefined, pathname: string, env: Env = process.env): string {
  const r = routeForHost(host, pathname, "", env);
  return r.kind === "redirect" ? pathname : r.path;
}
