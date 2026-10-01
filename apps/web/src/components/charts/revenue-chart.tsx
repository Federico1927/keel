"use client";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "./theme";
import { Bar, BarChart, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function RevenueChart({ data, locale, currency, ordersLabel }: { data: { day: string; orders: number; grossRevenueMinor: number }[]; locale: string; currency: string; ordersLabel: string }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const rows = data.map((d) => ({ ...d, revenue: d.grossRevenueMinor / 100 }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="day" tickFormatter={(d: string) => date.format(new Date(d))} tick={AXIS_TICK} stroke={CHART_GRID} minTickGap={28} />
          <YAxis yAxisId="rev" tick={AXIS_TICK} stroke={CHART_GRID} width={56} tickFormatter={(v: number) => money.format(v)} />
          <YAxis yAxisId="ord" orientation="right" tick={AXIS_TICK} stroke={CHART_GRID} width={28} allowDecimals={false} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={(d) => date.format(new Date(String(d)))} formatter={(v, name) => (name === "revenue" ? money.format(Number(v)) : `${v} ${ordersLabel}`)} />
          <Bar yAxisId="rev" dataKey="revenue" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
          <Line yAxisId="ord" type="monotone" dataKey="orders" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MiniBars({ data }: { data: { label: string; value: number }[] }) {
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ ...AXIS_TICK, fontSize: 10 }} stroke={CHART_GRID} interval={0} />
          <YAxis allowDecimals={false} tick={{ ...AXIS_TICK, fontSize: 10 }} stroke={CHART_GRID} width={24} />
          <Tooltip {...TOOLTIP_PROPS} />
          <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
