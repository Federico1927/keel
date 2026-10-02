import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("super-admin console", () => {
  test("dashboard, tenants, add-on toggle gates the tenant page, billing and impersonation are audited", async ({ page, browser }) => {
    await login(page, "superadmin@keel.demo");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText("MRR").first()).toBeVisible();
    await page.goto("/admin/tenants");
    const rows = page.getByTestId("tenant-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    await rows.filter({ hasText: "Northwind Apparel" }).getByRole("link", { name: "Northwind Apparel" }).click();
    await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("checklist")).toContainText(/Shopify/);

    // disable the COD add-on → the owner loses the page even by URL; re-enable afterwards
    const toggle = page.getByTestId("addon-addon.cod");
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await login(owner, "owner@northwind.demo");
    const res = await owner.goto("/t/northwind-apparel/cod");
    expect(res?.status()).toBe(404);
    await owner.goto("/t/northwind-apparel");
    await expect(owner.locator("nav").first()).not.toContainText(/COD queue|Coda contrassegno/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await owner.goto("/t/northwind-apparel");
    await expect(owner.locator("nav").first()).toContainText(/COD queue|Coda contrassegno/);
    await ownerCtx.close();

    // billing: an open invoice (the seed leaves one for Harbor Home) can be marked paid
    await page.goto("/admin/billing?status=open");
    const openRows = page.getByTestId("invoice-row");
    if ((await openRows.count()) > 0) {
      // invoice numbers repeat across tenants: identify the row by number and tenant
      const number = (await openRows.first().locator("td").nth(0).textContent())!.trim();
      const tenantCell = (await openRows.first().locator("td").nth(1).textContent())!.trim();
      const rowOf = () => page.getByTestId("invoice-row").filter({ hasText: number }).filter({ hasText: tenantCell.split("\n")[0]!.trim() });
      await openRows.first().getByRole("button", { name: /Mark paid|Segna pagata/ }).click();
      await expect(rowOf()).toHaveCount(0);
      await page.goto("/admin/billing?status=paid");
      await expect(rowOf()).toHaveCount(1);
    }

    // impersonation: open as support shows the banner, and the audit log records it
    await page.goto("/admin/tenants");
    await page.getByTestId("tenant-row").filter({ hasText: "Harbor Home" }).getByRole("button", { name: /Open as support|Apri come supporto/ }).click();
    await expect(page).toHaveURL(/\/t\/harbor-home/);
    await expect(page.getByText(/viewing Harbor Home as a super-admin|stai vedendo Harbor Home/i)).toBeVisible();
    await page.goto("/admin/audit?action=impersonation");
    await expect(page.getByTestId("audit-row").first()).toContainText("impersonation.started");
  });

  test("creates a tenant with a checklist and a setup invoice", async ({ page }) => {
    await login(page, "superadmin@keel.demo");
    await page.goto("/admin/tenants/new");
    const stamp = Date.now().toString().slice(-6);
    await page.getByLabel(/Company name|Nome azienda/).fill(`E2E Shop ${stamp}`);
    await page.getByLabel(/Country/).fill("IT");
    await page.getByLabel(/Currency|Valuta/).fill("EUR");
    await page.getByLabel(/Timezone|Fuso/).fill("Europe/Rome");
    await page.getByLabel(/Owner email|Email owner/).fill(`owner-${stamp}@e2e.test`);
    await page.getByLabel(/Owner name|Nome owner/).fill("E2E Owner");
    await page.getByRole("button", { name: /Create tenant|Crea tenant/ }).click();
    await expect(page.getByTestId("owner-invited")).toBeVisible();
    await page.getByRole("button", { name: /Open setup checklist|Apri la checklist/ }).click();
    await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("checklist")).toContainText(/[234] of 9|[234] su 9/);
    await expect(page.getByTestId("invoice-row").first()).toContainText(/Setup fee|Fee di attivazione/);
  });

  test("tenant users get a 404 on the console", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(404);
  });
});
