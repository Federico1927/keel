import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reuse a preinstalled Chromium when PW_CHROMIUM_PATH (or the cloud default) exists. */
const chromiumPath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const launchOptions = existsSync(chromiumPath) ? { executablePath: chromiumPath } : {};

/**
 * Where the server's mock email provider writes what it captures (#52): the account spec reads
 * invitation and reset links from there. With E2E_NO_SERVER, start the server with the same variable.
 */
process.env.HULLWISE_EMAIL_OUTBOX_DIR ??= join(tmpdir(), "hullwise-e2e-outbox");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The console spec toggles add-ons and billing for the demo tenants: it runs after everything else.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions }, testIgnore: /admin\.spec\.ts/ },
    { name: "admin", use: { ...devices["Desktop Chrome"], launchOptions }, testMatch: /admin\.spec\.ts/, dependencies: ["chromium"] },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm start",
        url: "http://localhost:3000/login",
        reuseExistingServer: true,
        env: { HULLWISE_EMAIL_OUTBOX_DIR: process.env.HULLWISE_EMAIL_OUTBOX_DIR },
        timeout: 120_000,
      },
});
