import { and, eq, inArray, recordAudit, schema } from "@hullwise/db";
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, isNotificationType, resolveNotificationChannels, type NotificationChannel, type NotificationType, type NotificationTypeDefinition } from "@hullwise/config";
import type { ServiceContext } from "../context";
import { clearUnsubscribes } from "../email/suppressions";

type Overrides = Partial<Record<NotificationChannel, boolean>>;
const COLUMN = { in_app: "inApp", email: "email", slack: "slack" } as const;

function toOverrides(row: { inApp: boolean | null; email: boolean | null; slack: boolean | null }): Overrides {
  const o: Overrides = {};
  if (row.inApp !== null) o.in_app = row.inApp;
  if (row.email !== null) o.email = row.email;
  if (row.slack !== null) o.slack = row.slack;
  return o;
}

/** Overrides of several users for one type (missing user = defaults). */
export async function preferenceOverridesFor(ctx: ServiceContext, userIds: string[], type: string): Promise<Map<string, Overrides>> {
  if (!userIds.length) return new Map();
  const rows = await ctx.tx.select().from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.tenantId, ctx.tenantId), eq(schema.notificationPreferences.type, type), inArray(schema.notificationPreferences.userId, userIds)));
  return new Map(rows.map((r) => [r.userId, toOverrides(r)]));
}

export interface PreferenceRow {
  type: NotificationType;
  group: NotificationTypeDefinition["group"];
  channels: Record<NotificationChannel, { allowed: boolean; enabled: boolean; isDefault: boolean }>;
}

/** The preferences page: every visible type × channel with its effective value. */
export async function preferenceMatrix(ctx: ServiceContext, userId: string, types: readonly NotificationType[]): Promise<PreferenceRow[]> {
  const rows = await ctx.tx.select().from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.tenantId, ctx.tenantId), eq(schema.notificationPreferences.userId, userId)));
  const by = new Map(rows.map((r) => [r.type, toOverrides(r)]));
  return types.map((type) => {
    const def: NotificationTypeDefinition = NOTIFICATION_TYPES[type];
    const o = by.get(type) ?? {};
    const eff = resolveNotificationChannels(type, o);
    const channels = Object.fromEntries(NOTIFICATION_CHANNELS.map((c) => [c, { allowed: def.channels.includes(c), enabled: eff[c], isDefault: o[c] === undefined }])) as PreferenceRow["channels"];
    return { type, group: def.group, channels };
  });
}

/**
 * Sets one cell (null = back to the default). Switching email back on also lifts an unsubscribe
 * the person made from an email link for that type, so the two never disagree.
 */
export async function setNotificationPreference(ctx: ServiceContext, userId: string, type: string, channel: NotificationChannel, enabled: boolean | null): Promise<void> {
  if (!isNotificationType(type)) throw new Error("invalid_type");
  const def: NotificationTypeDefinition = NOTIFICATION_TYPES[type];
  if (!def.channels.includes(channel)) throw new Error("invalid_channel");
  const [existing] = await ctx.tx.select().from(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.tenantId, ctx.tenantId), eq(schema.notificationPreferences.userId, userId), eq(schema.notificationPreferences.type, type))).limit(1);
  const col = COLUMN[channel];
  const before = existing ? existing[col] : null;
  if (existing) await ctx.tx.update(schema.notificationPreferences).set({ [col]: enabled, updatedAt: ctx.now ?? new Date() }).where(eq(schema.notificationPreferences.id, existing.id));
  else await ctx.tx.insert(schema.notificationPreferences).values({ tenantId: ctx.tenantId, userId, type, [col]: enabled });
  if (channel === "email" && enabled === true) {
    const [u] = await ctx.tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (u) await ctx.tx.delete(schema.emailSuppressions).where(and(eq(schema.emailSuppressions.tenantId, ctx.tenantId), eq(schema.emailSuppressions.email, u.email.toLowerCase()), eq(schema.emailSuppressions.reason, "unsubscribe"), inArray(schema.emailSuppressions.category, [type, "all"])));
  }
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "notification_preference.changed", entityType: "user", entityId: userId, diff: { [`${type}.${channel}`]: { from: before, to: enabled } } });
}

/** Unsubscribe link of a member: the preference follows the suppression (all optional types when the category is `all`). */
export async function applyUnsubscribeToPreferences(ctx: ServiceContext, email: string, category: string): Promise<void> {
  const [u] = await ctx.tx.select({ id: schema.users.id }).from(schema.users).innerJoin(schema.tenantMemberships, and(eq(schema.tenantMemberships.userId, schema.users.id), eq(schema.tenantMemberships.tenantId, ctx.tenantId))).where(eq(schema.users.email, email.toLowerCase())).limit(1);
  if (!u) return;
  const types = category === "all" ? (Object.keys(NOTIFICATION_TYPES) as NotificationType[]).filter((t) => (NOTIFICATION_TYPES[t] as NotificationTypeDefinition).channels.includes("email")) : isNotificationType(category) ? [category] : [];
  for (const type of types) {
    await ctx.tx.insert(schema.notificationPreferences).values({ tenantId: ctx.tenantId, userId: u.id, type, email: false }).onConflictDoUpdate({ target: [schema.notificationPreferences.tenantId, schema.notificationPreferences.userId, schema.notificationPreferences.type], set: { email: false, updatedAt: ctx.now ?? new Date() } });
  }
}

/** Resets every override of a user (all types back to defaults). */
export async function resetNotificationPreferences(ctx: ServiceContext, userId: string): Promise<void> {
  await ctx.tx.delete(schema.notificationPreferences).where(and(eq(schema.notificationPreferences.tenantId, ctx.tenantId), eq(schema.notificationPreferences.userId, userId)));
  const [u] = await ctx.tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (u) await clearUnsubscribes(ctx, u.email);
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "notification_preference.reset", entityType: "user", entityId: userId });
}
