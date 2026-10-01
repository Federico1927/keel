import { CHART_AXIS, CHART_COLORS as COLORS, CHART_GRID as GRID } from "@keel/ui/tokens";

/**
 * Recharts styling from the theme tokens: CSS variables in SVG attributes, so charts switch with
 * the theme (and the tenant's brand colour for series 1) without re-rendering. Never raw colours.
 */
export const CHART_COLORS = COLORS;
export const CHART_GRID = GRID;
export const AXIS_TICK = { fontSize: 11, fill: CHART_AXIS };
export const TOOLTIP_PROPS = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--fg)", fontSize: 12 },
  labelStyle: { color: "var(--muted)" },
  itemStyle: { color: "var(--fg)" },
  cursor: { fill: "var(--surface-2)", stroke: "var(--line)" },
} as const;
