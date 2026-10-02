"use client";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "@/components/charts/theme";

/** MRR (bars) and paying tenants (line) by month for the console metrics (#48). */
export function MrrChart({ data, locale, currency, labels }: { data: { month: string; mrrMinor: number; active: number }[]; locale: string; currency: string; labels: { mrr: string; active: string } }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const month = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  const rows = data.map((d) => ({ ...d, mrr: d.mrrMinor / 100 }));
  const label = (m: string) => month.format(new Date(`${m}-01T00:00:00Z`));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="month" tickFormatter={label} tick={AXIS_TICK} stroke={CHART_GRID} />
          <YAxis yAxisId="mrr" tick={AXIS_TICK} stroke={CHART_GRID} width={64} tickFormatter={(v: number) => money.format(v)} />
          <YAxis yAxisId="n" orientation="right" tick={AXIS_TICK} stroke={CHART_GRID} width={28} allowDecimals={false} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={(m) => label(String(m))} formatter={(v, name) => (name === "mrr" ? [money.format(Number(v)), labels.mrr] : [String(v), labels.active])} />
          <Bar yAxisId="mrr" dataKey="mrr" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
          <Line yAxisId="n" type="monotone" dataKey="active" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
