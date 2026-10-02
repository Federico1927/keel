import type { Period } from "@hullwise/core";

export interface PeriodParams {
  from?: string;
  to?: string;
  preset?: string;
}

export interface ResolvedPeriod extends Period {
  preset: string | undefined;
}

/** Resolves preset/from/to search params into a half-open [from, to) period in the tenant timezone. */
export function resolvePeriod(sp: PeriodParams, timezone: string, defaultPreset = "30d"): ResolvedPeriod {
  const now = new Date();
  const todayLocal = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const endOfToday = new Date(now.getTime() + 60_000);
  const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5);
  const preset = sp.preset ?? (sp.from ? undefined : defaultPreset);
  if (preset === "7d") return { from: daysAgo(7), to: endOfToday, preset };
  if (preset === "90d") return { from: daysAgo(90), to: endOfToday, preset };
  if (preset === "mtd") return { from: new Date(Date.UTC(todayLocal.getFullYear(), todayLocal.getMonth(), 1)), to: endOfToday, preset };
  if (preset === "ytd") return { from: new Date(Date.UTC(todayLocal.getFullYear(), 0, 1)), to: endOfToday, preset };
  if (sp.from && !Number.isNaN(Date.parse(sp.from))) {
    const to = sp.to && !Number.isNaN(Date.parse(sp.to)) ? new Date(new Date(sp.to).getTime() + 864e5) : endOfToday;
    return { from: new Date(sp.from), to, preset: undefined };
  }
  return { from: daysAgo(30), to: endOfToday, preset: "30d" };
}

/** Search params that reproduce a resolved period (preset wins over explicit dates). */
export function periodParams(period: ResolvedPeriod, sp: PeriodParams): Record<string, string | undefined> {
  return period.preset ? { preset: period.preset } : { from: sp.from, to: sp.to };
}
