import { and, eq, isNull, like } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { emailAddressHash, maskEmail } from "@keel/integrations";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Delivery log of the platform sender for one demo tenant (and, with Northwind, the platform's own
 * sign-in emails): a week of invites, mentions, digests and supplier emails in every state the
 * console filters on, one hard bounce that feeds the platform suppression list and one failure.
 * Only masked recipients and hashes, as the real log stores them.
 */
export async function seedEmailLog(db: Db, key: "northwind" | "harbor", tenantId: string, locale: string, now: Date): Promise<void> {
  await db.delete(schema.emailMessages).where(eq(schema.emailMessages.tenantId, tenantId));
  const dom = key === "northwind" ? "northwind" : "harborhome";
  const h = (n: number) => new Date(now.getTime() - n * 3600e3);
  type Row = { template: string; category: string; kind: string; to: string; status: string; hoursAgo: number; error?: [string, string] };
  const rows: Row[] = [
    { template: "invite", category: "transactional", kind: "transactional", to: `care@${dom}.demo`, status: "delivered", hoursAgo: 150 },
    { template: "mention", category: "mention", kind: "notification", to: `ops@${dom}.demo`, status: "delivered", hoursAgo: 120 },
    { template: "digest", category: "digest", kind: "notification", to: `owner@${dom}.demo`, status: "delivered", hoursAgo: 98 },
    { template: "digest", category: "digest", kind: "notification", to: `owner@${dom}.demo`, status: "delivered", hoursAgo: 74 },
    { template: "supplier_po", category: "supplier_po", kind: "transactional", to: `orders@supplier-${dom}.example`, status: "delivered", hoursAgo: 60 },
    { template: "supplier_po", category: "supplier_po", kind: "transactional", to: `old-supplier@${dom}.example`, status: "bounced", hoursAgo: 52, error: ["hard_bounce", "Permanent bounce reported by the provider"] },
    { template: "notification", category: "late_to_ship", kind: "notification", to: `ops@${dom}.demo`, status: "delivered", hoursAgo: 30 },
    { template: "notification", category: "stock_critical_no_po", kind: "notification", to: `owner@${dom}.demo`, status: "sent", hoursAgo: 20 },
    { template: "notification", category: "alert", kind: "notification", to: `marketing@${dom}.demo`, status: "failed", hoursAgo: 12, error: ["rate_limit", "Resend 429 rate_limit_exceeded: Too many requests"] },
    { template: "digest", category: "digest", kind: "notification", to: `viewer@${dom}.demo`, status: "suppressed", hoursAgo: 26 },
    { template: "mention", category: "mention", kind: "notification", to: `care@${dom}.demo`, status: "delivered", hoursAgo: 3 },
  ];
  await db.insert(schema.emailMessages).values(
    rows.map((r, i) => {
      const at = h(r.hoursAgo);
      const sent = ["sent", "delivered", "bounced"].includes(r.status);
      return { tenantId, template: r.template, category: r.category, kind: r.kind, recipientHash: emailAddressHash(r.to), recipientMasked: maskEmail(r.to), locale, idempotencyKey: `seed:${tenantId}:${i}`, status: r.status, provider: r.status === "suppressed" ? null : "mock", providerMessageId: sent ? `mock_seed_${key}_${i}` : null, attempts: r.status === "suppressed" ? 0 : r.status === "failed" ? 5 : 1, lastErrorCode: r.error?.[0] ?? null, lastError: r.error?.[1] ?? null, sentAt: sent ? at : null, deliveredAt: r.status === "delivered" ? new Date(at.getTime() + 4000) : null, createdAt: at, updatedAt: at };
    }),
  );
  await db.insert(schema.emailAddressSuppressions).values({ emailHash: emailAddressHash(`old-supplier@${dom}.example`), emailMasked: maskEmail(`old-supplier@${dom}.example`), reason: "bounce", source: "provider", providerMessageId: `mock_seed_${key}_5`, createdAt: h(52) }).onConflictDoNothing();

  if (key !== "northwind") return;
  // platform emails (no tenant): sign-in links of the demo users
  await db.delete(schema.emailMessages).where(and(isNull(schema.emailMessages.tenantId), like(schema.emailMessages.idempotencyKey, "seed:platform:%")));
  const platform = [`owner@northwind.demo`, `owner@harborhome.demo`, `superadmin@keel.demo`];
  await db.insert(schema.emailMessages).values(
    platform.map((to, i) => {
      const at = h(5 + i * 17);
      return { tenantId: null, template: "magic_link", category: "security", kind: "security", recipientHash: emailAddressHash(to), recipientMasked: maskEmail(to), locale: "en", idempotencyKey: `seed:platform:${i}`, status: i === 2 ? "expired" : "delivered", provider: "mock", providerMessageId: i === 2 ? null : `mock_seed_platform_${i}`, attempts: i === 2 ? 2 : 1, lastErrorCode: i === 2 ? "transient" : null, lastError: i === 2 ? "Network error: socket hang up" : null, expiresAt: new Date(at.getTime() + 15 * 60_000), sentAt: i === 2 ? null : at, deliveredAt: i === 2 ? null : new Date(at.getTime() + 3000), createdAt: at, updatedAt: at };
    }),
  );
}
