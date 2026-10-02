/**
 * Startup checks for a deployed process (web or worker). Pure: it reads the environment it is
 * given, so it can be tested without touching `process.env`.
 *
 * Errors stop the process; warnings are logged. The strict rules apply to `live` integration
 * mode only: that is the mode real tenants run in, while demos and the e2e suite run the
 * production build in `mock` mode with the development defaults of `.env.example`.
 */

import { legacyEnvVars } from "./legacy";

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

/** Bytes a base64 string decodes to, or -1 when it is not base64 (atob: no Node-only Buffer in this package). */
function decodedLength(b64: string): number {
  try {
    return atob(b64).length;
  } catch {
    return -1;
  }
}

export function checkRuntimeConfig(env: Env, role: RuntimeProcess): RuntimeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const live = env.HULLWISE_INTEGRATION_MODE === "live";
  const queued = env.HULLWISE_JOBS_QUEUE === "1";

  // variables still named with the pre-rename prefix would be ignored and replaced by defaults: refuse to start
  for (const v of legacyEnvVars(env)) errors.push(`${v.legacy} uses the old product prefix and is ignored: rename it to ${v.rename} (docs/DEPLOY.md, "Rename cutover").`);

  if (!env.DATABASE_URL) errors.push("DATABASE_URL is not set.");
  if (!env.DATABASE_ADMIN_URL) errors.push("DATABASE_ADMIN_URL is not set.");

  if (live) {
    // Without the queue, webhooks and resyncs run inside the web process: a burst of
    // orders from one tenant would stall every tenant's requests.
    if (!queued) errors.push("HULLWISE_INTEGRATION_MODE=live requires HULLWISE_JOBS_QUEUE=1 and a running worker (pnpm --filter @hullwise/jobs start).");
    for (const [name, devValue] of Object.entries(DEV_DEFAULT_SECRETS)) {
      const value = env[name];
      if (!value) errors.push(`${name} is not set.`);
      else if (value === devValue) errors.push(`${name} still has the development value from .env.example.`);
    }
    if (!env.SENTRY_DSN) warnings.push("SENTRY_DSN is not set: errors in live mode will only reach the logs.");
    // outgoing webhooks (#81): the loopback escape hatch exists for test receivers only and is ignored here
    if (env.HULLWISE_WEBHOOKS_ALLOW_LOOPBACK === "1") warnings.push("HULLWISE_WEBHOOKS_ALLOW_LOOPBACK is ignored in live mode: webhooks never go to loopback or private addresses.");
    // the platform email sender (issue #51): without a key emails go to the mock, and the console says "Email not configured"
    if (!env.RESEND_API_KEY) warnings.push("RESEND_API_KEY is not set: emails (sign-in links, invitations, notifications) are captured by the mock and nobody receives them.");
    else {
      if (!env.EMAIL_FROM) warnings.push("EMAIL_FROM is not set: Resend refuses the default sender; use an address on the verified domain.");
      if (role === "web" && !env.RESEND_WEBHOOK_SECRET) warnings.push("RESEND_WEBHOOK_SECRET is not set: bounces and complaints are not recorded, so bounced addresses keep being emailed.");
    }
  } else {
    for (const [name, devValue] of Object.entries(DEV_DEFAULT_SECRETS)) {
      if (env[name] === devValue) warnings.push(`${name} has the development value from .env.example; fine for a demo, not for real tenants.`);
    }
  }

  // key rotation window (docs/DEPLOY.md, "Rotating secrets"): old payloads decrypt with the previous key
  const previousKey = env.APP_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previousKey) {
    if (decodedLength(previousKey) !== 32) errors.push("APP_ENCRYPTION_KEY_PREVIOUS must decode to 32 bytes (base64), like APP_ENCRYPTION_KEY.");
    else if (previousKey === env.APP_ENCRYPTION_KEY?.trim()) warnings.push("APP_ENCRYPTION_KEY_PREVIOUS equals APP_ENCRYPTION_KEY: the new key goes in APP_ENCRYPTION_KEY.");
    else warnings.push("APP_ENCRYPTION_KEY_PREVIOUS is set: an encryption key rotation is in progress. Run `pnpm db:rotate-key`, check the report, then remove the variable.");
  }

  if (role === "worker" && !queued) {
    warnings.push("The worker is running but HULLWISE_JOBS_QUEUE is not 1: the web process will not enqueue jobs, only schedules will run here.");
  }

  return { errors, warnings };
}

/**
 * Sentry `dataCollection` for every Hullwise process (web server, browser, worker). Tenants' orders
 * and customers carry personal data, and Sentry's defaults would send request bodies, cookies,
 * headers, query parameters, database parameters, queue payloads and stack-frame variables.
 * Hullwise sends the error, its stack trace and source context, nothing else.
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
