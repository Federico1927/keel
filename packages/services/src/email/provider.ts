import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_NAME } from "@keel/config";
import { MockEmailProvider, ResendEmailProvider, type CapturedEmail, type EmailProvider } from "@keel/integrations";

/**
 * The platform sender (issue #51): one Resend account owned by Keel, configured with environment
 * variables, never per tenant. Resend only when `RESEND_API_KEY` is set AND
 * `KEEL_INTEGRATION_MODE=live`; otherwise the recording mock (dev inbox, tests, CI, demos).
 */
export type EmailProviderState = "configured" | "not_configured" | "mock_mode";

export interface EmailSettings {
  provider: "resend" | "mock";
  /** configured: Resend sends. not_configured: no API key, emails are captured by the mock and nobody receives them. mock_mode: a key exists but the integration mode is mock. */
  state: EmailProviderState;
  from: string;
  replyTo: string | null;
  fromConfigured: boolean;
  webhookConfigured: boolean;
}

type Env = Record<string, string | undefined>;

export function emailSettings(env: Env = process.env): EmailSettings {
  const key = Boolean(env.RESEND_API_KEY?.trim());
  const live = env.KEEL_INTEGRATION_MODE === "live";
  const state: EmailProviderState = !key ? "not_configured" : live ? "configured" : "mock_mode";
  return {
    provider: state === "configured" ? "resend" : "mock",
    state,
    from: env.EMAIL_FROM?.trim() || `${PRODUCT_NAME} <no-reply@example.invalid>`,
    replyTo: env.EMAIL_REPLY_TO?.trim() || null,
    fromConfigured: Boolean(env.EMAIL_FROM?.trim()),
    webhookConfigured: Boolean(env.RESEND_WEBHOOK_SECRET?.trim()),
  };
}

const store = globalThis as typeof globalThis & { __keelEmailMock?: MockEmailProvider };

/**
 * E2E outbox (#52): with `KEEL_EMAIL_OUTBOX_DIR` set, every email the mock captures is also written
 * there as one JSON file, so browser tests against a production build (where the dev inbox does
 * not exist) can read invitation and reset links from disk. No HTTP surface; never set in a deployment.
 */
function writeToOutboxDir(dir: string, captured: CapturedEmail) {
  try {
    mkdirSync(dir, { recursive: true });
    const m = captured.message;
    writeFileSync(join(dir, `${captured.sentAt.getTime()}-${captured.id}.json`), JSON.stringify({ id: captured.id, sentAt: captured.sentAt.toISOString(), to: m.to, subject: m.subject, template: m.tags?.template ?? null, text: m.text }));
  } catch (e) {
    console.warn("[email] outbox dir write failed:", e instanceof Error ? e.message : e);
  }
}

/** The process-wide recording mock: the dev inbox reads it, tests inspect it. */
export function mockEmailOutbox(): MockEmailProvider {
  const dir = process.env.KEEL_EMAIL_OUTBOX_DIR?.trim();
  store.__keelEmailMock ??= new MockEmailProvider({ capacity: 200, ...(dir ? { onCapture: (c: CapturedEmail) => writeToOutboxDir(dir, c) } : {}) });
  return store.__keelEmailMock;
}

/** Provider for the next send, from the current environment. */
export function getEmailProvider(env: Env = process.env): EmailProvider {
  return emailSettings(env).provider === "resend" ? new ResendEmailProvider({ apiKey: env.RESEND_API_KEY!.trim() }) : mockEmailOutbox();
}
