import { and, desc, eq, inArray, recordAudit, schema, type DbExecutor } from "@keel/db";
import { emailAddressHash, maskEmail, normalizeEmailAddress } from "@keel/integrations";
import type { ServiceContext } from "../context";
import type { EmailKind } from "./templates";

/**
 * Two suppression lists. Platform-wide (`email_address_suppressions`, hashed): hard bounces and
 * complaints reported by the provider, because the sender is one for every tenant. Per tenant
 * (`email_suppressions`): unsubscribes and manual entries by category, plus bounce/complaint
 * entries a tenant adds by hand. Security emails (sign-in, email change) ignore preferences,
 * unsubscribes and complaints, never hard bounces.
 */
export const TRANSACTIONAL_EMAIL = "transactional";
export const SECURITY_EMAIL = "security";
export type EmailCategory = string;

const norm = normalizeEmailAddress;
const blocks = (r: { reason: string; category: string }, category: EmailCategory) =>
  r.reason === "bounce" || (category !== SECURITY_EMAIL && (r.reason === "complaint" || (category !== TRANSACTIONAL_EMAIL && (r.category === "all" || r.category === category))));

/* ---------- per tenant ---------- */

/** Bounces block everything; complaints everything but security emails; unsubscribes and manual entries their category (or all optional mail). */
export async function isEmailSuppressed(ctx: ServiceContext, email: string, category: EmailCategory): Promise<boolean> {
  const rows = await ctx.tx.select({ reason: schema.emailSuppressions.reason, category: schema.emailSuppressions.category }).from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.email, norm(email))));
  return rows.some((r) => blocks(r, category));
}

export async function suppressedAmong(ctx: ServiceContext, emails: string[], category: EmailCategory): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = await ctx.tx.select({ email: schema.emailSuppressions.email, reason: schema.emailSuppressions.reason, category: schema.emailSuppressions.category }).from(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), inArray(schema.emailSuppressions.email, emails.map(norm))));
  return new Set(rows.filter((r) => blocks(r, category)).map((r) => r.email));
}

export const SUPPRESSION_REASONS = ["bounce", "complaint", "unsubscribe", "manual"] as const;

export async function addEmailSuppression(ctx: ServiceContext, input: { email: string; reason: (typeof SUPPRESSION_REASONS)[number]; category?: string; source?: string; note?: string | null }): Promise<boolean> {
  const email = norm(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_email");
  const category = input.reason === "bounce" || input.reason === "complaint" ? "all" : (input.category ?? "all");
  const rows = await ctx.tx.insert(schema.emailSuppressions).values({ tenantId: ctx.tenantId, email, reason: input.reason, category, source: input.source ?? "app", note: input.note ?? null, createdBy: ctx.actor.userId, createdAt: ctx.now ?? new Date() }).onConflictDoNothing().returning({ id: schema.emailSuppressions.id });
  if (rows.length) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", action: "email.suppressed", entityType: "email_suppression", entityId: rows[0]!.id, diff: { suppressed: { from: false, to: true } }, metadata: { email, reason: input.reason, category, source: input.source ?? "app" } });
  return rows.length > 0;
}

export async function removeEmailSuppression(ctx: ServiceContext, id: string): Promise<boolean> {
  const [row] = await ctx.tx.delete(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.id, id))).returning();
  if (row) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "email.unsuppressed", entityType: "email_suppression", entityId: id, diff: { suppressed: { from: true, to: false } }, metadata: { email: row.email, reason: row.reason, category: row.category } });
  return Boolean(row);
}

export async function listEmailSuppressions(ctx: ServiceContext, limit = 200) {
  return ctx.tx.select().from(schema.emailSuppressions).where(eq(schema.emailSuppressions.tenantId, ctx.tenantId)).orderBy(desc(schema.emailSuppressions.createdAt)).limit(limit);
}

/** Deletes the unsubscribe entries of one address (the person subscribes again from their preferences). */
export async function clearUnsubscribes(ctx: ServiceContext, email: string): Promise<void> {
  await ctx.tx.delete(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.email, norm(email)), eq(schema.emailSuppressions.reason, "unsubscribe")));
}

/* ---------- platform-wide (provider reports) ---------- */

/** Whether the provider reported this address (by hash) in a way that blocks this kind of email. */
export async function isAddressSuppressed(db: DbExecutor, recipientHash: string, kind: EmailKind): Promise<boolean> {
  const rows = await db.select({ reason: schema.emailAddressSuppressions.reason }).from(schema.emailAddressSuppressions).where(eq(schema.emailAddressSuppressions.emailHash, recipientHash));
  return rows.some((r) => r.reason === "bounce" || (r.reason === "complaint" && kind !== "security"));
}

export async function suppressAddress(db: DbExecutor, input: { emailHash: string; emailMasked: string; reason: "bounce" | "complaint"; source?: "provider" | "admin"; providerMessageId?: string | null; note?: string | null; now?: Date }): Promise<boolean> {
  const rows = await db.insert(schema.emailAddressSuppressions).values({ emailHash: input.emailHash, emailMasked: input.emailMasked, reason: input.reason, source: input.source ?? "provider", providerMessageId: input.providerMessageId ?? null, note: input.note ?? null, createdAt: input.now ?? new Date() }).onConflictDoNothing().returning({ id: schema.emailAddressSuppressions.id });
  return rows.length > 0;
}

/** Console: suppress an address by hand (e.g. a known dead mailbox). */
export async function suppressAddressByEmail(db: DbExecutor, email: string, reason: "bounce" | "complaint", actorUserId: string | null, note?: string | null): Promise<boolean> {
  const added = await suppressAddress(db, { emailHash: emailAddressHash(email), emailMasked: maskEmail(email), reason, source: "admin", note: note ?? null });
  if (added) await recordAudit(db, { tenantId: null, actorUserId, actorType: "super_admin", action: "email.address_suppressed", entityType: "email_address", entityId: maskEmail(email), diff: { suppressed: { from: false, to: true } }, metadata: { reason } });
  return added;
}

export async function listAddressSuppressions(db: DbExecutor, limit = 100) {
  return db.select().from(schema.emailAddressSuppressions).orderBy(desc(schema.emailAddressSuppressions.createdAt)).limit(limit);
}

/** Console: lift a suppression (the mailbox works again). Audited. */
export async function removeAddressSuppression(db: DbExecutor, id: string, actorUserId: string | null): Promise<boolean> {
  const [row] = await db.delete(schema.emailAddressSuppressions).where(eq(schema.emailAddressSuppressions.id, id)).returning();
  if (row) await recordAudit(db, { tenantId: null, actorUserId, actorType: "super_admin", action: "email.address_unsuppressed", entityType: "email_address", entityId: row.emailMasked, diff: { suppressed: { from: true, to: false } }, metadata: { reason: row.reason } });
  return Boolean(row);
}
