export interface OperatorDay {
  userId: string;
  hoursToday: number;
  assignedToday: number;
}

/** Hours an operator works on a given day, honouring an exception (`off` or `extra`). */
export function hoursFor(dailyHours: readonly number[], dow: number, exception: { kind: "off" | "extra"; hours: number | null } | null): number {
  if (exception?.kind === "off") return 0;
  if (exception?.kind === "extra") return exception.hours ?? Math.max(dailyHours[dow] ?? 0, 4);
  return dailyHours[dow] ?? 0;
}

/**
 * Smooth weighted round-robin: the operator furthest below their fair share (hours / team hours)
 * once this assignment is counted gets the order. Ties: more hours, then stable user id.
 */
export function nextOperator(available: readonly OperatorDay[]): string | null {
  const pool = available.filter((a) => a.hoursToday > 0);
  if (!pool.length) return null;
  const team = pool.reduce((s, a) => s + a.hoursToday, 0);
  const total = pool.reduce((s, a) => s + a.assignedToday, 0);
  let best: { userId: string; debt: number; hours: number } | null = null;
  for (const a of pool) {
    const debt = (a.hoursToday / team) * (1 + total) - a.assignedToday;
    if (!best || debt > best.debt || (debt === best.debt && (a.hoursToday > best.hours || (a.hoursToday === best.hours && a.userId < best.userId)))) best = { userId: a.userId, debt, hours: a.hoursToday };
  }
  return best?.userId ?? null;
}

/** Local weekday (0 = Sunday) and ISO date for a tenant timezone. */
export function localDay(now: Date, timezone: string): { dow: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { dow: dow < 0 ? now.getUTCDay() : dow, date: `${get("year")}-${get("month")}-${get("day")}` };
}
