/**
 * Public URLs of the platform, all from the environment (no hardcoded domains). Production:
 *
 *   NEXT_PUBLIC_SITE_URL  https://hullwise.app        landing
 *   APP_URL               https://my.hullwise.app     tenant app
 *   ADMIN_URL             https://admin.hullwise.app  super-admin console (also served at APP_URL/admin)
 *   API_URL               https://api.hullwise.app    webhooks, OAuth callbacks, MCP
 *
 * Locally only APP_URL (or NEXT_PUBLIC_APP_URL) is needed: the console falls back to APP_URL/admin and
 * the API to APP_URL/api, which is where the routes live in the Next.js app. On the API host the
 * middleware maps `/<path>` to `/api/<path>`, so `${API_URL}/mcp` and `${APP_URL}/api/mcp` reach the same route.
 */

type Env = Record<string, string | undefined>;

const trim = (v: string) => v.replace(/\/+$/, "");
const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export const DEFAULT_APP_URL = "http://localhost:3000";
export const DEFAULT_SITE_URL = "http://localhost:3100";

/** Tenant app origin. `NEXT_PUBLIC_APP_URL` mirrors it for the browser and stays accepted as a fallback. */
export function appUrl(env: Env = process.env): string {
  return trim(nonEmpty(env.APP_URL) ?? nonEmpty(env.NEXT_PUBLIC_APP_URL) ?? nonEmpty(env.AUTH_URL) ?? DEFAULT_APP_URL);
}

/** Landing site origin. */
export function siteUrl(env: Env = process.env): string {
  return trim(nonEmpty(env.NEXT_PUBLIC_SITE_URL) ?? DEFAULT_SITE_URL);
}

/** Dedicated admin origin when configured, else null (the console is then only at APP_URL/admin). */
export function adminOrigin(env: Env = process.env): string | null {
  const v = nonEmpty(env.ADMIN_URL);
  return v ? trim(v) : null;
}

/** Dedicated API origin when configured, else null (the API is then only at APP_URL/api). */
export function apiOrigin(env: Env = process.env): string | null {
  const v = nonEmpty(env.API_URL);
  return v ? trim(v) : null;
}

/** Absolute URL of a console page: `adminPage("/tenants")` → ADMIN_URL/tenants or APP_URL/admin/tenants. */
export function adminPage(path = "", env: Env = process.env): string {
  const p = path && !path.startsWith("/") ? `/${path}` : path;
  const origin = adminOrigin(env);
  return origin ? `${origin}${p}` : `${appUrl(env)}/admin${p}`;
}

/**
 * Absolute URL of an API route, given its path under `/api`: `apiEndpoint("/webhooks/shopify")` →
 * API_URL/webhooks/shopify, or APP_URL/api/webhooks/shopify without a dedicated API host.
 */
export function apiEndpoint(path: string, env: Env = process.env): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const origin = apiOrigin(env);
  return origin ? `${origin}${p}` : `${appUrl(env)}/api${p}`;
}

/** Host (hostname:port, lower case) of a URL, or null when it does not parse. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Parent domain for cookies shared by the app, admin and API hosts (e.g. `.hullwise.app`). Needed in
 * production so the session and the OAuth state cookie reach the console subdomain and the OAuth
 * callbacks on the API host. Unset locally: cookies stay host-only.
 */
export function cookieDomain(env: Env = process.env): string | undefined {
  return nonEmpty(env.COOKIE_DOMAIN);
}

/**
 * Operations docs (runbooks) of the repository, read on GitHub from `main`: the console links them
 * for the platform owner, who has access to the repository. `HULLWISE_DOCS_URL` points elsewhere
 * (a fork, a branch, a docs site). The default names the repository, not the product.
 */
export const DEFAULT_DOCS_URL = "https://github.com/Federico1927/keel/blob/main/docs";

export function docsUrl(file: string, env: Env = process.env): string {
  return `${trim(nonEmpty(env.HULLWISE_DOCS_URL) ?? DEFAULT_DOCS_URL)}/${file.replace(/^\/+/, "")}`;
}

/** The first-store onboarding runbook: Italian for an Italian console, English otherwise. */
export function onboardingRunbookUrl(locale: string, env: Env = process.env): string {
  return docsUrl(locale === "it" ? "ONBOARDING.it.md" : "ONBOARDING.md", env);
}
