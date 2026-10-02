import { expect, test } from "@playwright/test";
import { DEMO_PASSWORD, login } from "./helpers";

test.describe("super-admin console", () => {
  test("dashboard, tenants, add-on toggle gates the tenant page, billing and impersonation are audited", async ({ page, browser }) => {
    await login(page, "superadmin@hullwise.demo");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText("MRR").first()).toBeVisible();
    await page.goto("/admin/tenants");
    const rows = page.getByTestId("tenant-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    await rows.filter({ hasText: "Northwind Apparel" }).getByRole("link", { name: "Northwind Apparel" }).click();
    await expect(page).toHaveURL(/\/admin\/tenants\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("checklist")).toContainText(/Shopify/);
    await expect(page.getByTestId("onboarding-runbook")).toHaveAttribute("href", /\/docs\/ONBOARDING(\.it)?\.md$/);

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
    await login(page, "superadmin@hullwise.demo");
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
    await expect(page.getByTestId("checklist")).toContainText(/[234] of 10|[234] su 10/);
    await expect(page.getByTestId("invoice-row").first()).toContainText(/Setup fee|Fee di attivazione/);
  });

  test("platform mode: violet accent, Platform label and the grouped navigation", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await expect(page.getByTestId("platform-mode")).toBeVisible();
    await expect(page.getByTestId("platform-label")).toHaveText(/Platform|Piattaforma|Plataforma/);
    for (const g of ["overview", "tenants", "users", "billing", "operations", "support", "audit"]) await expect(page.getByTestId(`admin-nav-${g}`)).toBeAttached();
    // a tenant page never shows the console accent
    await page.goto("/admin/tenants");
    await page.getByTestId("tenant-row").filter({ hasText: "Northwind Apparel" }).getByRole("button", { name: /Open as support|Apri come supporto/ }).click();
    await expect(page).toHaveURL(/\/t\/northwind-apparel/);
    await expect(page.getByTestId("platform-mode")).toHaveCount(0);
    await expect(page.getByTestId("impersonation-banner")).toBeVisible();
    await page.getByTestId("exit-impersonation").click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  test("finds a user by email in under 3 clicks and disables them; audited; the person cannot sign in until enabled", async ({ page, browser }) => {
    const email = "care2@northwind.demo";
    await login(page, "superadmin@hullwise.demo");
    // typing in the dashboard search and pressing Enter, then one click on the result
    await page.getByTestId("dashboard-user-search").fill(email);
    await page.getByTestId("dashboard-user-search").press("Enter");
    await expect(page).toHaveURL(/\/admin\/users\?q=/);
    const row = page.getByTestId("user-row").filter({ hasText: email });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Northwind Apparel/);
    await row.getByRole("link").first().click(); // click 1
    await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]{36}$/);
    await page.getByTestId("disable-user").click(); // click 2
    await page.getByLabel(/Reason|Motivo/).fill("E2E: left the team");
    await page.getByTestId("confirm-disable").click();
    await expect(page.getByTestId("user-status")).toHaveText(/Disabled|Disattivato|Desactivado/);
    await expect(page.getByTestId("user-disabled-alert")).toContainText("E2E: left the team");
    await page.goto("/admin/audit?action=user.disabled");
    await expect(page.getByTestId("audit-row").first()).toContainText("user.disabled");
    await expect(page.getByTestId("audit-row").first()).toContainText("superadmin@hullwise.demo");

    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(DEMO_PASSWORD);
    await p.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
    await expect(p.getByText(/Email or password is incorrect|Email o password|incorrect/i)).toBeVisible();
    await expect(p).toHaveURL(/\/login/);

    await page.goBack();
    await page.goto("/admin/users?q=" + encodeURIComponent(email));
    await page.getByTestId("user-row").filter({ hasText: email }).getByRole("link").first().click();
    await page.getByTestId("enable-user").click();
    await page.getByTestId("confirm-disable").click();
    await expect(page.getByTestId("user-status")).toHaveText(/Active|Attivo|Activo/);
    await login(p, email);
    await expect(p).toHaveURL(/\/t\/northwind-apparel/);
    await ctx.close();
  });

  test("impersonation shows the banner on every tenant page and Exit returns to /admin (audited)", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants?q=harbor");
    await page.getByTestId("tenant-row").filter({ hasText: "Harbor Home" }).getByRole("button", { name: /Open as support|Apri come supporto/ }).click();
    await expect(page).toHaveURL(/\/t\/harbor-home/);
    for (const path of ["", "/orders", "/products", "/customers", "/analytics", "/settings", "/integrations", "/users"]) {
      await page.goto(`/t/harbor-home${path}`);
      const banner = page.getByTestId("impersonation-banner");
      await expect(banner, path || "/").toBeVisible();
      await expect(banner).toContainText("Harbor Home");
      await expect(banner.getByTestId("exit-impersonation")).toBeVisible();
    }
    await page.getByTestId("exit-impersonation").click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto("/admin/audit?action=impersonation.ended");
    await expect(page.getByTestId("audit-row").first()).toContainText("impersonation.ended");
    await expect(page.getByTestId("audit-row").first()).toContainText("Harbor Home");
  });

  test("moving a tenant to suspended blocks its users with the reason recorded; reactivating restores access", async ({ page, browser }) => {
    await login(page, "superadmin@hullwise.demo");
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    await login(owner, "owner@harborhome.demo");
    await expect(owner).toHaveURL(/\/t\/harbor-home/);

    await page.goto("/admin/tenants?q=harbor");
    await page.getByTestId("tenant-row").filter({ hasText: "Harbor Home" }).getByRole("link", { name: "Harbor Home" }).click();
    const change = async (to: string, reason: string, note: string) => {
      await page.getByTestId("change-lifecycle").click();
      await page.getByTestId("lifecycle-to").selectOption(to);
      await page.getByTestId("lifecycle-reason").selectOption(reason);
      await page.getByTestId("lifecycle-note").fill(note);
      await page.getByTestId("confirm-lifecycle").click();
      await expect(page.getByTestId("lifecycle-card").getByTestId("lifecycle-status")).toHaveAttribute("data-status", to);
    };
    await change("suspended", "unpaid_invoice", "E2E: three reminders without answer");
    await expect(page.getByTestId("lifecycle-blocked")).toBeVisible();
    await expect(page.getByTestId("lifecycle-reason-current")).toContainText("E2E: three reminders without answer");
    await expect(page.getByTestId("lifecycle-history")).toContainText(/Unpaid invoice|Fattura non pagata/);

    await owner.goto("/t/harbor-home/orders");
    await expect(owner).toHaveURL(/\/suspended\?tenant=harbor-home&reason=payment/);
    await expect(owner.getByTestId("suspended")).toBeVisible();

    await page.goto("/admin/audit?action=tenant.suspended");
    await expect(page.getByTestId("audit-row").first()).toContainText("Harbor Home");
    await page.goBack();
    await change("active", "payment_recovered", "E2E: paid by bank transfer");
    await owner.goto("/t/harbor-home/orders");
    await expect(owner).toHaveURL(/\/t\/harbor-home\/orders/);
    await ownerCtx.close();
  });

  test("console tables keep filters and sort in the URL and export them as CSV; metrics link to their tenants", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/tenants?status=churned&sort=name&dir=desc");
    const slugs = await page.getByTestId("tenant-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-slug")));
    expect(slugs).toEqual(["maple-kids", "fjord-home"]);
    await page.getByTestId("sort-name").click();
    await expect(page).toHaveURL(/dir=asc/);
    await expect(page).toHaveURL(/status=churned/);
    const exportHref = await page.getByTestId("export-tenants").getAttribute("href");
    expect(exportHref).toContain("status=churned");
    const csv = await page.request.get(exportHref!);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const body = await csv.text();
    expect(body).toContain("maple-kids");
    expect(body).not.toContain("northwind-apparel");
    await page.goto("/admin/tenants?attention=1");
    await expect(page.getByTestId("tenant-row").filter({ hasText: "Coral Beauty" })).toHaveCount(1);
    await page.goto("/admin/billing?q=delta&status=open");
    await expect(page.getByTestId("invoice-row").first()).toContainText("Delta Gear");
    const inv = await page.request.get((await page.getByTestId("export-invoices").getAttribute("href"))!);
    expect(await inv.text()).toContain("delta-gear");
    await page.goto("/admin/metrics");
    const month = new Date().toISOString().slice(0, 7);
    await page.getByTestId(`metric-active-${month}`).click();
    await expect(page.getByTestId("metrics-drilldown")).toContainText("Northwind Apparel");
    await page.goto("/admin/plans");
    await expect(page.getByTestId("plan-growth")).toContainText(/tenant/);
  });

  test("tenant users get a 404 on the console", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(404);
  });
});
