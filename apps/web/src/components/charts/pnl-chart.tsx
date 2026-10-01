"use client";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Categorical series colours: tokens of the design system, so a palette change needs no code change. */
export const SERIES_COLORS = [
  "var(--color-chart-1, var(--color-primary))",
  "var(--color-chart-2, var(--color-accent-foreground))",
  "var(--color-chart-3, var(--color-info))",
  "var(--color-chart-4, var(--color-warning))",
  "var(--color-chart-5, var(--color-success))",
  "var(--color-chart-6, var(--color-muted-foreground))",
  "var(--color-chart-7, var(--color-sidebar-accent))",
];
const GRID = "var(--color-border)";
const INK = "var(--color-muted-foreground)";
const PROFIT = "var(--color-chart-profit, var(--color-foreground))";

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
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} minTickGap={16} />
          <YAxis tick={{ fontSize: 11, fill: INK }} width={64} tickFormatter={(v: number) => money.format(v)} />
          <Tooltip labelFormatter={(l, p) => `${String(l)}${p?.[0]?.payload?.partial ? ` · ${partialLabel}` : ""}`} formatter={(v, name) => [money.format(Number(v)), names[String(name)] ?? String(name)]} />
          <Legend formatter={(v: string) => names[v] ?? v} wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} stackId="costs" fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="var(--color-card)" strokeWidth={1}>
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
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK }} minTickGap={16} />
          <YAxis tick={{ fontSize: 11, fill: INK }} width={64} tickFormatter={(v: number) => money.format(v)} />
          <Tooltip formatter={(v, name) => [money.format(Number(v)), labels[String(name)] ?? String(name)]} />
          <Legend formatter={(v: string) => labels[v] ?? v} wrapperStyle={{ fontSize: 12 }} />
          {keys.map((k, i) => <Bar key={k} dataKey={k} stackId="trend" fill={SERIES_COLORS[i % SERIES_COLORS.length]} stroke="var(--color-card)" strokeWidth={1} />)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
