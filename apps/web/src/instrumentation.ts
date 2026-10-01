import type { Instrumentation } from "next";

/**
 * Runs once when a server process starts (Next.js instrumentation hook).
 * - Node runtime: refuses to start with a configuration that is unsafe for real tenants
 *   (see `checkRuntimeConfig`), then enables Sentry when `SENTRY_DSN` is set.
 * - Edge runtime (middleware): Sentry only.
 * Sentry is off without a DSN, so local development and the e2e suite are unaffected.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { assertRuntimeConfig } = await import("./instrumentation-node");
    assertRuntimeConfig();
  }
  if (process.env.SENTRY_DSN) {
    const [Sentry, { SENTRY_DATA_COLLECTION }] = await Promise.all([import("@sentry/nextjs"), import("@keel/config")]);
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      // Errors only: no performance tracing, and no request bodies, cookies or IPs, since
      // tenants' orders carry their customers' personal data.
      tracesSampleRate: 0,
      dataCollection: SENTRY_DATA_COLLECTION,
    });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
