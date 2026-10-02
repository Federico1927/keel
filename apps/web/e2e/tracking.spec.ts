import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("tracking: first-party pixel and server-side conversions", () => {
  test("the public collect endpoint accepts beacons, refuses unknown keys and junk, and serves the script", async ({ request }) => {
    const body = JSON.stringify({ events: [{ event: "page_view", anonymousId: `e2e${Date.now()}`, sessionId: `e2es${Date.now()}`, url: "https://northwind-apparel.example/?utm_source=facebook&fbclid=E2E1" }] });
    const ok = await request.post("/api/px/px_northwindDemoKey01", { data: body, headers: { "content-type": "text/plain", origin: "https://northwind-apparel.example" } });
    expect(ok.status()).toBe(204);
    expect(ok.headers()["access-control-allow-origin"]).toBe("https://northwind-apparel.example");
    expect((await request.post("/api/px/px_doesNotExist0000", { data: body, headers: { "content-type": "text/plain" } })).status()).toBe(404);
    expect((await request.post("/api/px/px_northwindDemoKey01", { data: "{not json", headers: { "content-type": "text/plain" } })).status()).toBe(400);
    const script = await request.get("/api/px/px_northwindDemoKey01/script.js");
    expect(script.status()).toBe(200);
    expect(await script.text()).toContain("/api/px/px_northwindDemoKey01");
  });

  test("the owner sees pixel health, the snippets, conversion settings and the delivery log", async ({ page }) => {
    await login(page, "owner@northwind.demo");
    await page.goto("/t/northwind-apparel/integrations");
    await page.getByTestId("tracking-link").click();
    await expect(page).toHaveURL(/\/integrations\/tracking$/);
    await expect(page.getByTestId("pixel-shopify")).toContainText("analytics.subscribe");
    await expect(page.getByTestId("pixel-script")).toContainText("/api/px/px_northwindDemoKey01/script.js");
    await expect(page.getByTestId("conversion-row").first()).toBeVisible();
    await expect(page.getByTestId("conversions-stats-meta")).toContainText(/[1-9]\d* (sent|inviati)/);
    await page.getByTestId("pixel-test").click();
    await expect(page.getByTestId("pixel-stats")).toBeVisible();
    await page.getByTestId("conversions-run").click();
    await expect(page.getByTestId("conversion-row").first()).toBeVisible();
    await page.goto("/t/northwind-apparel/integrations/guide/tracking");
    await expect(page.getByTestId("guide-step")).toHaveCount(9);
  });
});
