"use client";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "./theme";

/** Categorical series colours from the theme tokens (follow light/dark and the tenant brand colour). */
export const SERIES_COLORS = [...CHART_COLORS, "var(--muted)"];
const GRID = CHART_GRID;
const PROFIT = "var(--fg)";

export interface PnlChartPoint {
  label: string;
  partial: boolean;
  /** Costs in minor units, positive. */
  costs: Record<string, number>;
  profitMinor: number;
}

/** Stacked cost bars per bucket and the operating profit line, one money axis. Partial buckets are drawn faded. */
export function PnlChart({ data, series, profitLabel, partialLabel, locale, currency }: { data: PnlChartPoint[]; series: { key: string; label: string }[]; profitLabel: string; partialLabel: string; locale: string; currency: string }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const rows = data.map((d) => ({ label: d.label, partial: d.partial, profit: d.profitMinor / 100, ...Object.fromEntries(series.map((s) => [s.key, (d.costs[s.key] ?? 0) / 100])) }));
  const names = Object.fromEntries([...series.map((s) => [s.key, s.label]), ["profit", profitLabel]]);
  return (
    <div className="h-72 w-full" data-testid="pnl-chart">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} stroke={GRID} minTickGap={16} />
          <YAxis tick={AXIS_TICK} stroke={GRID} width={64} tickFormatter={(v: number) => money.format(v)} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={(l, p) => `${String(l)}${p?.[0]?.payload?.partial ? ` · ${partialLabel}` : ""}`} formatter={(v, name) => [money.format(Number(v)), names[String(name)] ?? String(name)]} />
          <Legend formatter={(v: string) => names[v] ?? v} wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} stackId="costs" fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="var(--surface)" strokeWidth={1}>
              {rows.map((r) => <Cell key={r.label} fillOpacity={r.partial ? 0.45 : 1} />)}
            </Bar>
          ))}
          <Line type="monotone" dataKey="profit" stroke={PROFIT} strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Net revenue per key (channel) over time, stacked bars on one money axis. */
export function TrendChart({ data, keys, labels, locale, currency }: { data: { label: string; values: Record<string, number> }[]; keys: string[]; labels: Record<string, string>; locale: string; currency: string }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const rows = data.map((d) => ({ label: d.label, ...Object.fromEntries(keys.map((k) => [k, (d.values[k] ?? 0) / 100])) }));
  return (
    <div className="h-64 w-full" data-testid="channel-trend">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} stroke={GRID} minTickGap={16} />
          <YAxis tick={AXIS_TICK} stroke={GRID} width={64} tickFormatter={(v: number) => money.format(v)} />
          <Tooltip {...TOOLTIP_PROPS} formatter={(v, name) => [money.format(Number(v)), labels[String(name)] ?? String(name)]} />
          <Legend formatter={(v: string) => labels[v] ?? v} wrapperStyle={{ fontSize: 12 }} />
          {keys.map((k, i) => <Bar key={k} dataKey={k} stackId="trend" fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="var(--surface)" strokeWidth={1} />)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
