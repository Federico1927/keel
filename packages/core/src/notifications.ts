import { TO_SHIP_STATUSES, businessDaysElapsed, type LateToShipOptions } from "./fulfilment";

/** Pure checks behind the system notifications (sync delay, late to ship, critical stock without incoming PO). */

/** A source is late when its last success is older than its freshness window plus the tenant's grace; never-synced sources count from when they were connected. */
export function isSyncDelayed(i: { lastSuccessAt: Date | null; connectedAt: Date | null; freshnessMinutes: number; graceMinutes: number; now: Date }): { delayed: boolean; minutesLate: number } {
  const since = i.lastSuccessAt ?? i.connectedAt;
  if (!since) return { delayed: false, minutesLate: 0 };
  const limit = (Math.max(1, i.freshnessMinutes) + Math.max(0, i.graceMinutes)) * 60e3;
  const age = i.now.getTime() - since.getTime();
  return { delayed: age > limit, minutesLate: Math.max(0, Math.round((age - limit) / 60e3)) };
}

export { TO_SHIP_STATUSES };

/**
 * An order still to ship whose wait is over the tenant's threshold, in working days of the tenant's
 * time zone (`businessDaysElapsed`). The clock starts when the order was placed: "ready to ship" is
 * the canonical status, the same for every payment method.
 */
export function isLateToShip(o: { status: string; placedAt: Date }, opts: LateToShipOptions, now: Date): boolean {
  if (!(TO_SHIP_STATUSES as readonly string[]).includes(o.status)) return false;
  return businessDaysElapsed(o.placedAt, now, opts.timeZone, opts.workdays) > opts.thresholdDays;
}

/** Critical stock that nobody is fixing: selling, at risk, and nothing on order. */
export function isCriticalWithoutIncoming(v: { risk: string; incoming: number; unitsSold: number }): boolean {
  return v.risk === "critical" && v.incoming <= 0 && v.unitsSold > 0;
}

/** Groups unread notifications by type for the daily digest, most frequent first. */
export function digestSummary(items: readonly { type: string; title: string }[], maxPerType = 3): { type: string; count: number; titles: string[] }[] {
  const by = new Map<string, { type: string; count: number; titles: string[] }>();
  for (const i of items) {
    const g = by.get(i.type) ?? { type: i.type, count: 0, titles: [] };
    g.count++;
    if (g.titles.length < maxPerType) g.titles.push(i.title);
    by.set(i.type, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
