"use server";
import { revalidatePath } from "next/cache";
import { markAllRead } from "@keel/services";
import { getTenantContext } from "@/server/tenant";

export async function markNotificationsRead(slug: string): Promise<void> {
  const ctx = await getTenantContext(slug);
  await ctx.run((tx) => markAllRead({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, ctx.user.id));
  revalidatePath(`/t/${slug}`, "layout");
}
