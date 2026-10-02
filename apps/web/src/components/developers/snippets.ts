import { WEBHOOK_HEADERS, WEBHOOK_LIMITS } from "@hullwise/config";

/**
 * Receiver-side verification of a webhook signature (#81), shown in the API docs. Code, not UI text:
 * it stays in English like every code sample. Mirrors `verifyWebhookSignature` in @hullwise/core.
 */
export function verificationSnippet(): string {
  return `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (before JSON.parse)
// header:  the "${WEBHOOK_HEADERS.signature}" header, e.g. "t=1767225600,v1=5f2c…"
export function verifyWebhook(rawBody, header, secret, toleranceSeconds = ${WEBHOOK_LIMITS.signatureToleranceSeconds}) {
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  return signatures.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// Answer 2xx fast, then process; deduplicate on the payload "id" (the event: a redelivery keeps it, "${WEBHOOK_HEADERS.id}" is per delivery).`;
}
