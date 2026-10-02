import { getAdsPlatformFor, getCommercePlatformFor, resetMockPlatforms } from "@keel/services";
import type { AdPlatform } from "@keel/core";
import type { AdsPlatform, CommercePlatform } from "@keel/integrations";
import type { TenantContext } from "./tenant";

/** Thin wrappers over the shared factory so pages and actions keep a one-line call. */
export async function getCommercePlatform(ctx: TenantContext): Promise<CommercePlatform> {
  return ctx.run((tx) => getCommercePlatformFor({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.tenant));
}

export async function getAdsPlatform(ctx: TenantContext, provider: AdPlatform): Promise<AdsPlatform> {
  return ctx.run((tx) => getAdsPlatformFor({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.tenant, provider));
}

export function resetMockAdapters(): void {
  resetMockPlatforms();
}
