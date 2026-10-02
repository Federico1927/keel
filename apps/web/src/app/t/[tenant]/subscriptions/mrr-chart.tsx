"use client";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "@/components/charts/theme";

export interface MrrChartRow { month: string; newMinor: number; expansionMinor: number; reactivatedMinor: number; contractionMinor: number; churnedMinor: number; endMrrMinor: number }

/** MRR movement by month: gains stacked up, losses stacked down, MRR at month end as a line. */
export function MrrMovementChart({ rows, locale, currency, labels }: { rows: MrrChartRow[]; locale: string; currency: string; labels: Record<"new" | "expansion" | "reactivated" | "contraction" | "churned" | "end", string> }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const month = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  const data = rows.map((r) => ({ month: r.month, new: r.newMinor / 100, expansion: r.expansionMinor / 100, reactivated: r.reactivatedMinor / 100, contraction: -r.contractionMinor / 100, churned: -r.churnedMinor / 100, end: r.endMrrMinor / 100 }));
  const label = (m: string) => month.format(new Date(`${m}-01T00:00:00Z`));
  return (
    <div className="h-72 w-full" data-testid="mrr-chart">
      <ResponsiveContainer>
        <ComposedChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="month" tickFormatter={label} tick={AXIS_TICK} stroke={CHART_GRID} />
          <YAxis yAxisId="move" tick={AXIS_TICK} stroke={CHART_GRID} width={64} tickFormatter={(v: number) => money.format(v)} />
          <YAxis yAxisId="mrr" orientation="right" tick={AXIS_TICK} stroke={CHART_GRID} width={64} tickFormatter={(v: number) => money.format(v)} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={(m) => label(String(m))} formatter={(v, name) => [money.format(Math.abs(Number(v))), labels[name as keyof typeof labels] ?? String(name)]} />
          <Bar yAxisId="move" dataKey="new" stackId="m" fill={CHART_COLORS[0]} />
          <Bar yAxisId="move" dataKey="expansion" stackId="m" fill={CHART_COLORS[1]} />
          <Bar yAxisId="move" dataKey="reactivated" stackId="m" fill={CHART_COLORS[2]} />
          <Bar yAxisId="move" dataKey="contraction" stackId="m" fill={CHART_COLORS[3]} />
          <Bar yAxisId="move" dataKey="churned" stackId="m" fill={CHART_COLORS[4]} />
          <Line yAxisId="mrr" type="monotone" dataKey="end" stroke={CHART_COLORS[5]} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
