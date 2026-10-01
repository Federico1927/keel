"use server";
import { revalidatePath } from "next/cache";
import { BrandingError, saveBrandColor, saveBrandLogo, type LogoVariant } from "@keel/services";
import { ForbiddenError, requireAction } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { processImage } from "@/server/images";

async function withBranding(slug: string, fn: (s: Parameters<typeof saveBrandColor>[0]) => Promise<void>): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    await ctx.run((tx) => fn({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }));
    revalidatePath(`/t/${slug}`, "layout");
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    if (e instanceof BrandingError) return fail(e.code);
    throw e;
  }
}

export async function saveBrandColorAction(slug: string, color: string | null): Promise<ActionResult> {
  return withBranding(slug, (s) => saveBrandColor(s, color));
}

/** Logos are re-encoded to WebP within 600×200 (wide marks stay sharp in the 28px sidebar slot at 2×). */
export async function uploadBrandLogoAction(slug: string, variant: LogoVariant, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const file = fd.get("logo");
  if (!(file instanceof File) || file.size === 0) return fail("invalid_input");
  const image = await processImage(file, { width: 600, height: 200, fit: "inside" });
  if (!image.ok) return fail(image.error);
  return withBranding(slug, (s) => saveBrandLogo(s, variant, image.image));
}

export async function removeBrandLogoAction(slug: string, variant: LogoVariant): Promise<ActionResult> {
  return withBranding(slug, (s) => saveBrandLogo(s, variant, null));
}
