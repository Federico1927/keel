import { and, eq, inArray, schema, sql } from "@keel/db";
import { AUDIENCE_PROVIDERS, IntegrationError, audienceMatchKeys, type AudienceDestination, type AudienceMatchKeys, type AudienceMember, type AudienceProvider } from "@keel/integrations";
import type { ServiceContext } from "../context";

export class DestinationError extends Error {
  constructor(public readonly code: "not_found" | "invalid_input") {
    super(code);
  }
}

export interface DestinationInput {
  segmentId: string;
  provider: AudienceProvider;
  audienceName: string;
  autoSync: boolean;
}

export async function addSegmentDestination(ctx: ServiceContext, input: DestinationInput): Promise<string> {
  if (!AUDIENCE_PROVIDERS.includes(input.provider) || !input.audienceName.trim()) throw new DestinationError("invalid_input");
  const [segment] = await ctx.tx.select({ id: schema.segments.id }).from(schema.segments).where(and(eq(schema.segments.tenantId, ctx.tenantId), eq(schema.segments.id, input.segmentId))).limit(1);
  if (!segment) throw new DestinationError("not_found");
  const [row] = await ctx.tx.insert(schema.segmentDestinations).values({ tenantId: ctx.tenantId, segmentId: input.segmentId, provider: input.provider, audienceName: input.audienceName.trim(), autoSync: input.autoSync, createdBy: ctx.actor.userId }).returning({ id: schema.segmentDestinations.id });
  return row!.id;
}

/** Stops syncing. The audience stays on the platform (deleting a customer list there is the merchant's call). */
export async function removeSegmentDestination(ctx: ServiceContext, destinationId: string): Promise<void> {
  await ctx.tx.delete(schema.segmentDestinations).where(and(eq(schema.segmentDestinations.tenantId, ctx.tenantId), eq(schema.segmentDestinations.id, destinationId)));
}

export async function setDestinationAutoSync(ctx: ServiceContext, destinationId: string, autoSync: boolean): Promise<void> {
  await ctx.tx.update(schema.segmentDestinations).set({ autoSync }).where(and(eq(schema.segmentDestinations.tenantId, ctx.tenantId), eq(schema.segmentDestinations.id, destinationId)));
}

export async function listSegmentDestinations(ctx: ServiceContext, segmentId: string) {
  return ctx.tx.select().from(schema.segmentDestinations).where(and(eq(schema.segmentDestinations.tenantId, ctx.tenantId), eq(schema.segmentDestinations.segmentId, segmentId))).orderBy(schema.segmentDestinations.createdAt);
}

export interface DestinationSyncResult {
  status: "ok" | "error";
  added: number;
  removed: number;
  members: number;
  /** Members without anything the destination can match (no email / phone). */
  unmatched: number;
  error?: string;
}

type MemberRow = { customer_id: string; email: string | null; phone_e164: string | null; first_name: string | null; last_name: string | null; country: string | null };
const toMember = (r: MemberRow): AudienceMember => ({ customerId: r.customer_id, email: r.email, phoneE164: r.phone_e164, firstName: r.first_name, lastName: r.last_name, country: r.country });

/**
 * Brings the destination in line with the segment: only customers who accept marketing, and,
 * when control groups are in use (customer-campaigns add-on), only the treated group, so a
 * held-out customer never sees the audience's ads either. Diff-based and idempotent: the member
 * table records what Keel pushed, and is updated only after the destination accepted the change,
 * so a failed run is simply repeated.
 */
export async function syncSegmentDestination(ctx: ServiceContext, destinationId: string, destination: AudienceDestination, opts: { excludeHoldout: boolean }): Promise<DestinationSyncResult> {
  const now = ctx.now ?? new Date();
  const [d] = await ctx.tx.select().from(schema.segmentDestinations).where(and(eq(schema.segmentDestinations.tenantId, ctx.tenantId), eq(schema.segmentDestinations.id, destinationId))).limit(1);
  if (!d) throw new DestinationError("not_found");
  const groupFilter = opts.excludeHoldout ? sql`and m.group_name = 'treated'` : sql``;
  const wanted = await ctx.tx.execute<MemberRow>(sql`
    select c.id as customer_id, c.email, c.phone_e164, c.first_name, c.last_name, c.country
    from segment_memberships m join customers c on c.id = m.customer_id
    where m.tenant_id = ${ctx.tenantId} and m.segment_id = ${d.segmentId} and c.accepts_marketing ${groupFilter}`);
  const provider = d.provider as AudienceProvider;
  const desired = new Map<string, AudienceMatchKeys>();
  let unmatched = 0;
  for (const r of wanted.rows) {
    const k = audienceMatchKeys(provider, toMember(r));
    if (k) desired.set(r.customer_id, k);
    else unmatched++;
  }
  const current = new Set((await ctx.tx.select({ customerId: schema.segmentDestinationMembers.customerId }).from(schema.segmentDestinationMembers).where(eq(schema.segmentDestinationMembers.destinationId, destinationId))).map((m) => m.customerId));
  const toAdd = [...desired.keys()].filter((id) => !current.has(id));
  const toRemoveIds = [...current].filter((id) => !desired.has(id));
  let toRemove: AudienceMatchKeys[] = [];
  if (toRemoveIds.length) {
    const gone = await ctx.tx.execute<MemberRow>(sql`select id as customer_id, email, phone_e164, first_name, last_name, country from customers where tenant_id = ${ctx.tenantId} and id = any(${sql.param(toRemoveIds)}::uuid[])`);
    toRemove = gone.rows.map((r) => audienceMatchKeys(provider, toMember(r)) ?? { customerId: r.customer_id, keys: {} });
  }
  try {
    const { audienceId } = await destination.ensureAudience(d.audienceName, d.externalAudienceId);
    for (let i = 0; i < toAdd.length; i += 1000) await destination.addMembers(audienceId, toAdd.slice(i, i + 1000).map((id) => desired.get(id)!));
    for (let i = 0; i < toRemove.length; i += 1000) await destination.removeMembers(audienceId, toRemove.slice(i, i + 1000));
    for (let i = 0; i < toAdd.length; i += 1000) await ctx.tx.insert(schema.segmentDestinationMembers).values(toAdd.slice(i, i + 1000).map((customerId) => ({ tenantId: ctx.tenantId, destinationId, customerId, syncedAt: now }))).onConflictDoNothing();
    if (toRemoveIds.length) await ctx.tx.delete(schema.segmentDestinationMembers).where(and(eq(schema.segmentDestinationMembers.destinationId, destinationId), inArray(schema.segmentDestinationMembers.customerId, toRemoveIds)));
    await ctx.tx.update(schema.segmentDestinations).set({ externalAudienceId: audienceId, status: "ok", memberCount: desired.size, lastSyncAt: now, lastAdded: toAdd.length, lastRemoved: toRemoveIds.length, lastError: null }).where(eq(schema.segmentDestinations.id, destinationId));
    return { status: "ok", added: toAdd.length, removed: toRemoveIds.length, members: desired.size, unmatched };
  } catch (e) {
    const message = e instanceof IntegrationError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : "error";
    await ctx.tx.update(schema.segmentDestinations).set({ status: "error", lastSyncAt: now, lastError: message.slice(0, 300) }).where(eq(schema.segmentDestinations.id, destinationId));
    return { status: "error", added: 0, removed: 0, members: current.size, unmatched, error: message };
  }
}

/** Auto-sync destinations of the given segments (after a live re-evaluation). */
export async function syncAutoDestinations(ctx: ServiceContext, segmentIds: string[], destinationFor: (provider: AudienceProvider) => AudienceDestination, opts: { excludeHoldout: boolean }): Promise<DestinationSyncResult[]> {
  if (!segmentIds.length) return [];
  const rows = await ctx.tx.select({ id: schema.segmentDestinations.id, provider: schema.segmentDestinations.provider }).from(schema.segmentDestinations).where(and(eq(schema.segmentDestinations.tenantId, ctx.tenantId), eq(schema.segmentDestinations.autoSync, true), inArray(schema.segmentDestinations.segmentId, segmentIds)));
  const out: DestinationSyncResult[] = [];
  for (const r of rows) out.push(await syncSegmentDestination(ctx, r.id, destinationFor(r.provider as AudienceProvider), opts));
  return out;
}
