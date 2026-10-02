import { CHART_COLORS } from "./theme";

/**
 * Trend line under a KPI: plain SVG, no chart library (#49 performance), so a dashboard of KPI
 * tiles renders on the server and ships no chart code. Missing points (null) are skipped and the
 * line joins over them, as the chart it replaces did (`connectNulls`).
 */
export function Sparkline({ values }: { values: (number | null)[] }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (pts.length < 2) return <div className="h-8 w-full" aria-hidden />;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys);
  const span = Math.max(...ys) - min || 1;
  const n = Math.max(values.length - 1, 1);
  // 100×32 box, 2px vertical padding; the stroke keeps its width when the box stretches
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${((i / n) * 100).toFixed(2)},${(30 - ((v - min) / span) * 28).toFixed(2)}`).join("");
  return (
    <svg className="block h-8 w-full" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden focusable="false" data-testid="sparkline">
      <path d={d} fill="none" stroke={CHART_COLORS[0]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
