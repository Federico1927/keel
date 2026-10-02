import { isAdPlatform } from "@hullwise/core";
import { and, eq, recordAudit, schema, type AuditInput } from "@hullwise/db";
import type { ServiceContext } from "../context";
import { adPlatformInPlan, adsWriteAccess, integrationRow } from "../integrations/factory";
import { enqueuePlatformWrite } from "../writes";
import type { PlatformWriteRow } from "../writes/registry";

/** Who acts, as the web layer records it (impersonation included); defaults to the context actor. */
export type AdsAuditActor = Pick<AuditInput, "actorUserId" | "actorType" | "impersonatedBy">;

export type AdsWriteOutcome = { ok: true; write: PlatformWriteRow | null } | { ok: false; error: "not_found" | "ads_read_only" | "invalid_input" };

/** Whether the tenant lets Hullwise write to this ads platform below the campaign (Meta and TikTok always; Google once the write scope is granted). */
export async function canWriteAds(ctx: ServiceContext, provider: string): Promise<boolean> {
  return adsWriteAccess(provider, await integrationRow(ctx, provider));
}

/**
 * Pause or resume a campaign after the user confirmed (Meta, TikTok; Google campaigns are read-only and
 * refused before anything changes): local status, audit and the outbox write in one transaction.
 */
export async function requestCampaignStatus(ctx: ServiceContext, campaignId: string, status: "active" | "paused", actor?: AdsAuditActor): Promise<AdsWriteOutcome> {
  const [c] = await ctx.tx.select().from(schema.campaigns).where(and(eq(schema.campaigns.tenantId, ctx.tenantId), eq(schema.campaigns.id, campaignId))).limit(1);
  if (!c) return { ok: false, error: "not_found" };
  const provider = c.platform;
  if (!isAdPlatform(provider) || !(await adPlatformInPlan(ctx, provider))) return { ok: false, error: "invalid_input" };
  if (c.status === status) return { ok: true, write: null };
  if (provider === "google") return { ok: false, error: "ads_read_only" };
  await ctx.tx.update(schema.campaigns).set({ status, updatedAt: ctx.now ?? new Date() }).where(eq(schema.campaigns.id, c.id));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...(actor ?? { actorUserId: ctx.actor.userId }), action: status === "paused" ? "campaign.paused" : "campaign.resumed", entityType: "campaign", entityId: c.id, diff: { status: { from: c.status, to: status } } });
  const write = await enqueuePlatformWrite(ctx, { kind: "campaign.status", entityType: "campaign", entityId: c.id, payload: { provider, campaignExternalId: c.externalId, status } });
  return { ok: true, write };
}

/**
 * Pause or resume one ad after the user confirmed: local status, audit and the outbox write in one
 * transaction (the caller dispatches the write after the commit).
 */
export async function requestAdStatus(ctx: ServiceContext, adId: string, status: "active" | "paused", actor?: AdsAuditActor): Promise<AdsWriteOutcome> {
  const [ad] = await ctx.tx.select({ a: schema.adCreatives, adSetExt: schema.adSets.externalId }).from(schema.adCreatives).leftJoin(schema.adSets, eq(schema.adSets.id, schema.adCreatives.adSetId)).where(and(eq(schema.adCreatives.tenantId, ctx.tenantId), eq(schema.adCreatives.id, adId))).limit(1);
  if (!ad) return { ok: false, error: "not_found" };
  const provider = ad.a.platform;
  if (!isAdPlatform(provider) || !(await adPlatformInPlan(ctx, provider))) return { ok: false, error: "invalid_input" };
  if (!(await canWriteAds(ctx, provider))) return { ok: false, error: "ads_read_only" };
  if (ad.a.status === status) return { ok: true, write: null };
  await ctx.tx.update(schema.adCreatives).set({ status, updatedAt: ctx.now ?? new Date() }).where(eq(schema.adCreatives.id, adId));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...(actor ?? { actorUserId: ctx.actor.userId }), action: status === "paused" ? "ad.paused" : "ad.resumed", entityType: "ad", entityId: adId, diff: { status: { from: ad.a.status, to: status } } });
  const write = await enqueuePlatformWrite(ctx, { kind: "ad.status", entityType: "ad", entityId: adId, payload: { provider, adExternalId: ad.a.externalId, adSetExternalId: ad.adSetExt ?? ad.a.adsetExternalId, status } });
  return { ok: true, write };
}

/**
 * Adds a search term as a negative keyword (Google, write scope granted) after the user confirmed:
 * the term is marked excluded, audited and the write queued. `level` picks the campaign or the term's ad group.
 */
export async function requestNegativeKeyword(ctx: ServiceContext, searchTermId: string, opts: { matchType: "exact" | "phrase" | "broad"; level: "campaign" | "ad_group" }, actor?: AdsAuditActor): Promise<AdsWriteOutcome> {
  const [t] = await ctx.tx.select({ t: schema.adSearchTerms, campaignExt: schema.campaigns.externalId, adSetExt: schema.adSets.externalId }).from(schema.adSearchTerms).innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.adSearchTerms.campaignId)).leftJoin(schema.adSets, eq(schema.adSets.id, schema.adSearchTerms.adSetId)).where(and(eq(schema.adSearchTerms.tenantId, ctx.tenantId), eq(schema.adSearchTerms.id, searchTermId))).limit(1);
  if (!t) return { ok: false, error: "not_found" };
  if (t.t.isOther || t.t.platform !== "google") return { ok: false, error: "invalid_input" };
  if (!(await canWriteAds(ctx, "google"))) return { ok: false, error: "ads_read_only" };
  if (t.t.status === "excluded") return { ok: true, write: null };
  const adSetExternalId = opts.level === "ad_group" ? (t.adSetExt ?? null) : null;
  await ctx.tx.update(schema.adSearchTerms).set({ status: "excluded", updatedAt: ctx.now ?? new Date() }).where(eq(schema.adSearchTerms.id, searchTermId));
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...(actor ?? { actorUserId: ctx.actor.userId }), action: "search_term.negative_added", entityType: "search_term", entityId: searchTermId, diff: { status: { from: t.t.status, to: "excluded" } }, metadata: { text: t.t.text, matchType: opts.matchType, level: opts.level } });
  const write = await enqueuePlatformWrite(ctx, { kind: "keyword.negative", entityType: "search_term", entityId: searchTermId, payload: { provider: "google", campaignExternalId: t.campaignExt, adSetExternalId, text: t.t.text, matchType: opts.matchType } });
  return { ok: true, write };
}
