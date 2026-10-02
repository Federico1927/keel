import { asc, desc, eq, schema } from "@hullwise/db";
import type { ServiceContext } from "@hullwise/services";
import type { TenantContext } from "@/server/tenant";

/** Service context for the signed-in user inside a tenant transaction. */
export const svcOf = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });

/** Locations for pickers: default first, then by name. */
export function stockLocations(ctx: TenantContext) {
  return ctx.run((tx) => tx.select({ id: schema.locations.id, name: schema.locations.name }).from(schema.locations).where(eq(schema.locations.tenantId, ctx.tenant.id)).orderBy(desc(schema.locations.isDefault), asc(schema.locations.name)));
}
