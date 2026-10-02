/**
 * Product screens used by the landing. The capture names match `scripts/capture-product.mjs`;
 * `scripts/optimize-images.mjs` turns each capture into the WebP widths listed per role.
 */
export const SCREENSHOT_ROLES = {
  hero: { widths: [800, 1440, 2400] },
  card: { widths: [800, 1440] },
} as const;
export type ScreenshotRole = keyof typeof SCREENSHOT_ROLES;

/** All captures are 16:10. */
export const SCREENSHOT_ASPECT = { width: 1440, height: 900 } as const;

export const SCREENSHOTS: Record<string, ScreenshotRole> = {
  dashboard: "hero",
  campaigns: "card",
  "analytics-pl": "card",
  orders: "card",
  shipments: "card",
  inventory: "card",
  purchasing: "card",
  returns: "card",
  discounts: "card",
  rfm: "card",
  assistant: "card",
};

export function screenshotSrcSet(
  locale: string,
  name: string,
  role: ScreenshotRole,
): { src: string; srcSet: string } {
  const widths = SCREENSHOT_ROLES[role].widths;
  const url = (w: number) => `/screenshots/${locale}/${name}-${w}.webp`;
  return { src: url(widths[0]), srcSet: widths.map((w) => `${url(w)} ${w}w`).join(", ") };
}
