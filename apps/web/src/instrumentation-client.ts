/**
 * Browser error reporting. Loaded by Next.js before the app hydrates; the Sentry SDK is
 * imported only when `NEXT_PUBLIC_SENTRY_DSN` was set at build time, so builds without it
 * ship no Sentry code to the browser.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void Promise.all([import("@sentry/nextjs"), import("@keel/config")]).then(([Sentry, { SENTRY_DATA_COLLECTION }]) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      tracesSampleRate: 0,
      dataCollection: SENTRY_DATA_COLLECTION,
    });
  });
}
