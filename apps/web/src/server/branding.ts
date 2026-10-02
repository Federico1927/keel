import { cache, type CSSProperties } from "react";
import { brandColorsFor, isHexColor, type BrandColors } from "@hullwise/core";
import { withTenant } from "@hullwise/db";
import { getTenantBranding, type TenantBranding } from "@hullwise/services";
import { BRAND_SURFACES, TOKENS } from "@hullwise/ui/tokens";

/**
 * Tenant branding as the web app uses it: the brand colour made AA-safe for each theme (core
 * `brandColorsFor`), and public URLs for the logos. Public pages (return portal, tracking,
 * supplier, survey) take it as their default and apply their own overrides on top.
 */
export interface Brand {
  brandColor: string | null;
  light: BrandColors;
  dark: BrandColors;
  logoLight: string | null;
  logoDark: string | null;
}

export function logoUrl(slug: string, variant: "light" | "dark", version: number): string {
  return `/brand/${encodeURIComponent(slug)}/${variant}?v=${version}`;
}

export function toBrand(slug: string, b: TenantBranding): Brand {
  const color = b.brandColor && isHexColor(b.brandColor) ? b.brandColor : null;
  return {
    brandColor: color,
    light: color ? brandColorsFor(color, BRAND_SURFACES.light) : { primary: TOKENS.light.primary, onPrimary: TOKENS.light["on-primary"], adjusted: false },
    dark: color ? brandColorsFor(color, BRAND_SURFACES.dark) : { primary: TOKENS.dark.primary, onPrimary: TOKENS.dark["on-primary"], adjusted: false },
    logoLight: b.logoLight ? logoUrl(slug, "light", b.logoLight.version) : null,
    // a missing dark logo falls back to the light one
    logoDark: b.logoDark ? logoUrl(slug, "dark", b.logoDark.version) : b.logoLight ? logoUrl(slug, "light", b.logoLight.version) : null,
  };
}

/** Branding of one tenant, read once per request. */
export const loadBrand = cache(async (tenantId: string, slug: string): Promise<Brand> => {
  const b = await withTenant(tenantId, (tx) => getTenantBranding({ tenantId, tx, actor: { type: "system", userId: null } }));
  return toBrand(slug, b);
});

/** CSS that swaps the primary token for the brand colour in both themes; empty without a brand colour. */
export function brandCss(brand: Brand): string {
  if (!brand.brandColor) return "";
  const vars = (c: BrandColors) => `--primary:${c.primary};--on-primary:${c.onPrimary};--chart-1:${c.primary};`;
  return `:root{${vars(brand.light)}}.dark{${vars(brand.dark)}}`;
}

/**
 * Colour and logo for a public, tenant-branded page (always light): the page's own override if
 * set, else the tenant branding, else the product default. The colour is AA-adjusted either way.
 */
export function publicBrand(brand: Brand, override: { color?: string | null; logoUrl?: string | null } = {}): { primary: string; onPrimary: string; logoUrl: string | null } {
  const own = override.color && isHexColor(override.color) ? brandColorsFor(override.color, BRAND_SURFACES.light) : null;
  const c = own ?? brand.light;
  return { primary: c.primary, onPrimary: c.onPrimary, logoUrl: override.logoUrl || brand.logoLight };
}

/** Inline style for a public page root: brand colour as the primary token of that (light) subtree. */
export function brandStyle(b: { primary: string; onPrimary: string }): CSSProperties {
  return { ["--primary" as string]: b.primary, ["--on-primary" as string]: b.onPrimary };
}
