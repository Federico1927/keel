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
    // emails queued by this process go to pg-boss (worker deployed) or are delivered after the response
    const { installEmailDispatcher } = await import("./server/email");
    installEmailDispatcher();
    // outgoing webhooks (#81) the same way: pg-boss with a worker, a deferred in-process delivery without
    const { installWebhookDispatcher } = await import("./server/webhooks");
    installWebhookDispatcher();
  }
  if (process.env.SENTRY_DSN) {
    const [Sentry, { SENTRY_DATA_COLLECTION }] = await Promise.all([import("@sentry/nextjs"), import("@hullwise/config")]);
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
