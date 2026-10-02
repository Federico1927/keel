import { isMultiAccountAdPlatform, AD_ACCOUNT_LIMIT, type MultiAccountAdPlatform } from "@hullwise/config";
import { and, asc, desc, eq, ne, recordAudit, schema, sql, type AuditInput } from "@hullwise/db";
import { normalizeMetaAccountId } from "@hullwise/core";
import type { ServiceContext } from "../context";

/**
 * Several ad accounts per platform and store (#82, Meta only). The integration row is the platform
 * connection and its account is the primary one; `ad_accounts` mirrors it and holds the others, each
 * with its own credentials reference, cursor, status and last error. Rows synced before accounts
 * existed carry no account and belong to the primary one.
 */

export type AdAccountRow = typeof schema.adAccounts.$inferSelect;
export type AdAccountAuditActor = Pick<AuditInput, "actorUserId" | "actorType" | "impersonatedBy">;

/** What the sync and the adapter factory need to address one account. */
export interface AdAccountScope {
  externalId: string;
  primary: boolean;
}

export class AdAccountError extends Error {
  constructor(readonly code: "not_found" | "primary" | "limit" | "invalid_input" | "not_connected") {
    super(code);
    this.name = "AdAccountError";
  }
}

/** The account on the integration row, normalized (null when the platform is not connected). */
export async function primaryAdAccountId(ctx: ServiceContext, provider: string): Promise<string | null> {
  const [row] = await ctx.tx.select({ status: schema.integrations.status, externalAccountId: schema.integrations.externalAccountId }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, provider))).limit(1);
  if (!row?.externalAccountId || row.status === "not_connected") return null;
  return provider === "meta" ? normalizeMetaAccountId(row.externalAccountId) : row.externalAccountId;
}

/**
 * Mirrors the integration's account as the primary `ad_accounts` row (idempotent; a reconnection to
 * another account moves the flag). Existing single-account stores get their row the first time the
 * accounts are listed or synced, without a data migration.
 */
export async function ensurePrimaryAdAccount(ctx: ServiceContext, provider: MultiAccountAdPlatform): Promise<AdAccountRow | null> {
  const [integ] = await ctx.tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, provider))).limit(1);
  if (!integ?.externalAccountId || integ.status === "not_connected") return null;
  const externalId = normalizeMetaAccountId(integ.externalAccountId);
  const [existing] = await ctx.tx.select().from(schema.adAccounts).where(and(eq(schema.adAccounts.tenantId, ctx.tenantId), eq(schema.adAccounts.provider, provider), eq(schema.adAccounts.externalAccountId, externalId))).limit(1);
  if (existing?.isPrimary && existing.status !== "not_connected") return existing;
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.adAccounts).set({ isPrimary: false, updatedAt: now }).where(and(eq(schema.adAccounts.tenantId, ctx.tenantId), eq(schema.adAccounts.provider, provider), eq(schema.adAccounts.isPrimary, true), ne(schema.adAccounts.externalAccountId, externalId)));
  const values = { isPrimary: true, status: existing && existing.status !== "not_connected" ? existing.status : "connected", mode: integ.mode, name: existing?.name ?? integ.externalAccountName ?? externalId, updatedAt: now };
  const [row] = await ctx.tx.insert(schema.adAccounts).values({ tenantId: ctx.tenantId, provider, externalAccountId: externalId, lastSyncAt: integ.lastSyncAt, lastSuccessAt: integ.lastSuccessAt, ...values }).onConflictDoUpdate({ target: [schema.adAccounts.tenantId, schema.adAccounts.provider, schema.adAccounts.externalAccountId], set: values }).returning();
  return row ?? null;
}

/** The platform's accounts, primary first, while the platform is connected; removed ones only with `includeRemoved` (they still name their campaigns). */
export async function listAdAccounts(ctx: ServiceContext, provider: MultiAccountAdPlatform, opts: { includeRemoved?: boolean } = {}): Promise<AdAccountRow[]> {
  // accounts live under the platform connection: none while it is disconnected
  if (!(await ensurePrimaryAdAccount(ctx, provider))) return [];
  const conds = [eq(schema.adAccounts.tenantId, ctx.tenantId), eq(schema.adAccounts.provider, provider)];
  if (!opts.includeRemoved) conds.push(ne(schema.adAccounts.status, "not_connected"));
  return ctx.tx.select().from(schema.adAccounts).where(and(...conds)).orderBy(desc(schema.adAccounts.isPrimary), asc(schema.adAccounts.name));
}

/** Account names by external id for every platform that has accounts (campaign lists, filters). */
export async function adAccountNames(ctx: ServiceContext): Promise<{ provider: string; externalId: string; name: string; primary: boolean; connected: boolean }[]> {
  const rows = await ctx.tx.select({ provider: schema.adAccounts.provider, externalId: schema.adAccounts.externalAccountId, name: schema.adAccounts.name, primary: schema.adAccounts.isPrimary, status: schema.adAccounts.status }).from(schema.adAccounts).where(eq(schema.adAccounts.tenantId, ctx.tenantId)).orderBy(desc(schema.adAccounts.isPrimary), asc(schema.adAccounts.name));
  return rows.map((r) => ({ provider: r.provider, externalId: r.externalId, name: r.name, primary: r.primary, connected: r.status !== "not_connected" }));
}

/** One account by id or external id (connected or not). */
export async function getAdAccount(ctx: ServiceContext, provider: string, ref: { id?: string; externalId?: string }): Promise<AdAccountRow | null> {
  const conds = [eq(schema.adAccounts.tenantId, ctx.tenantId), eq(schema.adAccounts.provider, provider)];
  if (ref.id) conds.push(eq(schema.adAccounts.id, ref.id));
  else if (ref.externalId) conds.push(eq(schema.adAccounts.externalAccountId, ref.externalId));
  else return null;
  const [row] = await ctx.tx.select().from(schema.adAccounts).where(and(...conds)).limit(1);
  return row ?? null;
}

/**
 * Adds (or reconnects) an account. `credentialsEncrypted` null shares the integration's token; the
 * primary account is the integration itself and cannot be added twice.
 */
export async function addAdAccount(ctx: ServiceContext, provider: string, input: { externalAccountId: string; name: string; mode: "mock" | "live"; credentialsEncrypted: string | null }, actor?: AdAccountAuditActor): Promise<AdAccountRow> {
  if (!isMultiAccountAdPlatform(provider)) throw new AdAccountError("invalid_input");
  const externalId = normalizeMetaAccountId(input.externalAccountId);
  if (!/^act_[A-Za-z0-9_]{1,40}$/.test(externalId)) throw new AdAccountError("invalid_input");
  const primary = await ensurePrimaryAdAccount(ctx, provider);
  if (!primary) throw new AdAccountError("not_connected");
  if (primary.externalAccountId === externalId) throw new AdAccountError("primary");
  const connected = await listAdAccounts(ctx, provider);
  const existing = await getAdAccount(ctx, provider, { externalId });
  if (!existing || existing.status === "not_connected") {
    if (connected.length >= AD_ACCOUNT_LIMIT) throw new AdAccountError("limit");
  }
  const now = ctx.now ?? new Date();
  const values = { name: input.name.trim().slice(0, 120) || externalId, status: "connected", mode: input.mode, credentialsEncrypted: input.credentialsEncrypted, lastError: null, isPrimary: false, updatedAt: now };
  const [row] = await ctx.tx.insert(schema.adAccounts).values({ tenantId: ctx.tenantId, provider, externalAccountId: externalId, ...values }).onConflictDoUpdate({ target: [schema.adAccounts.tenantId, schema.adAccounts.provider, schema.adAccounts.externalAccountId], set: values }).returning();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...(actor ?? { actorUserId: ctx.actor.userId }), action: "ad_account.added", entityType: "ad_account", entityId: row!.id, diff: { status: { from: existing?.status ?? null, to: "connected" }, account: { from: null, to: externalId } }, metadata: { provider, mode: input.mode, ownCredentials: input.credentialsEncrypted !== null } });
  return row!;
}

/** Stops syncing an account and drops its credentials; its campaigns and history stay, under its name. */
export async function removeAdAccount(ctx: ServiceContext, provider: string, accountId: string, actor?: AdAccountAuditActor): Promise<AdAccountRow> {
  const row = await getAdAccount(ctx, provider, { id: accountId });
  if (!row || row.status === "not_connected") throw new AdAccountError("not_found");
  if (row.isPrimary) throw new AdAccountError("primary");
  const now = ctx.now ?? new Date();
  const [updated] = await ctx.tx.update(schema.adAccounts).set({ status: "not_connected", credentialsEncrypted: null, lastError: null, updatedAt: now }).where(eq(schema.adAccounts.id, row.id)).returning();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...(actor ?? { actorUserId: ctx.actor.userId }), action: "ad_account.removed", entityType: "ad_account", entityId: row.id, diff: { status: { from: row.status, to: "not_connected" } }, metadata: { provider, account: row.externalAccountId } });
  return updated!;
}

/** Outcome of a pull or a connection test on the account row: status, last success, last error and the cursor. */
export async function recordAdAccountRun(ctx: ServiceContext, provider: string, externalId: string, outcome: { ok: boolean; error?: string | null; window?: { since: string; until: string }; lastMetricDate?: string | null; name?: string | null }): Promise<void> {
  const now = ctx.now ?? new Date();
  const row = await getAdAccount(ctx, provider, { externalId });
  if (!row || row.status === "not_connected") return;
  const cursor = outcome.window ? { ...(row.cursor as Record<string, unknown>), since: outcome.window.since, until: outcome.window.until, ...(outcome.lastMetricDate ? { lastMetricDate: outcome.lastMetricDate } : {}) } : row.cursor;
  await ctx.tx.update(schema.adAccounts).set(outcome.ok ? { status: "connected", lastSyncAt: outcome.window ? now : row.lastSyncAt, lastSuccessAt: now, lastError: null, cursor, ...(outcome.name ? { name: outcome.name } : {}), updatedAt: now } : { status: "error", lastSyncAt: outcome.window ? now : row.lastSyncAt, lastError: (outcome.error ?? "error").slice(0, 500), updatedAt: now }).where(eq(schema.adAccounts.id, row.id));
}

/** Health sources of an account: the primary keeps the platform's own (`meta`, `meta:entities`), the others `meta:<account>`. */
export function adAccountHealthSource(provider: string, account: AdAccountScope | null | undefined, part?: "entities"): string {
  const base = account && !account.primary ? `${provider}:${account.externalId}` : provider;
  return part ? `${base}:${part}` : base;
}

/** Campaign ids of one account: its own, plus the rows without an account when it is the primary. */
export async function campaignIdsOfAccount(ctx: ServiceContext, provider: string, account: AdAccountScope): Promise<string[]> {
  const rows = await ctx.tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), eq(schema.campaigns.platform, provider), account.primary ? sql`(${schema.campaigns.accountExternalId} = ${account.externalId} or ${schema.campaigns.accountExternalId} is null)` : eq(schema.campaigns.accountExternalId, account.externalId)));
  return rows.map((r) => r.id);
}

/** Accounts a sync job should pull: every connected account, or the one asked for. */
export async function adAccountsToSync(ctx: ServiceContext, provider: MultiAccountAdPlatform, only?: string | null): Promise<AdAccountScope[]> {
  const rows = await listAdAccounts(ctx, provider);
  return rows.filter((r) => !only || r.externalAccountId === only).map((r) => ({ externalId: r.externalAccountId, primary: r.isPrimary }));
}


/** The integrations card (#82): connected accounts with their campaign count (the primary one counts the campaigns synced before accounts). */
export async function adAccountsOverview(ctx: ServiceContext, provider: MultiAccountAdPlatform): Promise<(AdAccountRow & { campaigns: number })[]> {
  const rows = await listAdAccounts(ctx, provider);
  if (!rows.length) return [];
  const counts = await ctx.tx.select({ account: schema.campaigns.accountExternalId, n: sql<number>`count(*)::int` }).from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), eq(schema.campaigns.platform, provider))).groupBy(schema.campaigns.accountExternalId);
  const orphan = counts.find((c) => c.account === null)?.n ?? 0;
  return rows.map((r) => ({ ...r, campaigns: (counts.find((c) => c.account === r.externalAccountId)?.n ?? 0) + (r.isPrimary ? orphan : 0) }));
}
