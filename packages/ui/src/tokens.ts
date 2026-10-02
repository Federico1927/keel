/**
 * Design tokens of direction A ("Modern SaaS", decided 2026-10-01, issue #44): Geist, white
 * surfaces, a light sidebar, one vivid blue, 8px corners, pill badges, light and dark themes.
 *
 * `tokens.css` declares the same values as CSS custom properties (`--<name>`); a unit test keeps
 * the two in sync and checks every text/control pair for WCAG AA. Values that differ from the
 * committente's starting table were adjusted by that check (see docs/DECISIONS.md).
 */

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/** Cookie mirroring the signed-in user's theme, used to render signed-out pages (login) without a flash. */
export const THEME_COOKIE = "hullwise_theme";

export interface ThemeTokens {
  bg: string;
  surface: string;
  "surface-2": string;
  fg: string;
  muted: string;
  line: string;
  /** Boundary of inputs and other controls: 3:1 against the surfaces (WCAG 1.4.11). */
  "line-strong": string;
  primary: string;
  "on-primary": string;
  success: string;
  "on-success": string;
  warning: string;
  "on-warning": string;
  danger: string;
  "on-danger": string;
  info: string;
  "on-info": string;
  /** Super-admin console accent ("platform mode", #48): never used inside a tenant. */
  platform: string;
  "on-platform": string;
  sidebar: string;
  "sidebar-fg": string;
  "sidebar-muted": string;
  "sidebar-accent": string;
  "chart-1": string;
  "chart-2": string;
  "chart-3": string;
  "chart-4": string;
  "chart-5": string;
  "chart-6": string;
  "chart-grid": string;
}

export const TOKENS: Record<Theme, ThemeTokens> = {
  light: {
    bg: "#f7f8fa",
    surface: "#ffffff",
    "surface-2": "#f1f3f6",
    fg: "#0b0d12",
    muted: "#5b6170",
    line: "#e4e7ec",
    "line-strong": "#8391a8",
    primary: "#2b59ff",
    "on-primary": "#ffffff",
    // starting values #138a52 / #a76100 / #d22f2f, darkened until they read on the surfaces and on their own badge tint
    success: "#107244",
    "on-success": "#ffffff",
    warning: "#935500",
    "on-warning": "#ffffff",
    danger: "#ba2929",
    "on-danger": "#ffffff",
    info: "#1649ff",
    "on-info": "#ffffff",
    platform: "#6d28d9",
    "on-platform": "#ffffff",
    sidebar: "#ffffff",
    "sidebar-fg": "#0b0d12",
    "sidebar-muted": "#5b6170",
    "sidebar-accent": "#f1f3f6",
    // Okabe-Ito hues (colour-blind safe), each at least 3:1 on the card surface
    "chart-1": "#2b59ff",
    "chart-2": "#bb8100",
    "chart-3": "#009e73",
    "chart-4": "#d55e00",
    "chart-5": "#c870a1",
    "chart-6": "#1c93d7",
    "chart-grid": "#e4e7ec",
  },
  dark: {
    bg: "#0b0d12",
    surface: "#12151c",
    "surface-2": "#181c25",
    fg: "#eef0f5",
    muted: "#9aa1b2",
    line: "#232836",
    "line-strong": "#566285",
    primary: "#5b7cff",
    "on-primary": "#0b0d12",
    success: "#3fcf8e",
    "on-success": "#0b0d12",
    warning: "#f0a640",
    "on-warning": "#0b0d12",
    danger: "#ff6b6b",
    "on-danger": "#0b0d12",
    info: "#6886ff",
    "on-info": "#0b0d12",
    platform: "#a78bfa",
    "on-platform": "#0b0d12",
    sidebar: "#12151c",
    "sidebar-fg": "#eef0f5",
    "sidebar-muted": "#9aa1b2",
    "sidebar-accent": "#181c25",
    "chart-1": "#5b7cff",
    "chart-2": "#e69f00",
    "chart-3": "#009e73",
    "chart-4": "#d55e00",
    "chart-5": "#cc79a7",
    "chart-6": "#56b4e9",
    "chart-grid": "#232836",
  },
};

/** Surfaces a brand colour must read on, per theme, and the label colours offered on it. */
export const BRAND_SURFACES: Record<Theme, { surfaces: string[]; onCandidates: string[]; direction: "darken" | "lighten" }> = {
  light: { surfaces: [TOKENS.light.bg, TOKENS.light.surface, TOKENS.light["surface-2"]], onCandidates: ["#ffffff", TOKENS.light.fg], direction: "darken" },
  dark: { surfaces: [TOKENS.dark.bg, TOKENS.dark.surface, TOKENS.dark["surface-2"]], onCandidates: [TOKENS.dark.bg, "#ffffff"], direction: "lighten" },
};

/** Categorical chart colours as CSS variables: they follow the theme without re-rendering. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"] as const;
export const CHART_GRID = "var(--chart-grid)";
export const CHART_AXIS = "var(--muted)";

export function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === "string" && (THEME_PREFERENCES as readonly string[]).includes(v);
}
export function isDensity(v: unknown): v is Density {
  return typeof v === "string" && (DENSITIES as readonly string[]).includes(v);
}

/**
 * Inline script for the `system` preference: resolves the OS theme before the first paint and
 * follows later changes. Explicit light/dark are rendered by the server and need no script.
 */
export const SYSTEM_THEME_SCRIPT =
  "(function(){try{var m=window.matchMedia('(prefers-color-scheme: dark)'),d=document.documentElement;var a=function(){if(d.getAttribute('data-theme')==='system'){d.classList.toggle('dark',m.matches)}};a();m.addEventListener('change',a)}catch(e){}})();";
