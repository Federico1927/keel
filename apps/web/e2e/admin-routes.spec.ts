import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Every console route (#48), discovered from the app directory: it renders for the super-admin and is
 * a 404 for a tenant owner (and sends anonymous visitors to the login). The unit test
 * `src/test/admin-guards.test.ts` checks the same routes call `requireSuperAdmin()` first.
 */
const ADMIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/app/admin");
function routes(dir = ADMIN): { route: string; kind: "page" | "route" }[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routes(p);
    if (name !== "page.tsx" && name !== "route.ts") return [];
    const rel = path.relative(ADMIN, dir);
    return [{ route: rel ? `/admin/${rel}` : "/admin", kind: name === "route.ts" ? ("route" as const) : ("page" as const) }];
  });
}
const ALL = routes().filter((r) => !r.route.split("/").some((s) => s.startsWith("_")));
const RANDOM = "00000000-0000-4000-8000-000000000000";

async function hrefOf(page: Page, url: string, selector: string): Promise<string | null> {
  await page.goto(url);
  const link = page.locator(selector).first();
  return (await link.count()) ? ((await link.getAttribute("href"))?.split("/").pop() ?? null) : null;
}

test.describe("console routes are for super-admins only", () => {
  test("each route renders for the super-admin and is a 404 for a tenant owner", async ({ page, browser }) => {
    expect(ALL.length).toBeGreaterThanOrEqual(15);
    await login(page, "superadmin@keel.demo");
    const dynamic: Record<string, string | null> = {
      "/admin/tenants/[id]": await hrefOf(page, "/admin/tenants?q=northwind", '[data-testid="tenant-row"] a[href^="/admin/tenants/"]'),
      "/admin/users/[id]": await hrefOf(page, "/admin/users?q=owner@northwind.demo", '[data-testid="user-row"] a[href^="/admin/users/"]'),
      "/admin/support/[id]": await hrefOf(page, "/admin/support", 'a[href^="/admin/support/"]:not([href*="?"])'),
    };
    expect(dynamic["/admin/tenants/[id]"]).toBeTruthy();
    expect(dynamic["/admin/users/[id]"]).toBeTruthy();
    const urlOf = (route: string) => {
      if (!route.includes("[")) return { url: route, real: true };
      const id = dynamic[route] ?? null;
      return { url: route.replace(/\[\w+\]/, id ?? RANDOM), real: Boolean(id) };
    };
    for (const r of ALL) {
      const { url, real } = urlOf(r.route);
      if (!real) continue;
      const res = r.kind === "page" ? await page.goto(url) : await page.request.get(url);
      expect(res?.status(), `super-admin ${url}`).toBe(200);
    }

    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await login(owner, "owner@northwind.demo");
    for (const r of ALL) {
      const { url } = urlOf(r.route);
      const res = r.kind === "page" ? await owner.goto(url) : await owner.request.get(url, { maxRedirects: 0 });
      expect(res?.status(), `owner ${url}`).toBe(404);
      if (r.kind === "page") await expect(owner.getByTestId("platform-mode")).toHaveCount(0);
    }
    await ownerCtx.close();

    const anonCtx = await browser.newContext();
    const anon = await anonCtx.newPage();
    for (const r of ALL.filter((x) => x.kind === "page")) {
      await anon.goto(urlOf(r.route).url);
      await expect(anon, `anonymous ${r.route}`).toHaveURL(/\/login/);
    }
    await anonCtx.close();
  });
});
