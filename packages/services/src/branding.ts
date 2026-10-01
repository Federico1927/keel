import { eq, recordAudit, schema } from "@keel/db";
import { diffRecords, hasChanges, isHexColor } from "@keel/core";
import type { ServiceContext } from "./context";

/**
 * Tenant branding (#44): one row per tenant with the brand colour and two logos (for light and
 * dark backgrounds). The app uses the colour as its primary token (adjusted for AA per theme by
 * `brandColorsFor`); the public pages use colour and logo unless their own settings override them.
 */
export interface TenantBranding {
  brandColor: string | null;
  logoLight: { version: number } | null;
  logoDark: { version: number } | null;
  updatedAt: Date | null;
}

export const LOGO_VARIANTS = ["light", "dark"] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];

export class BrandingError extends Error {
  constructor(readonly code: "invalid_color") {
    super(code);
    this.name = "BrandingError";
  }
}

export async function getTenantBranding(ctx: ServiceContext): Promise<TenantBranding> {
  const b = schema.tenantBranding;
  const [row] = await ctx.tx
    .select({ brandColor: b.brandColor, light: b.logoLightType, dark: b.logoDarkType, updatedAt: b.updatedAt })
    .from(b)
    .where(eq(b.tenantId, ctx.tenantId))
    .limit(1);
  if (!row) return { brandColor: null, logoLight: null, logoDark: null, updatedAt: null };
  const version = row.updatedAt.getTime();
  return { brandColor: row.brandColor, logoLight: row.light ? { version } : null, logoDark: row.dark ? { version } : null, updatedAt: row.updatedAt };
}

async function upsert(ctx: ServiceContext, set: Partial<typeof schema.tenantBranding.$inferInsert>) {
  await ctx.tx
    .insert(schema.tenantBranding)
    .values({ tenantId: ctx.tenantId, ...set, updatedBy: ctx.actor.userId })
    .onConflictDoUpdate({ target: schema.tenantBranding.tenantId, set: { ...set, updatedBy: ctx.actor.userId, updatedAt: ctx.now ?? new Date() } });
}

/** Sets or clears (null) the brand colour, as `#rrggbb`. */
export async function saveBrandColor(ctx: ServiceContext, color: string | null): Promise<void> {
  const value = color ? color.toLowerCase() : null;
  if (value !== null && !isHexColor(value)) throw new BrandingError("invalid_color");
  const before = await getTenantBranding(ctx);
  const diff = diffRecords({ brandColor: before.brandColor }, { brandColor: value });
  if (!hasChanges(diff)) return;
  await upsert(ctx, { brandColor: value });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "branding.color_updated", entityType: "tenant_branding", entityId: ctx.tenantId, diff });
}

/** Stores an already validated and resized logo; null removes it. */
export async function saveBrandLogo(ctx: ServiceContext, variant: LogoVariant, image: { data: Buffer; contentType: string } | null): Promise<void> {
  const before = await getTenantBranding(ctx);
  const had = variant === "light" ? before.logoLight !== null : before.logoDark !== null;
  const set = variant === "light" ? { logoLightData: image?.data ?? null, logoLightType: image?.contentType ?? null } : { logoDarkData: image?.data ?? null, logoDarkType: image?.contentType ?? null };
  await upsert(ctx, set);
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: image ? "branding.logo_updated" : "branding.logo_removed", entityType: "tenant_branding", entityId: ctx.tenantId, diff: { [`logo_${variant}`]: { from: had ? "set" : null, to: image ? "set" : null } }, metadata: image ? { bytes: image.data.length, contentType: image.contentType } : {} });
}

/** The logo bytes for the public logo route; the dark variant falls back to the light one. */
export async function getBrandLogo(ctx: ServiceContext, variant: LogoVariant): Promise<{ data: Buffer; contentType: string; updatedAt: Date } | null> {
  const b = schema.tenantBranding;
  const [row] = await ctx.tx.select().from(b).where(eq(b.tenantId, ctx.tenantId)).limit(1);
  if (!row) return null;
  if (variant === "dark" && row.logoDarkData && row.logoDarkType) return { data: row.logoDarkData, contentType: row.logoDarkType, updatedAt: row.updatedAt };
  if (row.logoLightData && row.logoLightType) return { data: row.logoLightData, contentType: row.logoLightType, updatedAt: row.updatedAt };
  return null;
}
