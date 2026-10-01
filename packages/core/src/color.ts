/**
 * Colour helpers for themes and tenant branding: WCAG 2.x relative luminance and contrast ratio,
 * and the automatic adjustment of a brand colour so that text and controls on it stay readable
 * (AA) on the light and on the dark theme. Pure, no DOM.
 */

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** WCAG AA minimum for normal text. */
export const AA_TEXT = 4.5;
/** WCAG AA minimum for large text and for the boundaries of controls and graphics (1.4.11). */
export const AA_UI = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** `#rrggbb` (or `#rgb`) → channels 0..255; null when the string is not a colour. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbOf(color: string | Rgb): Rgb {
  if (typeof color !== "string") return color;
  const rgb = parseHex(color);
  if (!rgb) throw new Error(`Not a hex colour: ${color}`);
  return rgb;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = rgbOf(color);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` drawn with `alpha` over `bg` (e.g. a 15 % tinted badge background). */
export function mixColors(fg: string, bg: string, alpha: number): string {
  const f = rgbOf(fg);
  const b = rgbOf(bg);
  return toHex({ r: f.r * alpha + b.r * (1 - alpha), g: f.g * alpha + b.g * (1 - alpha), b: f.b * alpha + b.b * (1 - alpha) });
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p: number, q: number, t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}

/** Lowest contrast of `color` against any of `backgrounds`. */
export function minContrast(color: string, backgrounds: readonly string[]): number {
  return Math.min(...backgrounds.map((b) => contrastRatio(color, b)));
}

/**
 * Moves the lightness of `color` (hue and saturation kept) in `direction` by the smallest step
 * that reaches `min` contrast against every background. Returns the colour unchanged when it
 * already passes, and black/white as the last resort.
 */
export function ensureContrast(color: string, backgrounds: readonly string[], min: number, direction: "darken" | "lighten"): string {
  const base = toHex(rgbOf(color));
  if (minContrast(base, backgrounds) >= min) return base;
  const hsl = rgbToHsl(rgbOf(base));
  for (let step = 1; step <= 100; step++) {
    const l = direction === "darken" ? hsl.l - step / 200 : hsl.l + step / 200;
    if (l < 0 || l > 1) break;
    const candidate = toHex(hslToRgb({ ...hsl, l }));
    if (minContrast(candidate, backgrounds) >= min) return candidate;
  }
  return direction === "darken" ? "#000000" : "#ffffff";
}

/** The candidate text colour with the highest contrast on `background`. */
export function readableOn(background: string, candidates: readonly string[] = ["#ffffff", "#000000"]): string {
  return [...candidates].sort((a, b) => contrastRatio(b, background) - contrastRatio(a, background))[0]!;
}

export interface ThemeSurfaces {
  /** Page background, card surface and the tinted surface: the brand colour must read on all. */
  surfaces: readonly string[];
  /** Text colours offered for labels on the brand colour (white and the theme's ink). */
  onCandidates: readonly string[];
  direction: "darken" | "lighten";
}

export interface BrandColors {
  primary: string;
  onPrimary: string;
  /** True when the colour had to be made lighter or darker to pass AA. */
  adjusted: boolean;
}

/**
 * Brand colour for one theme: the colour is used for button fills (with `onPrimary` labels), for
 * links and active states on the theme surfaces, and for the focus ring. It is adjusted until
 * every one of those pairs reaches AA for normal text.
 */
export function brandColorsFor(brand: string, theme: ThemeSurfaces): BrandColors {
  const original = toHex(rgbOf(brand));
  let primary = ensureContrast(original, theme.surfaces, AA_TEXT, theme.direction);
  let onPrimary = readableOn(primary, theme.onCandidates);
  // a mid-tone can pass on the surfaces and still be too weak for its own label: push further
  if (contrastRatio(primary, onPrimary) < AA_TEXT) {
    primary = ensureContrast(primary, [onPrimary, ...theme.surfaces], AA_TEXT, theme.direction);
    onPrimary = readableOn(primary, theme.onCandidates);
  }
  return { primary, onPrimary, adjusted: primary !== original };
}
