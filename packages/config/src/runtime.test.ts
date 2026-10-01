import { describe, expect, it } from "vitest";
import { checkRuntimeConfig, DEV_DEFAULT_SECRETS } from "./runtime";

const db = { DATABASE_URL: "postgres://app", DATABASE_ADMIN_URL: "postgres://admin" };
const secrets = { AUTH_SECRET: "a-real-secret", APP_ENCRYPTION_KEY: "a-real-key" };

describe("checkRuntimeConfig", () => {
  it("accepts a mock demo with development secrets, with warnings only", () => {
    const r = checkRuntimeConfig({ ...db, ...DEV_DEFAULT_SECRETS }, "web");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });

  it("rejects live mode without the job queue", () => {
    const r = checkRuntimeConfig({ ...db, ...secrets, KEEL_INTEGRATION_MODE: "live" }, "web");
    expect(r.errors.some((e) => e.includes("KEEL_JOBS_QUEUE=1"))).toBe(true);
  });

  it("rejects live mode with development or missing secrets", () => {
    const dev = checkRuntimeConfig({ ...db, ...DEV_DEFAULT_SECRETS, KEEL_INTEGRATION_MODE: "live", KEEL_JOBS_QUEUE: "1" }, "web");
    expect(dev.errors).toHaveLength(2);
    const missing = checkRuntimeConfig({ ...db, KEEL_INTEGRATION_MODE: "live", KEEL_JOBS_QUEUE: "1" }, "web");
    expect(missing.errors).toEqual(["AUTH_SECRET is not set.", "APP_ENCRYPTION_KEY is not set."]);
  });

  it("accepts a complete live configuration and only warns about a missing error tracker", () => {
    const r = checkRuntimeConfig({ ...db, ...secrets, KEEL_INTEGRATION_MODE: "live", KEEL_JOBS_QUEUE: "1" }, "web");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(["SENTRY_DSN is not set: errors in live mode will only reach the logs."]);
    expect(checkRuntimeConfig({ ...db, ...secrets, KEEL_INTEGRATION_MODE: "live", KEEL_JOBS_QUEUE: "1", SENTRY_DSN: "https://x" }, "web").warnings).toEqual([]);
  });

  it("requires both database URLs", () => {
    expect(checkRuntimeConfig({}, "web").errors).toEqual(["DATABASE_URL is not set.", "DATABASE_ADMIN_URL is not set."]);
  });

  it("warns when a worker runs without the queue enabled", () => {
    const r = checkRuntimeConfig({ ...db, ...secrets }, "worker");
    expect(r.warnings.some((w) => w.includes("KEEL_JOBS_QUEUE"))).toBe(true);
  });
});
