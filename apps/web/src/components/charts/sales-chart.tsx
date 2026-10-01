"use client";
import { AXIS_TICK, CHART_COLORS, CHART_GRID, TOOLTIP_PROPS } from "./theme";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function SalesChart({ data, locale, currency }: { data: { day: string; units: number; revenue: number }[]; locale: string; currency: string }) {
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="units" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="day" tickFormatter={(d: string) => date.format(new Date(d))} tick={AXIS_TICK} stroke={CHART_GRID} minTickGap={24} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} stroke={CHART_GRID} width={28} />
          <Tooltip {...TOOLTIP_PROPS} labelFormatter={(d) => date.format(new Date(String(d)))} formatter={(v, name) => (name === "revenue" ? fmt.format(Number(v) / 100) : v)} />
          <Area type="monotone" dataKey="units" stroke={CHART_COLORS[0]} fill="url(#units)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
