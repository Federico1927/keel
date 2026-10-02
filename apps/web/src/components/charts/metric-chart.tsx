"use client";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MetricFormat } from "@hullwise/config";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "./theme";
import { compactAxis, useCompactChart } from "./use-compact";

export interface MetricChartSeries {
  key: string;
  label: string;
  format: MetricFormat;
  /** Raw values (minor units for money, fractions for percent). */
  values: (number | null)[];
}

function formatter(format: MetricFormat, locale: string, currency: string, compact = false) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0, ...(compact ? { notation: "compact" as const } : {}) });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  return (v: number) => (format === "money" ? money.format(v) : format === "percent" ? pct.format(v) : format === "ratio" ? `${num.format(v)}×` : num.format(v));
}

/**
 * Time-series widget: 1–3 metrics per bucket, as lines or bars. Money goes on the left axis, other
 * units (rates, ratios, counts) on the right one, so mixed metrics stay readable.
 */
export function MetricChart({ labels, series, chart, locale, currency, height = 240 }: { labels: string[]; series: MetricChartSeries[]; chart: "line" | "bar"; locale: string; currency: string; height?: number }) {
  const leftFormat: MetricFormat = series.find((s) => s.format === "money") ? "money" : (series[0]?.format ?? "number");
  const axisOf = (s: MetricChartSeries) => (s.format === leftFormat ? "left" : "right");
  const rightFormat = series.find((s) => axisOf(s) === "right")?.format ?? null;
  const rows = labels.map((label, i) => ({ label, ...Object.fromEntries(series.map((s) => [s.key, s.values[i] === null || s.values[i] === undefined ? null : s.format === "money" ? s.values[i]! / 100 : s.values[i]])) }));
  const fmt = Object.fromEntries(series.map((s) => [s.key, formatter(s.format, locale, currency)]));
  const names = Object.fromEntries(series.map((s) => [s.key, s.label]));
  const compact = useCompactChart();
  const ax = compactAxis(compact);
  return (
    <div className="w-full" style={{ height }} data-testid="metric-chart">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} stroke={CHART_GRID} minTickGap={ax.x.minTickGap} />
          <YAxis yAxisId="left" tick={AXIS_TICK} stroke={CHART_GRID} width={ax.y.width} tickCount={ax.y.tickCount} tickFormatter={formatter(leftFormat, locale, currency, compact)} />
          {rightFormat && <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} stroke={CHART_GRID} width={compact ? 36 : 48} tickCount={ax.y.tickCount} tickFormatter={formatter(rightFormat, locale, currency, compact)} />}
          <Tooltip {...TOOLTIP_PROPS} formatter={(v, name) => [v === null || v === undefined ? "—" : fmt[String(name)]!(Number(v)), names[String(name)] ?? String(name)]} />
          {series.length > 1 && !compact && <Legend formatter={(v: string) => names[v] ?? v} wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) =>
            chart === "bar" ? (
              <Bar key={s.key} yAxisId={axisOf(s)} dataKey={s.key} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[3, 3, 0, 0]} />
            ) : (
              <Line key={s.key} yAxisId={axisOf(s)} type="monotone" dataKey={s.key} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={false} connectNulls />
            ),
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Tiny trend line under a KPI value. */
export function Sparkline({ values }: { values: (number | null)[] }) {
  const rows = values.map((v, i) => ({ i, v }));
  return (
    <div className="h-8 w-full" aria-hidden>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <Line type="monotone" dataKey="v" stroke={CHART_COLORS[0]} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
