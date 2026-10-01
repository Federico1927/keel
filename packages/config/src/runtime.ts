/**
 * Startup checks for a deployed process (web or worker). Pure: it reads the environment it is
 * given, so it can be tested without touching `process.env`.
 *
 * Errors stop the process; warnings are logged. The strict rules apply to `live` integration
 * mode only: that is the mode real tenants run in, while demos and the e2e suite run the
 * production build in `mock` mode with the development defaults of `.env.example`.
 */

/** Values shipped in `.env.example`; a live deployment must not run with them. */
export const DEV_DEFAULT_SECRETS = {
  AUTH_SECRET: "dev-only-change-me-please-32-bytes-min",
  APP_ENCRYPTION_KEY: "ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=",
};

export type RuntimeProcess = "web" | "worker";

export interface RuntimeCheck {
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

export function checkRuntimeConfig(env: Env, role: RuntimeProcess): RuntimeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const live = env.KEEL_INTEGRATION_MODE === "live";
  const queued = env.KEEL_JOBS_QUEUE === "1";

  if (!env.DATABASE_URL) errors.push("DATABASE_URL is not set.");
  if (!env.DATABASE_ADMIN_URL) errors.push("DATABASE_ADMIN_URL is not set.");

  if (live) {
    // Without the queue, webhooks and resyncs run inside the web process: a burst of
    // orders from one tenant would stall every tenant's requests.
    if (!queued) errors.push("KEEL_INTEGRATION_MODE=live requires KEEL_JOBS_QUEUE=1 and a running worker (pnpm --filter @keel/jobs start).");
    for (const [name, devValue] of Object.entries(DEV_DEFAULT_SECRETS)) {
      const value = env[name];
      if (!value) errors.push(`${name} is not set.`);
      else if (value === devValue) errors.push(`${name} still has the development value from .env.example.`);
    }
    if (!env.SENTRY_DSN) warnings.push("SENTRY_DSN is not set: errors in live mode will only reach the logs.");
  } else {
    for (const [name, devValue] of Object.entries(DEV_DEFAULT_SECRETS)) {
      if (env[name] === devValue) warnings.push(`${name} has the development value from .env.example; fine for a demo, not for real tenants.`);
    }
  }

  if (role === "worker" && !queued) {
    warnings.push("The worker is running but KEEL_JOBS_QUEUE is not 1: the web process will not enqueue jobs, only schedules will run here.");
  }

  return { errors, warnings };
}

/**
 * Sentry `dataCollection` for every Keel process (web server, browser, worker). Tenants' orders
 * and customers carry personal data, and Sentry's defaults would send request bodies, cookies,
 * headers, query parameters, database parameters, queue payloads and stack-frame variables.
 * Keel sends the error, its stack trace and source context, nothing else.
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};
