import type { PgBoss } from "pg-boss";
import { QUEUES, type TickJob } from "./queues";

/** Nightly reconciliation at 03:00 and customer predictions and full live-segment refresh at 03:40, live segments every 10 min, pixel stitching and server-side conversions every 5 min, delta every 15 min, ads and GA4 daily at 06:00 (GA4 re-reads its last 3 days nightly), webhook retry every 10 min, platform-write retries every minute, retention daily at 04:10, backorder safety re-check and email housekeeping every 10 min, payouts daily at 05:20, integration watchdog every 10 min, customer campaigns every minute, WhatsApp (Spoki add-on) every 5 min, merchant subscriptions every 15 min, outgoing webhook catch-up every minute, accounting journals (add-on) hourly at :35 (UTC; each tenant's days close at its own local midnight). */
export const SCHEDULES: { cron: string; data: TickJob }[] = [
  { cron: "*/15 * * * *", data: { kind: "delta" } },
  { cron: "*/10 * * * *", data: { kind: "retry" } },
  { cron: "0 6 * * *", data: { kind: "ads" } },
  { cron: "0 3 * * *", data: { kind: "reconcile" } },
  { cron: "30 4 * * *", data: { kind: "billing" } },
  { cron: "5,15,25,35,45,55 * * * *", data: { kind: "cod" } },
  { cron: "20 * * * *", data: { kind: "alerts" } },
  { cron: "*/10 * * * *", data: { kind: "returns" } },
  { cron: "40 3 * * *", data: { kind: "crm" } },
  { cron: "2,12,22,32,42,52 * * * *", data: { kind: "segments" } },
  { cron: "*/5 * * * *", data: { kind: "tracking" } },
  { cron: "* * * * *", data: { kind: "writes" } },
  { cron: "10 4 * * *", data: { kind: "retention" } },
  { cron: "4,14,24,34,44,54 * * * *", data: { kind: "tasks" } },
  { cron: "25 * * * *", data: { kind: "notify" } },
  { cron: "5 7 * * *", data: { kind: "digest" } },
  { cron: "7,17,27,37,47,57 * * * *", data: { kind: "backorders" } },
  { cron: "3,13,23,33,43,53 * * * *", data: { kind: "emails" } },
  { cron: "20 5 * * *", data: { kind: "payouts" } },
  { cron: "1,11,21,31,41,51 * * * *", data: { kind: "watchdog" } },
  { cron: "* * * * *", data: { kind: "campaigns" } },
  { cron: "8,23,38,53 * * * *", data: { kind: "subscriptions" } },
  { cron: "*/5 * * * *", data: { kind: "whatsapp" } },
  { cron: "* * * * *", data: { kind: "webhooks" } },
  { cron: "35 * * * *", data: { kind: "accounting" } },
];

type ScheduleApi = Pick<PgBoss, "schedule" | "unschedule" | "getSchedules">;

/**
 * Installs every tick schedule on its own row. pg-boss keys schedules by (queue, `key`): without a
 * `key` all of them land on the same row and each call overwrites the previous one, so only the last
 * schedule ever fired. Rows of kinds no longer listed (and the old keyless row) are removed.
 */
export async function installSchedules(boss: ScheduleApi, schedules: readonly { cron: string; data: TickJob }[] = SCHEDULES): Promise<{ installed: number; removed: string[] }> {
  for (const s of schedules) await boss.schedule(QUEUES.tick, s.cron, s.data, { key: s.data.kind, singletonKey: s.data.kind });
  const wanted = new Set<string>(schedules.map((s) => s.data.kind));
  const removed: string[] = [];
  for (const row of await boss.getSchedules(QUEUES.tick)) {
    if (wanted.has(row.key)) continue;
    await boss.unschedule(QUEUES.tick, row.key);
    removed.push(row.key || "(no key)");
  }
  return { installed: schedules.length, removed };
}
