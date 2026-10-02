import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("platform email", () => {
  test("console: 'not configured' without a Resend key, counts, log filters and a test email through the queue", async ({ page }) => {
    await login(page, "superadmin@hullwise.demo");
    await page.goto("/admin/email");
    // the e2e build runs without RESEND_API_KEY: the mock captures emails and the console says so
    await expect(page.getByTestId("email-not-configured")).toBeVisible();
    await expect(page.getByTestId("email-provider-state")).toHaveText(/Email not configured|Email non configurata|Email no configurado/);
    await expect(page.getByTestId("email-stats")).toBeVisible();
    expect(await page.getByTestId("email-row").count()).toBeGreaterThan(0);
    // log rows never show a full address
    await expect(page.getByTestId("email-row").first()).toContainText("•••");

    // filter: platform sign-in links only
    await page.goto("/admin/email?template=magic_link&tenant=platform");
    const rows = page.getByTestId("email-row");
    expect(await rows.count()).toBeGreaterThan(0);
    for (const text of await rows.allTextContents()) expect(text).toMatch(/Sign-in link|Link di accesso|Enlace de acceso/);

    // test email: queued, then delivered by the mock after the response
    const to = `e2e-${Date.now()}@example.com`;
    await page.goto("/admin/email");
    await page.locator("#test-to").fill(to);
    await page.getByTestId("send-test-email").click();
    await expect(page.getByTestId("test-email-result")).toContainText(to);
    await expect(async () => {
      await page.goto(`/admin/email?recipient=${encodeURIComponent(to)}`);
      await expect(page.getByTestId("email-row")).toHaveCount(1);
      await expect(page.getByTestId("email-row").first()).toContainText(/Sent|Inviata|Enviado/);
    }).toPass({ timeout: 15_000 });
    await expect(page.getByTestId("email-row").first()).toContainText("e2•••@ex•••.com");

    // the setup guide is part of the page
    await page.getByText(/Setup guide|Guida alla configurazione|Guía de configuración/).click();
    expect(await page.getByTestId("email-guide-step").count()).toBeGreaterThanOrEqual(8);
  });

  test("the console page and the email guide are not reachable by tenant users; the dev inbox does not exist in production", async ({ page, request }) => {
    expect((await request.get("/dev/emails")).status()).toBe(404);
    await login(page, "owner@northwind.demo");
    expect((await page.goto("/admin/email"))?.status()).toBe(404);
    expect((await page.goto("/t/northwind-apparel/integrations/guide/email"))?.status()).toBe(404);
    await page.goto("/t/northwind-apparel/integrations/guide/shopify");
    await expect(page.getByRole("link", { name: /Platform email|Email di piattaforma|Email de plataforma/ })).toHaveCount(0);
  });

  test("the provider webhook refuses unsigned events", async ({ request }) => {
    const res = await request.post("/api/webhooks/email", { data: { type: "email.bounced", data: { email_id: "x", to: ["a@example.com"] } } });
    // 503 without RESEND_WEBHOOK_SECRET (this build), 401 with a secret and no valid signature
    expect([401, 503]).toContain(res.status());
  });
});
