import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Phone width (CLAUDE.md §7: a usable mobile view on every module, #72, #79). The page itself never
 * scrolls sideways; wide tables scroll inside their own containers.
 *
 * Every page is discovered from the app directory, so a new page is checked without touching this
 * file. Static routes are visited directly; a dynamic route is filled from links found while crawling
 * (up to DYNAMIC_SAMPLES different records, since overflow can depend on the data). A route the crawl
 * cannot reach must be listed in UNREACHED with the reason.
 */
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 780 };
const TENANT = "northwind-apparel";
const DYNAMIC_SAMPLES = 3;
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/app");

/**
 * Filtered lists visited first, so their links fill dynamic routes that only some records have:
 * a return is requested from a shipped or delivered order, only a draft purchase order is editable.
 */
const ENTRY_POINTS = ["/t/[tenant]/orders?status=delivered", "/t/[tenant]/purchasing?status=draft"];

/** Routes no link leads to on the demo data, with the reason. Keep this list short. */
const UNREACHED: Record<string, string> = {};

interface Route { pattern: string; kind: "page" | "route" }

function discover(dir: string, prefix: string): Route[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name.startsWith("_") ? [] : discover(p, name.startsWith("(") ? prefix : `${prefix}/${name}`);
    if (name === "page.tsx") return [{ pattern: prefix, kind: "page" as const }];
    if (name === "route.ts") return [{ pattern: prefix, kind: "route" as const }];
    return [];
  });
}

const toRegex = (pattern: string) => new RegExp(`^${pattern.replace(/\[[^\]]+\]/g, "[^/]+")}$`);

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Visits every page under `area` at phone width; returns the failures and what could not be reached. */
async function crawl(page: Page, area: "t" | "admin", fill: (pattern: string) => string) {
  const all = discover(path.join(APP, area), `/${area}`).map((r) => ({ ...r, pattern: fill(r.pattern) }));
  const pages = all.filter((r) => r.kind === "page");
  const statics = pages.filter((r) => !r.pattern.includes("["));
  // parents before children: a child's link (e.g. …/[id]/edit) is found on its parent's page
  const dynamics = pages.filter((r) => r.pattern.includes("[")).sort((a, b) => a.pattern.split("/").length - b.pattern.split("/").length);
  // links that are not pages of their own: exports, downloads, static siblings of a dynamic segment
  const notADetail = [...all.filter((r) => r.kind === "route").map((r) => toRegex(r.pattern)), ...statics.map((r) => toRegex(r.pattern))];
  const links = new Map<string, string>(); // path → first href seen (query kept: some pages need one)
  const visited: string[] = [];
  const failures: string[] = [];

  const check = async (href: string, width: number) => {
    const res = await page.goto(href);
    const status = res?.status() ?? 0;
    if (status !== 200) return status;
    await expect(page.locator("main")).toBeVisible();
    const overflow = await horizontalOverflow(page);
    if (overflow > 1) failures.push(`${href} at ${width}px: +${overflow}px`);
    return status;
  };
  const collect = async () => {
    for (const href of await page.locator("a[href^='/']").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))) {
      const p = href.split("#")[0]!.split("?")[0]!;
      if (!links.has(p) || (!links.get(p)!.includes("?") && href.includes("?"))) links.set(p, href.split("#")[0]!);
    }
  };

  for (const href of ENTRY_POINTS.filter((e) => e.startsWith(`/${area}/`)).map(fill)) {
    expect((await page.goto(href))?.status(), href).toBe(200);
    await collect();
  }
  const needsQuery: string[] = [];
  for (const r of statics) {
    const status = await check(r.pattern, PHONE.width);
    if (status === 200) {
      visited.push(r.pattern);
      await collect();
    } else if (status === 404) needsQuery.push(r.pattern);
    else failures.push(`${r.pattern}: HTTP ${status}`);
  }
  const unreached: string[] = [];
  for (const r of dynamics) {
    const re = toRegex(r.pattern);
    const hrefs = [...links].filter(([p]) => re.test(p) && !notADetail.some((x) => x.test(p))).slice(0, DYNAMIC_SAMPLES).map(([, h]) => h);
    if (hrefs.length === 0) {
      unreached.push(r.pattern);
      continue;
    }
    for (const href of hrefs) {
      const status = await check(href, PHONE.width);
      if (status === 200) {
        visited.push(href);
        await collect();
      } else failures.push(`${href} (${r.pattern}): HTTP ${status}`);
    }
  }
  // a page opened for one record (e.g. a return for an order) needs the query its links carry
  for (const pattern of needsQuery) {
    const href = links.get(pattern);
    if (!href?.includes("?")) {
      unreached.push(pattern);
      continue;
    }
    const status = await check(href, PHONE.width);
    if (status === 200) visited.push(href);
    else failures.push(`${href}: HTTP ${status}`);
  }
  await page.setViewportSize(NARROW);
  for (const href of visited) await check(href, NARROW.width);
  return { failures, unreached, visited: visited.length };
}

const allowedUnreached = (area: string) => Object.keys(UNREACHED).filter((r) => r.startsWith(`/${area}/`)).map((r) => r.replace("[tenant]", TENANT));

test.describe("mobile layout", () => {
  test("no tenant page scrolls horizontally at 390px and 360px", async ({ page }) => {
    test.setTimeout(15 * 60_000);
    await page.setViewportSize(PHONE);
    await login(page, "owner@northwind.demo");
    await expect(page.getByTestId("user-menu")).toBeInViewport({ ratio: 1 });
    const { failures, unreached, visited } = await crawl(page, "t", (p) => p.replace("[tenant]", TENANT));
    expect(visited).toBeGreaterThanOrEqual(80);
    expect(failures).toEqual([]);
    expect(unreached.sort()).toEqual(allowedUnreached("t").sort());
  });

  test("no console page scrolls horizontally at 390px and 360px", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.setViewportSize(PHONE);
    await login(page, "superadmin@hullwise.demo");
    const { failures, unreached, visited } = await crawl(page, "admin", (p) => p);
    expect(visited).toBeGreaterThanOrEqual(15);
    expect(failures).toEqual([]);
    expect(unreached.sort()).toEqual(allowedUnreached("admin").sort());
  });

  test("the language choice lives in the user menu below sm, and in the header from sm up", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, "viewer@northwind.demo");
    await page.goto(`/t/${TENANT}/orders`);
    const picker = page.getByRole("combobox", { name: /Language|Lingua|Idioma/ });
    await expect(picker).toBeHidden();
    const original = (await page.locator("html").getAttribute("lang"))!;
    const other = original === "es" ? "en" : "es";
    await page.getByTestId("user-menu").click();
    await expect(page.getByTestId(`locale-${original}`)).toBeVisible();
    await page.getByTestId(`locale-${other}`).click();
    await expect(page.locator("html")).toHaveAttribute("lang", other);
    // restore the demo user's language
    await page.getByTestId(`locale-${original}`).click();
    await expect(page.locator("html")).toHaveAttribute("lang", original);
    await page.keyboard.press("Escape");
    // wider screens keep the header picker and do not repeat it in the menu
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(picker).toBeVisible();
    await page.getByTestId("user-menu").click();
    await expect(page.getByTestId("user-menu-language")).toBeHidden();
  });
});
