import { and, asc, eq, recordAudit, schema, type DbExecutor } from "@hullwise/db";
import { MODULES, canActivateAddon, isAddonModule, releasedVersion, type PlanKey } from "@hullwise/config";
import { desiredSubscriptionKeys, hasItemChanges, subscriptionItemChanges } from "@hullwise/core";
import { BillingProviderError, type BillingProvider } from "@hullwise/integrations";
import { recordLifecycleEvent } from "./lifecycle";
import { applySubscriptionSnapshot, BillingError, priceIdFor } from "./mirror";
import { getBillingProvider } from "./provider";

/**
 * Plans and add-ons (#48, #53). Hullwise decides entitlements; when the tenant has a Stripe
 * subscription its items follow, with proration: the processor is written first, so a refused
 * change leaves Hullwise untouched (the console shows the error).
 */

async function activeAddons(db: DbExecutor, tenantId: string): Promise<string[]> {
  return (await db.select({ k: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.isActive, true))).orderBy(asc(schema.tenantAddons.moduleKey))).map((r) => r.k);
}

/** Pushes the plan and add-ons Hullwise wants onto the Stripe subscription items (no-op without a live subscription or when in step). */
export async function syncSubscriptionItems(db: DbExecutor, tenantId: string, want: { planKey: PlanKey; addons: readonly string[] }, opts: { provider?: BillingProvider; actorUserId: string | null; now?: Date }): Promise<{ changed: boolean }> {
  const now = opts.now ?? new Date();
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.tenantId, tenantId)).limit(1);
  if (!sub?.externalSubscriptionId || sub.externalStatus === "canceled" || sub.externalStatus === "incomplete_expired") return { changed: false };
  const provider = opts.provider ?? getBillingProvider();
  const changes = subscriptionItemChanges(sub.items, desiredSubscriptionKeys(want.planKey, want.addons));
  if (!hasItemChanges(changes)) return { changed: false };
  const price = (k: string) => priceIdFor(db, provider.provider, k);
  const add = await Promise.all(changes.add.map(price));
  const swap = await Promise.all(changes.swap.map(async (s) => ({ itemId: s.itemId, priceId: await price(s.lookupKey) })));
  try {
    const snap = await provider.updateSubscriptionItems(sub.externalSubscriptionId, { add, remove: changes.remove, swap, currentItems: sub.items }, `hullwise-items-${sub.externalSubscriptionId}-${[...changes.add, ...changes.remove, ...changes.swap.map((s) => s.lookupKey)].join("+")}-${now.getTime()}`);
    // the mock answers with the items only (empty status): the rest stays as mirrored
    const merged = snap.status ? snap : { ...snap, customerId: sub.externalCustomerId ?? "", status: sub.externalStatus ?? "active", collectionMethod: sub.collectionMethod === "send_invoice" ? ("send_invoice" as const) : ("charge_automatically" as const), currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, trialEnd: sub.trialEndsAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd };
    await applySubscriptionSnapshot(db, tenantId, merged, { provider: sub.provider, now, actorUserId: opts.actorUserId });
  } catch (e) {
    if (e instanceof BillingProviderError) throw new BillingError("provider_failed");
    throw e;
  }
  return { changed: true };
}

export async function setTenantPlan(db: DbExecutor, tenantId: string, planKey: PlanKey, actorUserId: string, now = new Date(), opts: { provider?: BillingProvider } = {}): Promise<void> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (!tenant) throw new Error("tenant_not_found");
  await syncSubscriptionItems(db, tenantId, { planKey, addons: await activeAddons(db, tenantId) }, { provider: opts.provider, actorUserId, now });
  await db.update(schema.tenants).set({ planKey, updatedAt: now }).where(eq(schema.tenants.id, tenantId));
  await db.update(schema.subscriptions).set({ planKey, updatedAt: now }).where(eq(schema.subscriptions.tenantId, tenantId));
  await recordAudit(db, { tenantId, actorUserId, actorType: "super_admin", action: "tenant.plan_changed", entityType: "tenant", entityId: tenantId, diff: { planKey: { from: tenant.planKey, to: planKey } } });
  if (tenant.planKey !== planKey) await recordLifecycleEvent(db, tenantId, { from: tenant.status, to: tenant.status, reason: "plan_changed", actorUserId, now });
}

export async function setTenantAddon(db: DbExecutor, tenantId: string, moduleKey: string, active: boolean, actorUserId: string, note?: string | null, now = new Date(), opts: { provider?: BillingProvider } = {}): Promise<void> {
  if (!isAddonModule(moduleKey) || MODULES[moduleKey].availability !== "implemented") throw new Error("addon_not_available");
  const [existing] = await db.select().from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, tenantId), eq(schema.tenantAddons.moduleKey, moduleKey))).limit(1);
  // switching on needs a released version (#77); switching off, or saving the note of an active add-on, never does
  if (active && !existing?.isActive && !canActivateAddon(moduleKey)) throw new Error("addon_not_released");
  const version = active && !existing?.isActive ? (releasedVersion(moduleKey)?.version ?? null) : (existing?.version ?? null);
  const [tenant] = await db.select({ status: schema.tenants.status, planKey: schema.tenants.planKey }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  if (tenant && (existing?.isActive ?? false) !== active) {
    const current = await activeAddons(db, tenantId);
    await syncSubscriptionItems(db, tenantId, { planKey: tenant.planKey as PlanKey, addons: active ? [...current, moduleKey] : current.filter((k) => k !== moduleKey) }, { provider: opts.provider, actorUserId, now });
  }
  if (existing) await db.update(schema.tenantAddons).set({ isActive: active, activatedAt: active ? now : existing.activatedAt, deactivatedAt: active ? null : now, note: note ?? existing.note, activatedBy: actorUserId, version, updatedAt: now }).where(eq(schema.tenantAddons.id, existing.id));
  else if (active) await db.insert(schema.tenantAddons).values({ tenantId, moduleKey, isActive: true, activatedAt: now, note: note ?? null, activatedBy: actorUserId, version });
  await recordAudit(db, { tenantId, actorUserId, actorType: "super_admin", action: active ? "tenant.addon_enabled" : "tenant.addon_disabled", entityType: "tenant_addon", entityId: moduleKey, diff: { isActive: { from: existing?.isActive ?? false, to: active } }, metadata: { note: note ?? null, version } });
  if ((existing?.isActive ?? false) !== active && tenant) await recordLifecycleEvent(db, tenantId, { from: tenant.status, to: tenant.status, reason: "addons_changed", note: note ?? null, actorUserId, now });
}
