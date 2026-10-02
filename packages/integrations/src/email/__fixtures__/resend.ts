/**
 * Resend responses and webhook payloads in the shape the API documents (to verify against a
 * real account: bodies were written from the public reference, not captured from traffic).
 */
export const RESEND_SENT = { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" };

export const RESEND_ERRORS = {
  rateLimit: { status: 429, headers: { "retry-after": "2" }, body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests. You can only make 2 requests per second." } },
  dailyQuota: { status: 429, headers: {}, body: { statusCode: 429, name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." } },
  invalidTo: { status: 422, headers: {}, body: { statusCode: 422, name: "validation_error", message: "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format." } },
  domainNotVerified: { status: 403, headers: {}, body: { statusCode: 403, name: "validation_error", message: "The hullwise.example domain is not verified. Please, add and verify your domain on https://resend.com/domains" } },
  invalidKey: { status: 403, headers: {}, body: { statusCode: 403, name: "invalid_api_key", message: "API key is invalid" } },
  missingKey: { status: 401, headers: {}, body: { statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." } },
  concurrent: { status: 409, headers: {}, body: { statusCode: 409, name: "concurrent_idempotent_requests", message: "Same idempotency key used while original request is still in progress." } },
  server: { status: 500, headers: {}, body: { statusCode: 500, name: "internal_server_error", message: "An unexpected error occurred." } },
} as const;

export const RESEND_WEBHOOKS = {
  delivered: { type: "email.delivered", created_at: "2026-10-01T09:00:03.000Z", data: { created_at: "2026-10-01T09:00:00.000Z", email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", from: "Hullwise <no-reply@hullwise.example>", to: ["Owner@Northwind.demo"], subject: "Your sign-in link", tags: { template: "magic_link", message_id: "0b9a1c52-6f0e-4b8e-9d55-2f1e7a3c4d10" } } },
  bouncedHard: { type: "email.bounced", created_at: "2026-10-01T09:00:05.000Z", data: { created_at: "2026-10-01T09:00:00.000Z", email_id: "5b1c-hard", from: "Hullwise <no-reply@hullwise.example>", to: ["gone@example.com"], subject: "Your daily summary", bounce: { message: "The recipient's mail server permanently rejected the email.", subType: "General", type: "Permanent" }, tags: [{ name: "template", value: "digest" }] } },
  bouncedSoft: { type: "email.bounced", created_at: "2026-10-01T09:00:05.000Z", data: { email_id: "5b1c-soft", to: ["full@example.com"], bounce: { message: "Mailbox full", subType: "MailboxFull", type: "Transient" } } },
  complained: { type: "email.complained", created_at: "2026-10-01T10:00:00.000Z", data: { email_id: "6c2d", to: ["angry@example.com"], tags: { template: "digest" } } },
  opened: { type: "email.opened", created_at: "2026-10-01T10:00:00.000Z", data: { email_id: "7d3e", to: ["a@example.com"] } },
} as const;

/** A `whsec_` secret as the Resend dashboard shows it (base64 of 24 random bytes). */
export const SVIX_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
