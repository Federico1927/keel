import { and, asc, eq, or, schema } from "@keel/db";
import type { ServiceContext } from "../context";
import { canonicalQuery } from "@keel/core";

export interface SavedView {
  id: string;
  name: string;
  query: string;
  isShared: boolean;
  ownerUserId: string;
  mine: boolean;
}

export class SavedViewError extends Error {
  constructor(public readonly code: "invalid_name" | "not_found" | "forbidden") {
    super(code);
  }
}

/** Views of one list the user can open: their own and the tenant's shared ones (shared first, then by name). */
export async function listSavedViews(ctx: ServiceContext, pageKey: string, userId: string): Promise<SavedView[]> {
  const rows = await ctx.tx.select().from(schema.savedViews).where(and(eq(schema.savedViews.tenantId, ctx.tenantId), eq(schema.savedViews.pageKey, pageKey), or(eq(schema.savedViews.ownerUserId, userId), eq(schema.savedViews.isShared, true)))).orderBy(asc(schema.savedViews.name));
  return rows.map((r) => ({ id: r.id, name: r.name, query: r.query, isShared: r.isShared, ownerUserId: r.ownerUserId, mine: r.ownerUserId === userId })).sort((a, b) => Number(b.isShared) - Number(a.isShared) || a.name.localeCompare(b.name));
}

/**
 * Saves the current filters under a name. Saving again with a name the user already used on this
 * list replaces that view (its filters and sharing), so "update view" is the same gesture.
 */
export async function saveView(ctx: ServiceContext, input: { pageKey: string; name: string; query: string; isShared: boolean; userId: string }): Promise<{ id: string; replaced: boolean }> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) throw new SavedViewError("invalid_name");
  const query = canonicalQuery(input.query).slice(0, 2000);
  const now = ctx.now ?? new Date();
  const [existing] = await ctx.tx.select({ id: schema.savedViews.id }).from(schema.savedViews).where(and(eq(schema.savedViews.tenantId, ctx.tenantId), eq(schema.savedViews.pageKey, input.pageKey), eq(schema.savedViews.ownerUserId, input.userId), eq(schema.savedViews.name, name))).limit(1);
  if (existing) {
    await ctx.tx.update(schema.savedViews).set({ query, isShared: input.isShared, updatedAt: now }).where(eq(schema.savedViews.id, existing.id));
    return { id: existing.id, replaced: true };
  }
  const [row] = await ctx.tx.insert(schema.savedViews).values({ tenantId: ctx.tenantId, pageKey: input.pageKey, name, query, ownerUserId: input.userId, isShared: input.isShared, createdAt: now, updatedAt: now }).returning({ id: schema.savedViews.id });
  return { id: row!.id, replaced: false };
}

/** The owner deletes their views; owners and admins (`canManageShared`) may also delete shared views of others. */
export async function deleteView(ctx: ServiceContext, viewId: string, userId: string, canManageShared: boolean): Promise<{ name: string; pageKey: string; query: string; isShared: boolean }> {
  const [view] = await ctx.tx.select().from(schema.savedViews).where(and(eq(schema.savedViews.tenantId, ctx.tenantId), eq(schema.savedViews.id, viewId))).limit(1);
  if (!view || (view.ownerUserId !== userId && !view.isShared)) throw new SavedViewError("not_found");
  if (view.ownerUserId !== userId && !canManageShared) throw new SavedViewError("forbidden");
  await ctx.tx.delete(schema.savedViews).where(eq(schema.savedViews.id, viewId));
  return { name: view.name, pageKey: view.pageKey, query: view.query, isShared: view.isShared };
}
