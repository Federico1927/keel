import { and, count, desc, eq, gte, recordAudit, schema, sql, type ActorType } from "@hullwise/db";
import { WEBHOOK_EVENT_TYPES, WEBHOOK_LIMITS, WEBHOOK_SECRET_PREFIX, isWebhookEventType, type WebhookEventType } from "@hullwise/config";
import { checkWebhookUrl, classifyIp, isAllowedWebhookAddress, sanitizeFreeText, type WebhookUrlPolicy } from "@hullwise/core";
import { decryptSecret, encryptSecret } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { randomBase62 } from "../mcp/crypto";
import { forgetWebhookEndpoints } from "./emit";
import { resolveHostAddresses } from "./transport";

/**
 * Webhook endpoints of a tenant (#81): an https URL checked against the SSRF rules (statically and
 * after DNS resolution), the event types, and a signing secret stored encrypted (AES-GCM) and shown
 * once. Rotation keeps the previous secret signing for 24 hours. Every change is audited.
 */

export class WebhookError extends Error {
  constructor(
    readonly code: "invalid_url" | "private_address" | "unresolvable" | "invalid_events" | "limit_reached" | "not_found",
    readonly detail?: string,
  ) {
    super(code);
    this.name = "WebhookError";
  }
}

export interface WebhookAuditIdentity {
  actorUserId: string | null;
  actorType: ActorType;
  impersonatedBy: string | null;
}

export interface WebhookServiceOptions {
  policy: WebhookUrlPolicy;
  /** DNS resolution (tests inject one); default: the system resolver. */
  resolve?: (host: string) => Promise<string[] | null>;
  audit?: WebhookAuditIdentity;
  /** Extra audit metadata (the API token that made the change). */
  auditMetadata?: Record<string, unknown>;
}

const identityOf = (ctx: ServiceContext, o?: WebhookAuditIdentity): WebhookAuditIdentity => o ?? { actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "api" ? "api" : ctx.actor.userId ? "user" : "system", impersonatedBy: null };

/** Static rules, then every resolved address of a host name. Returns the normalised URL. */
export async function validateWebhookUrl(raw: string, opts: Pick<WebhookServiceOptions, "policy" | "resolve">): Promise<string> {
  const check = checkWebhookUrl(raw, opts.policy);
  if (!check.ok) throw new WebhookError(check.problem === "private_address" ? "private_address" : "invalid_url", check.problem);
  const host = check.url.hostname.replace(/^\[|\]$/g, "");
  if (classifyIp(host) === "invalid") {
    const addresses = await (opts.resolve ?? resolveHostAddresses)(host);
    if (!addresses?.length) throw new WebhookError("unresolvable");
    if (addresses.some((a) => !isAllowedWebhookAddress(a, opts.policy))) throw new WebhookError("private_address", "resolved");
  }
  return check.url.toString();
}

function parseEventTypes(input: readonly string[]): WebhookEventType[] {
  const picked = new Set(input.filter(isWebhookEventType));
  if (!picked.size || picked.size !== new Set(input).size) throw new WebhookError("invalid_events");
  return WEBHOOK_EVENT_TYPES.filter((t) => picked.has(t));
}

const newSecret = () => `${WEBHOOK_SECRET_PREFIX}${randomBase62(32)}`;
const prefixOf = (secret: string) => secret.slice(0, WEBHOOK_SECRET_PREFIX.length + 4);

export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  isActive: boolean;
  secretPrefix: string;
  secretRotatedAt: Date;
  /** A previous secret still signs until then (rotation grace). */
  previousSecretExpiresAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

const view = (r: typeof schema.webhookEndpoints.$inferSelect, now: Date): WebhookEndpointView => ({ id: r.id, url: r.url, description: r.description, eventTypes: r.eventTypes, isActive: r.isActive, secretPrefix: r.secretPrefix, secretRotatedAt: r.secretRotatedAt, previousSecretExpiresAt: r.previousSecretExpiresAt && r.previousSecretExpiresAt > now ? r.previousSecretExpiresAt : null, createdBy: r.createdBy, createdAt: r.createdAt, lastSuccessAt: r.lastSuccessAt, lastFailureAt: r.lastFailureAt });

async function loadEndpoint(ctx: ServiceContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new WebhookError("not_found");
  const [row] = await ctx.tx.select().from(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.tenantId, ctx.tenantId), eq(schema.webhookEndpoints.id, id))).limit(1);
  if (!row) throw new WebhookError("not_found");
  return row;
}

export async function createWebhookEndpoint(ctx: ServiceContext, input: { url: string; description?: string | null; eventTypes: readonly string[] }, opts: WebhookServiceOptions): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  const url = await validateWebhookUrl(input.url, opts);
  const eventTypes = parseEventTypes(input.eventTypes);
  const [n] = await ctx.tx.select({ n: count() }).from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.tenantId, ctx.tenantId));
  if ((n?.n ?? 0) >= WEBHOOK_LIMITS.endpointsPerTenant) throw new WebhookError("limit_reached");
  const now = ctx.now ?? new Date();
  const secret = newSecret();
  const description = sanitizeFreeText(input.description ?? "", 200).replace(/\n/g, " ") || null;
  const id = identityOf(ctx, opts.audit);
  const [row] = await ctx.tx.insert(schema.webhookEndpoints).values({ tenantId: ctx.tenantId, url, description, secretEnc: encryptSecret(secret), secretPrefix: prefixOf(secret), secretRotatedAt: now, eventTypes, isActive: true, createdBy: id.actorUserId, createdAt: now, updatedAt: now }).returning();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...id, action: "webhook.endpoint_created", entityType: "webhook_endpoint", entityId: row!.id, diff: { url: { from: null, to: url }, eventTypes: { from: null, to: eventTypes } }, metadata: { ...(opts.auditMetadata ?? {}) } });
  forgetWebhookEndpoints(ctx);
  return { endpoint: view(row!, now), secret };
}

export async function updateWebhookEndpoint(ctx: ServiceContext, endpointId: string, patch: { url?: string; description?: string | null; eventTypes?: readonly string[]; isActive?: boolean }, opts: WebhookServiceOptions): Promise<WebhookEndpointView> {
  const row = await loadEndpoint(ctx, endpointId);
  const next: Partial<typeof schema.webhookEndpoints.$inferInsert> = {};
  if (patch.url !== undefined && patch.url !== row.url) next.url = await validateWebhookUrl(patch.url, opts);
  if (patch.eventTypes !== undefined) next.eventTypes = parseEventTypes(patch.eventTypes);
  if (patch.description !== undefined) next.description = sanitizeFreeText(patch.description ?? "", 200).replace(/\n/g, " ") || null;
  if (patch.isActive !== undefined) next.isActive = patch.isActive;
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(next)) {
    const before = (row as Record<string, unknown>)[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) diff[k] = { from: before ?? null, to: v ?? null };
  }
  const now = ctx.now ?? new Date();
  if (!Object.keys(diff).length) return view(row, now);
  const [updated] = await ctx.tx.update(schema.webhookEndpoints).set({ ...next, updatedAt: now }).where(eq(schema.webhookEndpoints.id, row.id)).returning();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "webhook.endpoint_updated", entityType: "webhook_endpoint", entityId: row.id, diff, metadata: { ...(opts.auditMetadata ?? {}) } });
  forgetWebhookEndpoints(ctx);
  return view(updated!, now);
}

export async function deleteWebhookEndpoint(ctx: ServiceContext, endpointId: string, opts: Omit<WebhookServiceOptions, "policy" | "resolve"> = {}): Promise<void> {
  const row = await loadEndpoint(ctx, endpointId);
  await ctx.tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, row.id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "webhook.endpoint_deleted", entityType: "webhook_endpoint", entityId: row.id, diff: { url: { from: row.url, to: null } }, metadata: { eventTypes: row.eventTypes, ...(opts.auditMetadata ?? {}) } });
  forgetWebhookEndpoints(ctx);
}

/** A new secret, shown once; the old one keeps signing (second `v1=`) for the grace period so receivers can switch. */
export async function rotateWebhookSecret(ctx: ServiceContext, endpointId: string, opts: Omit<WebhookServiceOptions, "policy" | "resolve"> = {}): Promise<{ secret: string; previousSecretExpiresAt: Date }> {
  const row = await loadEndpoint(ctx, endpointId);
  const now = ctx.now ?? new Date();
  const secret = newSecret();
  const previousSecretExpiresAt = new Date(now.getTime() + WEBHOOK_LIMITS.rotationGraceHours * 3600e3);
  await ctx.tx.update(schema.webhookEndpoints).set({ secretEnc: encryptSecret(secret), secretPrefix: prefixOf(secret), previousSecretEnc: row.secretEnc, previousSecretExpiresAt, secretRotatedAt: now, updatedAt: now }).where(eq(schema.webhookEndpoints.id, row.id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, opts.audit), action: "webhook.secret_rotated", entityType: "webhook_endpoint", entityId: row.id, diff: { secretPrefix: { from: row.secretPrefix, to: prefixOf(secret) } }, metadata: { previousSecretExpiresAt: previousSecretExpiresAt.toISOString(), ...(opts.auditMetadata ?? {}) } });
  return { secret, previousSecretExpiresAt };
}

export interface WebhookEndpointRow extends WebhookEndpointView {
  /** Deliveries of the last 24 hours. */
  succeeded24h: number;
  failed24h: number;
}

export async function listWebhookEndpoints(ctx: ServiceContext): Promise<WebhookEndpointRow[]> {
  const now = ctx.now ?? new Date();
  const rows = await ctx.tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.tenantId, ctx.tenantId)).orderBy(desc(schema.webhookEndpoints.createdAt));
  const d = schema.webhookDeliveries;
  const stats = await ctx.tx.select({ endpointId: d.endpointId, ok: sql<number>`count(*) filter (where ${d.status} = 'succeeded')::int`, failed: sql<number>`count(*) filter (where ${d.status} in ('dead', 'retrying'))::int` }).from(d).where(and(eq(d.tenantId, ctx.tenantId), gte(d.createdAt, new Date(now.getTime() - 864e5)))).groupBy(d.endpointId);
  const by = new Map(stats.map((s) => [s.endpointId, s]));
  return rows.map((r) => ({ ...view(r, now), succeeded24h: by.get(r.id)?.ok ?? 0, failed24h: by.get(r.id)?.failed ?? 0 }));
}

export async function getWebhookEndpoint(ctx: ServiceContext, endpointId: string): Promise<WebhookEndpointView> {
  return view(await loadEndpoint(ctx, endpointId), ctx.now ?? new Date());
}

/** The secrets that sign a delivery now: the current one, and the previous one during its grace period. */
export function signingSecrets(row: Pick<typeof schema.webhookEndpoints.$inferSelect, "secretEnc" | "previousSecretEnc" | "previousSecretExpiresAt">, now: Date): string[] {
  const out = [decryptSecret(row.secretEnc)];
  if (row.previousSecretEnc && row.previousSecretExpiresAt && row.previousSecretExpiresAt > now) out.push(decryptSecret(row.previousSecretEnc));
  return out;
}
