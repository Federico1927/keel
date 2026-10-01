"use client";
import { Bar, BarChart, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function RevenueChart({ data, locale, currency, ordersLabel }: { data: { day: string; orders: number; grossRevenueMinor: number }[]; locale: string; currency: string; ordersLabel: string }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const rows = data.map((d) => ({ ...d, revenue: d.grossRevenueMinor / 100 }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(40 12% 88%)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={(d: string) => date.format(new Date(d))} tick={{ fontSize: 11 }} minTickGap={28} />
          <YAxis yAxisId="rev" tick={{ fontSize: 11 }} width={56} tickFormatter={(v: number) => money.format(v)} />
          <YAxis yAxisId="ord" orientation="right" tick={{ fontSize: 11 }} width={28} allowDecimals={false} />
          <Tooltip labelFormatter={(d) => date.format(new Date(String(d)))} formatter={(v, name) => (name === "revenue" ? money.format(Number(v)) : `${v} ${ordersLabel}`)} />
          <Bar yAxisId="rev" dataKey="revenue" fill="hsl(205 55% 40%)" radius={[3, 3, 0, 0]} />
          <Line yAxisId="ord" type="monotone" dataKey="orders" stroke="hsl(28 60% 45%)" strokeWidth={2} dot={false} />
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
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={24} />
          <Tooltip />
          <Bar dataKey="value" fill="hsl(205 55% 40%)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
