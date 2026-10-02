import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_NAV } from "@/app/admin/nav-items";

/**
 * Super-admin console guards (#48). The console layout does not protect route handlers nor the data
 * a page loads before the layout renders, so every page, route handler and server action of the
 * console must call `requireSuperAdmin()` itself, before anything else. The e2e spec
 * `admin-routes.spec.ts` checks the same routes over HTTP as a tenant owner.
 */
const ADMIN = path.resolve(__dirname, "../app/admin");
const ACTIONS = [path.resolve(__dirname, "../server/actions/admin.ts"), path.resolve(__dirname, "../server/actions/admin-billing.ts")];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** `/admin/...` URL pattern of every page and route handler, e.g. `/admin/tenants/[id]`. */
function adminRoutes(): { route: string; file: string; kind: "page" | "route" }[] {
  return files(ADMIN)
    .filter((f) => /\/(page\.tsx|route\.ts)$/.test(f))
    .map((f) => {
      const rel = path.relative(ADMIN, path.dirname(f));
      return { route: rel ? `/admin/${rel}` : "/admin", file: f, kind: f.endsWith("route.ts") ? ("route" as const) : ("page" as const) };
    });
}

describe("super-admin console guards", () => {
  const routes = adminRoutes();

  it("finds the console routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
    expect(routes.map((r) => r.route)).toEqual(expect.arrayContaining(["/admin", "/admin/users", "/admin/users/[id]", "/admin/tenants/export", "/admin/billing/export", "/admin/metrics", "/admin/plans", "/admin/integrations"]));
  });

  it.each(routes.map((r) => [r.route, r] as const))("%s calls requireSuperAdmin before any data access", (_route, r) => {
    const src = readFileSync(r.file, "utf8");
    // a page is the component that `export default withIntl(Page, …)` wraps (#49 message scopes)
    const page = src.match(/export default withIntl\((\w+),/)?.[1];
    const handler = r.kind === "page" ? src.slice(page ? src.indexOf(`async function ${page}(`) : src.indexOf("export default async function")) : src.slice(src.indexOf("export async function GET"));
    expect(handler.length, `${r.file}: no handler found`).toBeGreaterThan(0);
    const guard = handler.indexOf("requireSuperAdmin()");
    expect(guard, `${r.file} must call requireSuperAdmin()`).toBeGreaterThan(0);
    // nothing reads the database before the guard
    expect(handler.slice(0, guard)).not.toMatch(/\bdb\.|adminDb\(|withTenant\(|await (?!params|searchParams)\w+\(/);
  });

  it("every console server action starts with requireSuperAdmin", () => {
    const src = ACTIONS.map((f) => readFileSync(f, "utf8")).join("\n");
    const actions = [...src.matchAll(/export async function (\w+)\([^]*?\{\n([^\n]*)/g)].map((m) => ({ name: m[1]!, first: m[2]! }));
    expect(actions.length).toBeGreaterThanOrEqual(19);
    for (const a of actions) expect(a.first, a.name).toMatch(/await requireSuperAdmin\(\)/);
  });

  it("every navigation link points to an existing console page (no dead links)", () => {
    for (const g of ADMIN_NAV) for (const i of g.items) expect(existsSync(path.join(ADMIN, i.href.replace(/^\/admin\/?/, ""), "page.tsx")), i.href).toBe(true);
  });
});
