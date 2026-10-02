import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const T = "/t/northwind-apparel";

test.describe("notifications, tasks and support", () => {
  test("notifications page filters, toggles read state and opens the inbox from the bell", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(T);
    await page.getByRole("button", { name: /^Notifications$|^Notifiche$/ }).click();
    await page.getByTestId("bell-view-all").click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByTestId("notification-row").first()).toBeVisible();
    await page.getByTestId("type-stock_critical_no_po").click();
    await expect(page).toHaveURL(/type=stock_critical_no_po/);
    const row = page.getByTestId("notification-row").first();
    await expect(row).toContainText(/critical stock|stock critico/i);
    const toggle = row.getByTestId("read-toggle");
    const before = await toggle.getAttribute("aria-label");
    await toggle.click();
    await expect(page.getByTestId("notification-row").first().getByTestId("read-toggle")).not.toHaveAttribute("aria-label", before ?? "");
  });

  test("preferences are saved per type and channel", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/notifications/preferences`);
    const cell = page.getByTestId("pref-mention-email");
    const was = await cell.getAttribute("aria-checked");
    await cell.click();
    await expect(cell).toHaveAttribute("aria-checked", was === "true" ? "false" : "true");
    await page.reload();
    await expect(page.getByTestId("pref-mention-email")).toHaveAttribute("aria-checked", was === "true" ? "false" : "true");
    // digest is email only
    await expect(page.getByTestId("pref-digest-in_app")).toHaveCount(0);
    await page.getByTestId("pref-mention-email").click();
    await expect(page.getByTestId("pref-mention-email")).toHaveAttribute("aria-checked", was ?? "false");
  });

  test("my mentions lists notes on purchase orders and orders", async ({ page }) => {
    await login(page, "ops@northwind.demo");
    await page.goto(`${T}/notifications/mentions`);
    await expect(page.getByTestId("mention-row").first()).toBeVisible();
    await page.getByRole("link", { name: /Purchase orders|Ordini d'acquisto/ }).click();
    await expect(page).toHaveURL(/entity=purchase_order/);
    await expect(page.getByTestId("mention-row").first()).toBeVisible();
  });

  test("tasks: my tasks, rules, and the tasks panel on a return opened by the inspection rule", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(`${T}/tasks/rules`);
    await expect(page.getByTestId("task-rule")).toHaveCount(3);
    await page.goto(`${T}/tasks?scope=all&entity=return`);
    const row = page.getByTestId("task-row").first();
    await expect(row).toContainText(/Ispeziona|Inspect/);
    await row.getByRole("link", { name: /R-\d+/ }).click();
    await expect(page).toHaveURL(/\/returns\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("record-tasks").getByTestId("record-task").first()).toContainText(/Ispeziona|Inspect/);
    await expect(page.getByTestId("record-notes")).toBeVisible();

    // a manual task on a product, then done
    await page.goto(`${T}/products`);
    await page.locator("table tbody tr td a").first().click();
    const panel = page.getByTestId("record-tasks");
    await panel.getByTestId("new-task").click();
    const title = `E2E task ${Date.now()}`;
    await page.getByRole("dialog").getByLabel(/Title|Titolo/).fill(title);
    await page.getByRole("dialog").getByRole("button", { name: /Create task|Crea attività/ }).click();
    const task = panel.getByTestId("record-task").filter({ hasText: title });
    await expect(task).toBeVisible();
    await task.getByTestId("task-done").click();
    await expect(task.getByTestId("record-task-status")).toHaveText(/Done|Completata/);
  });

  test("support: opened from the header with an attachment, answered in the console", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto(T);
    await page.getByTestId("support-button").click();
    const subject = `E2E support ${Date.now()}`;
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Subject|Oggetto/).fill(subject);
    await dialog.getByLabel(/^Message$|^Messaggio$/).fill("The stock export differs from the warehouse.");
    await dialog.locator('input[type="file"]').setInputFiles({ name: "diff.csv", mimeType: "text/csv", buffer: Buffer.from("sku,a,b\nX,1,2\n") });
    await dialog.getByRole("button", { name: /^Send$|^Invia$/ }).click();
    await dialog.getByTestId("support-sent-link").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(subject);
    await expect(page.getByTestId("support-message")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "diff.csv" })).toBeVisible();
    const ticketUrl = page.url();

    await page.context().clearCookies();
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/support?status=open");
    await page.getByRole("link", { name: new RegExp(subject) }).click();
    await page.getByLabel(/^Reply$|^Rispondi$/).fill("Thanks, we are looking into it.");
    await page.getByRole("button", { name: /Send reply|Invia risposta/ }).click();
    await expect(page.getByTestId("support-message")).toHaveCount(2);
    await expect(page.getByTestId("ticket-status")).toHaveText(/Answered|Risposta ricevuta/);

    await page.context().clearCookies();
    await login(page, "owner@northwind.demo");
    await page.goto(ticketUrl);
    await expect(page.getByTestId("support-message")).toHaveCount(2);
    await page.goto(`${T}/notifications?type=support_reply`);
    await expect(page.getByTestId("notification-row").first()).toContainText(subject);
  });

  test("an invalid unsubscribe link says so without signing in", async ({ page }) => {
    await page.goto("/u/not-a-token");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Link not valid|Link non valido|Enlace no válido/);
  });
});
