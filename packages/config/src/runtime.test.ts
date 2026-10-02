import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRuntimeConfig, DEV_DEFAULT_SECRETS } from "./runtime";

const db = { DATABASE_URL: "postgres://app", DATABASE_ADMIN_URL: "postgres://admin" };
const secrets = { AUTH_SECRET: "a-real-secret", APP_ENCRYPTION_KEY: "a-real-key" };

describe("checkRuntimeConfig", () => {
  it("knows the development secrets that .env.example ships", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    for (const [name, value] of Object.entries(DEV_DEFAULT_SECRETS)) expect(example).toContain(`${name}=${value}\n`);
  });

  it("accepts a mock demo with development secrets, with warnings only", () => {
    const r = checkRuntimeConfig({ ...db, ...DEV_DEFAULT_SECRETS }, "web");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });

  it("checks the previous encryption key of a rotation and reminds to remove it", () => {
    const key = (n: number) => Buffer.alloc(32, n).toString("base64");
    const base = { ...db, AUTH_SECRET: "a-real-secret", APP_ENCRYPTION_KEY: key(1) };
    expect(checkRuntimeConfig({ ...base, APP_ENCRYPTION_KEY_PREVIOUS: "short" }, "web").errors).toEqual(["APP_ENCRYPTION_KEY_PREVIOUS must decode to 32 bytes (base64), like APP_ENCRYPTION_KEY."]);
    const rotating = checkRuntimeConfig({ ...base, APP_ENCRYPTION_KEY_PREVIOUS: key(2) }, "web");
    expect(rotating.errors).toEqual([]);
    expect(rotating.warnings.some((w) => w.includes("db:rotate-key"))).toBe(true);
    expect(checkRuntimeConfig({ ...base, APP_ENCRYPTION_KEY_PREVIOUS: key(1) }, "web").warnings.some((w) => w.includes("equals"))).toBe(true);
  });

  it("rejects live mode without the job queue", () => {
    const r = checkRuntimeConfig({ ...db, ...secrets, HULLWISE_INTEGRATION_MODE: "live" }, "web");
    expect(r.errors.some((e) => e.includes("HULLWISE_JOBS_QUEUE=1"))).toBe(true);
  });

  it("rejects live mode with development or missing secrets", () => {
    const dev = checkRuntimeConfig({ ...db, ...DEV_DEFAULT_SECRETS, HULLWISE_INTEGRATION_MODE: "live", HULLWISE_JOBS_QUEUE: "1" }, "web");
    expect(dev.errors).toHaveLength(2);
    const missing = checkRuntimeConfig({ ...db, HULLWISE_INTEGRATION_MODE: "live", HULLWISE_JOBS_QUEUE: "1" }, "web");
    expect(missing.errors).toEqual(["AUTH_SECRET is not set.", "APP_ENCRYPTION_KEY is not set."]);
  });

  it("accepts a complete live configuration and only warns about a missing error tracker", () => {
    const email = { RESEND_API_KEY: "re_x", EMAIL_FROM: "Hullwise <no-reply@mail.hullwise.example>", RESEND_WEBHOOK_SECRET: "whsec_x" };
    const r = checkRuntimeConfig({ ...db, ...secrets, ...email, HULLWISE_INTEGRATION_MODE: "live", HULLWISE_JOBS_QUEUE: "1" }, "web");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(["SENTRY_DSN is not set: errors in live mode will only reach the logs."]);
    expect(checkRuntimeConfig({ ...db, ...secrets, ...email, HULLWISE_INTEGRATION_MODE: "live", HULLWISE_JOBS_QUEUE: "1", SENTRY_DSN: "https://x" }, "web").warnings).toEqual([]);
  });

  it("warns, never fails, when live mode has no email provider: the mock captures the emails", () => {
    const live = { ...db, ...secrets, HULLWISE_INTEGRATION_MODE: "live", HULLWISE_JOBS_QUEUE: "1", SENTRY_DSN: "https://x" };
    const none = checkRuntimeConfig(live, "web");
    expect(none.errors).toEqual([]);
    expect(none.warnings).toEqual([expect.stringContaining("RESEND_API_KEY is not set")]);
    const partial = checkRuntimeConfig({ ...live, RESEND_API_KEY: "re_x" }, "web").warnings;
    expect(partial.some((w) => w.startsWith("EMAIL_FROM"))).toBe(true);
    expect(partial.some((w) => w.startsWith("RESEND_WEBHOOK_SECRET"))).toBe(true);
  });

  it("requires both database URLs", () => {
    expect(checkRuntimeConfig({}, "web").errors).toEqual(["DATABASE_URL is not set.", "DATABASE_ADMIN_URL is not set."]);
  });

  it("warns when a worker runs without the queue enabled", () => {
    const r = checkRuntimeConfig({ ...db, ...secrets }, "worker");
    expect(r.warnings.some((w) => w.includes("HULLWISE_JOBS_QUEUE"))).toBe(true);
  });
});
