import type { Page } from "@playwright/test";

export const DEMO_PASSWORD = "hullwise-demo-2026";

export async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
  await page.waitForURL(/\/t\/|\/admin/);
}
