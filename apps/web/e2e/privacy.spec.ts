import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Privacy requests (GDPR): a customer's data package and erasure from the customer page (owner; erasure
 * also admin, nobody else), the console's erasure by email, and the deletion of a whole tenant from the
 * console's danger zone (on a tenant created for the test, never a demo one).
 */

/** Opens the first customer from the n-th row of the list that still has an email (reruns skip those already erased), returns the email. */
async function openCustomer(page: Page, slug: string, n: number): Promise<string> {
  for (let i = n; i < n + 15; i++) {
    await page.goto(`/t/${slug}/customers`);
    await page.getByTestId("customer-row").nth(i).locator("a").first().click();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/customers/[0-9a-f-]{36}$`));
    const mail = page.locator('a[href^="mailto:"]').first();
    if (await mail.count()) return (await mail.textContent())!.trim();
  }
  throw new Error("no customer with an email left in the rows tried");
}

test.describe("privacy requests", () => {
  test("an owner exports a customer's data package and erases them after typing their email", async ({ page }) => {
    await login(page, "owner@harborhome.demo");
    const email = await openCustomer(page, "harbor-home", 17);
    const card = page.getByTestId("customer-privacy");
    await expect(card).toBeVisible();

    // data package: built after the response (no worker in the test server), then downloadable
    await card.getByTestId("customer-export").click();
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("customer-export-download").first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    const href = await page.getByTestId("customer-export-download").first().getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/zip");

    // erasure: the confirm button waits for the exact email
    await page.getByTestId("erase-customer").click();
    const confirm = page.getByTestId("erase-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("erase-confirm-input").fill("someone@else.test");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("erase-confirm-input").fill(email.toUpperCase());
    await confirm.click();
    await expect(page.getByTestId("erase-result")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("customer-erased")).toBeVisible();
    await expect(page.locator(`a[href="mailto:${email}"]`)).toHaveCount(0);
    // the audit log records it
    await page.goto("/t/harbor-home/audit?action=customer.redacted");
    await expect(page.getByText("customer.redacted").first()).toBeVisible();
  });

  test("customer care sees neither the export nor the erasure", async ({ page }) => {
    await login(page, "care@harborhome.demo");
    await openCustomer(page, "harbor-home", 3);
    await expect(page.getByTestId("customer-privacy")).toHaveCount(0);
    await expect(page.getByTestId("erase-customer")).toHaveCount(0);
  });

  test("the super-admin erases a customer of a store from the console", async ({ page, browser }) => {
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await login(owner, "owner@harborhome.demo");
    const email = await openCustomer(owner, "harbor-home", 23);
    await ownerCtx.close();

    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants?q=harbor");
    await page.locator('[data-testid="tenant-row"] a[href^="/admin/tenants/"]').first().click();
    const box = page.getByTestId("tenant-privacy");
    await box.getByTestId("admin-erase-email").fill("nobody@nowhere.test");
    await box.getByTestId("admin-erase-find").click();
    await expect(box.getByTestId("admin-erase-none")).toBeVisible();
    await box.getByTestId("admin-erase-email").fill(email);
    await box.getByTestId("admin-erase-find").click();
    await expect(box.getByTestId("admin-erase-candidate")).toHaveCount(1);
    await box.getByTestId("erase-customer").click();
    await page.getByTestId("erase-confirm-input").fill(email);
    await page.getByTestId("erase-confirm").click();
    await expect(page.getByTestId("erase-result")).toBeVisible();
    // the same email finds nothing any more
    await box.getByTestId("admin-erase-find").click();
    await expect(box.getByTestId("admin-erase-none")).toBeVisible();
  });

  test("the console deletes a tenant: typed slug, no-export confirmation, progress, then gone", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants/new");
    const stamp = Date.now().toString().slice(-6);
    await page.getByLabel(/Company name|Nome azienda/).fill(`Leaving Shop ${stamp}`);
    await page.getByLabel(/Country/).fill("DE");
    await page.getByLabel(/Currency|Valuta/).fill("EUR");
    await page.getByLabel(/Timezone|Fuso/).fill("Europe/Berlin");
    await page.getByLabel(/Owner email|Email owner/).fill(`owner-leaving-${stamp}@e2e.test`);
    await page.getByLabel(/Owner name|Nome owner/).fill("Leaving Owner");
    await page.getByRole("button", { name: /Create tenant|Crea tenant/ }).click();
    await expect(page.getByTestId("owner-invited")).toBeVisible();

    await page.goto(`/admin/tenants?q=leaving-shop-${stamp}`);
    await page.locator('[data-testid="tenant-row"] a[href^="/admin/tenants/"]').first().click();
    await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);
    const tenantUrl = page.url();
    await page.getByTestId("delete-tenant-link").click();
    await expect(page).toHaveURL(/\/delete$/);
    await expect(page.getByTestId("delete-count-row").first()).toBeVisible();
    await expect(page.getByTestId("delete-demo-warning")).toHaveCount(0);
    const submit = page.getByTestId("delete-tenant");
    await expect(submit).toBeDisabled();
    await page.getByTestId("delete-slug").fill(`leaving-shop-${stamp}`);
    await expect(submit).toBeDisabled();
    await page.getByTestId("delete-without-export").click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId("deletion-status")).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(page.getByTestId("deletion-done")).toBeVisible();
    const gone = await page.goto(tenantUrl);
    expect(gone?.status()).toBe(404);
    // the platform audit log keeps the record
    await page.goto("/admin/audit?action=tenant.deleted&tenant=platform");
    await expect(page.getByRole("cell", { name: "tenant.deleted" }).first()).toBeVisible();
  });

  test("a demo tenant's deletion page asks for the extra confirmation", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants?q=harbor");
    await page.locator('[data-testid="tenant-row"] a[href^="/admin/tenants/"]').first().click();
    await page.getByTestId("delete-tenant-link").click();
    await expect(page.getByTestId("delete-demo-warning")).toBeVisible();
    await page.getByTestId("delete-slug").fill("harbor-home");
    await page.getByTestId("delete-without-export").click();
    await expect(page.getByTestId("delete-tenant")).toBeDisabled();
    await expect(page.getByTestId("delete-confirm-demo")).toBeVisible();
  });
});
