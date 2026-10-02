import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Platform reliability (#32): dashboard widget, owner data export, audit filters, console job runs and failure alerts. */
test.describe("reliability", () => {
  test("owner: integration widget, full data export with download, audit filtered by record type", async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel");
    const widget = page.getByTestId("source-health-widget");
    await expect(widget).toBeVisible();
    expect(Number(await widget.getAttribute("data-problems"))).toBeGreaterThanOrEqual(1);
    await expect(widget).toContainText("google");

    await page.goto("/t/northwind-apparel/settings");
    await page.getByTestId("data-export-link").click();
    await expect(page).toHaveURL(/\/settings\/data-export$/);
    await expect(page.locator('[data-testid="data-export-row"][data-status="expired"]').first()).toBeVisible();
    await page.getByTestId("request-data-export").click();
    const ready = page.locator('[data-testid="data-export-row"][data-status="done"]').first();
    await expect(ready).toBeVisible({ timeout: 150_000 });
    const href = await ready.getByTestId("data-export-download").getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/zip");
    expect((await res.body()).subarray(0, 2).toString()).toBe("PK");

    await page.goto("/t/northwind-apparel/audit?entity_type=tenant_data_export");
    await expect(page.getByTestId("audit-filters")).toBeVisible();
    const rows = page.getByTestId("audit-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: "tenant.data_export_downloaded" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "order." })).toHaveCount(0);
  });

  test("the data export is for the owner only", async ({ page }) => {
    await login(page, "admin@northwind.demo");
    await page.goto("/t/northwind-apparel/settings");
    await expect(page.getByTestId("data-export-link")).toHaveCount(0);
    const res = await page.goto("/t/northwind-apparel/settings/data-export");
    expect(res?.status()).toBe(404);
  });

  test("super-admin: job runs with run now, failure alerts, tenant data export card", async ({ page }) => {
    await login(page, "superadmin@keel.demo");
    await page.goto("/admin/alerts");
    const open = page.locator('[data-testid="alert-row"][data-status="open"]');
    await expect(open.filter({ hasText: "Coral Beauty" }).first()).toBeVisible();
    const before = await open.count();
    await open.filter({ hasText: "sync.ads:meta" }).first().getByTestId("close-alert").click();
    await expect(open).toHaveCount(before - 1);
    await page.goto("/admin/alerts?status=resolved");
    await expect(page.locator('[data-testid="alert-row"][data-status="resolved"]').filter({ hasText: "sync.ads:meta" }).first()).toBeVisible();

    await page.goto("/admin/jobs");
    await expect(page.getByTestId("admin-nav-operations").getByRole("link", { name: /job runs/i })).toBeVisible();
    await expect(page.locator('[data-testid="job-latest-row"][data-job="tick:watchdog"]')).toBeVisible();
    await expect(page.locator('[data-testid="job-latest-row"][data-job="sync.ads:meta"]').first()).toBeVisible();
    // a harmless tick (email housekeeping): run inline without a worker, recorded with the super-admin
    const emails = page.locator('[data-testid="job-latest-row"][data-job="tick:emails"]');
    await emails.getByTestId("run-now").click();
    await expect(emails.getByRole("status")).toBeVisible();
    await expect(async () => {
      await page.goto("/admin/jobs?type=tick:emails&tenant=platform");
      await expect(page.getByTestId("job-run-row").filter({ hasText: /run now/i }).first()).toBeVisible();
    }).toPass({ timeout: 30_000 });

    await page.goto("/admin/tenants?q=harbor");
    await page.locator('[data-testid="tenant-row"] a[href^="/admin/tenants/"]').first().click();
    const card = page.getByTestId("tenant-data-export");
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid="data-export-row"][data-status="expired"]')).toHaveCount(1);
  });
});
