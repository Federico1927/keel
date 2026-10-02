import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * The super-admin console on a phone (#49, Tier 2 "admin console (#48)"): every /admin page fits the
 * screen (no sideways scroll), lists are DataList cards, filters open in a bottom sheet with removable
 * chips and the sort options, and the primary actions stay within reach. Runs in the mobile-* projects;
 * it only reads (the filter and sort it applies live in the URL).
 */
test.describe.configure({ mode: "serial" });

const SUPER_ADMIN = "superadmin@hullwise.demo";

async function noSideScroll(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(m.scroll, `${label} scrolls sideways (${m.scroll} > ${m.client})`).toBeLessThanOrEqual(m.client);
}

async function firstHref(page: Page, re: RegExp): Promise<string | null> {
  const hrefs = await page.locator("main a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  return hrefs.find((h) => re.test(h.split("?")[0]!)) ?? null;
}

test("every console page fits the phone screen", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page, SUPER_ADMIN);
  const pages = [
    "/admin", "/admin/metrics", "/admin/metrics?month=" + new Date().toISOString().slice(0, 7) + "&metric=mrr",
    "/admin/tenants", "/admin/tenants?attention=1", "/admin/tenants/new", "/admin/plans",
    "/admin/users", "/admin/billing", "/admin/billing?status=open", "/admin/billing/subscriptions",
    "/admin/integrations", "/admin/integrations?status=all", "/admin/email", "/admin/mcp", "/admin/jobs", "/admin/alerts?status=all",
    "/admin/support", "/admin/audit", "/admin/profile", "/admin/styleguide",
  ];
  for (const p of pages) {
    await page.goto(p);
    await noSideScroll(page, p);
  }
  // detail pages, reached from their lists
  const details: [string, RegExp][] = [
    ["/admin/tenants", /^\/admin\/tenants\/[0-9a-f-]{36}$/],
    ["/admin/users", /^\/admin\/users\/[0-9a-f-]{36}$/],
    ["/admin/support", /^\/admin\/support\/[0-9a-f-]{36}$/],
  ];
  for (const [list, re] of details) {
    await page.goto(list);
    const href = await firstHref(page, re);
    if (!href) continue;
    await page.goto(href);
    await noSideScroll(page, href);
  }
  // the busiest tenant detail: Northwind (add-ons, invoices, exports, members)
  await page.goto("/admin/tenants?q=northwind");
  await page.getByTestId("tenant-row").filter({ hasText: "Northwind" }).first().getByRole("link").first().click();
  await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);
  await noSideScroll(page, "tenant detail");
});

test("console lists are cards and their filters live in a bottom sheet", async ({ page }) => {
  await login(page, SUPER_ADMIN);
  await page.goto("/admin/tenants");
  const row = page.getByTestId("tenant-row").first();
  await expect(row).toBeVisible();
  await expect(page.locator("main thead").first()).toBeHidden();
  // a column hidden on phones before (plan, MRR, last login) is on the card
  await expect(row.locator("td[data-label]").first()).toBeVisible();
  // the filter form is behind the button and opens as a sheet
  await expect(page.locator("#t-plan")).toBeHidden();
  await page.getByTestId("filters-open").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(viewport.height - 2);
  await sheet.locator("#t-plan").selectOption("growth");
  // the form's own button is for wide screens: "Show results" applies the filters
  await expect(sheet.getByRole("button", { name: /^Filter$|^Filtra$/ })).toBeHidden();
  await page.getByTestId("filters-done").click();
  await expect(page).toHaveURL(/plan=growth/);
  await expect(page.getByTestId("filters-count")).toHaveText("1");
  await page.getByTestId("chip-plan").click();
  await expect(page).not.toHaveURL(/plan=/);
  // the header row's sort links are in the sheet
  await page.getByTestId("filters-open").click();
  await page.getByTestId("sort-option-mrr").click();
  await expect(page).toHaveURL(/sort=mrr/);
  await expect(page.getByTestId("sort-option-mrr")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("filters-done").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await noSideScroll(page, "tenants sorted");
  // the other lists are cards too
  for (const [path, testId] of [["/admin/billing", "invoice-row"], ["/admin/users", "user-row"], ["/admin/jobs", "job-run-row"], ["/admin/audit", "audit-row"], ["/admin/email", "email-row"]] as const) {
    await page.goto(path);
    const first = page.getByTestId(testId).first();
    if ((await first.count()) === 0) continue;
    await expect(first, path).toBeVisible();
    expect(await first.evaluate((el) => getComputedStyle(el).display), path).toBe("flex");
  }
});

test("console primary actions stay within reach on a phone", async ({ page }) => {
  await login(page, SUPER_ADMIN);
  // the new-tenant form docks its submit at the bottom of the screen
  await page.goto("/admin/tenants/new");
  await expect(page.locator("[data-sticky-actions]").getByTestId("new-tenant-submit")).toBeInViewport();
  // tenant list: "Open as support" is a full-width button on each card
  await page.goto("/admin/tenants");
  const support = page.getByTestId("tenant-row").first().getByRole("button", { name: /Open as support|Apri come supporto/ });
  await expect(support).toBeVisible();
  const vw = page.viewportSize()!.width;
  const b = (await support.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(vw);
  // tenant detail: lifecycle and add-on switches are reachable
  await page.getByTestId("tenant-row").first().getByRole("link").first().click();
  await expect(page.getByTestId("change-lifecycle").or(page.getByRole("button", { name: /Open as support|Apri come supporto/ })).first()).toBeVisible();
  const toggle = page.locator('[data-testid^="addon-addon."]').first();
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport();
  // billing: an invoice's actions are on its card
  await page.goto("/admin/billing?status=open");
  const invoice = page.getByTestId("invoice-row").first();
  if ((await invoice.count()) > 0) await expect(invoice.getByRole("button").first()).toBeVisible();
});
