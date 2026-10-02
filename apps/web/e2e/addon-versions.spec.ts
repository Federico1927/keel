import { expect, test } from "@playwright/test";
import { login } from "./helpers";

// #77: only a released version can be switched on; the console shows the current version and the work in progress
test("add-on versions: COD v1 can be switched on, customer campaigns (v1 in development) cannot", async ({ page }) => {
  await login(page, "superadmin@hullwise.demo");
  await page.goto("/admin/tenants");
  await page.getByTestId("tenant-row").filter({ hasText: "Harbor Home" }).getByRole("link", { name: "Harbor Home" }).click();
  await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);

  await expect(page.getByTestId("addon-version-addon.cod-1")).toBeVisible();
  await expect(page.getByTestId("addon-version-addon.cod-2")).toBeVisible();
  await expect(page.getByTestId("addon-addon.cod")).toBeEnabled();

  const campaigns = page.getByTestId("addon-addon.customer_campaigns");
  await expect(page.getByTestId("addon-version-addon.customer_campaigns-1")).toBeVisible();
  await expect(campaigns).toHaveAttribute("data-state", "unchecked");
  await expect(campaigns).toBeDisabled();
  await expect(page.getByTestId("addon-locked-addon.customer_campaigns")).toBeVisible();

  await page.goto("/admin/plans");
  await expect(page.getByTestId("addon-row").filter({ hasText: "addon.customer_campaigns" })).toContainText(/v1/);
});
