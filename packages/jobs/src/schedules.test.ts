import { describe, expect, it } from "vitest";
import { QUEUES } from "./queues";
import { SCHEDULES, installSchedules } from "./schedules";

/** pg-boss's schedule table: one row per (queue, key), a second schedule() on the same pair replaces it. */
function fakeBoss(rows: { name: string; key: string; cron: string }[] = []) {
  const table = new Map(rows.map((r) => [`${r.name}|${r.key}`, r]));
  return {
    table,
    schedule: async (name: string, cron: string, _data?: object | null, options?: { key?: string }) => void table.set(`${name}|${options?.key ?? ""}`, { name, key: options?.key ?? "", cron }),
    unschedule: async (name: string, key = "") => void table.delete(`${name}|${key}`),
    getSchedules: async (name?: string) => [...table.values()].filter((r) => !name || r.name === name),
  };
}

describe("tick schedules", () => {
  it("every kind keeps its own row, so all of them fire (not only the last one)", async () => {
    const boss = fakeBoss();
    await installSchedules(boss as never);
    const rows = await boss.getSchedules(QUEUES.tick);
    expect(rows).toHaveLength(SCHEDULES.length);
    expect(rows.find((r) => r.key === "delta")?.cron).toBe("*/15 * * * *");
    expect(rows.find((r) => r.key === "writes")?.cron).toBe("* * * * *");
  });
  it("removes the old keyless row and kinds no longer listed, leaves other queues alone", async () => {
    const boss = fakeBoss([{ name: QUEUES.tick, key: "", cron: "35 * * * *" }, { name: QUEUES.tick, key: "gone", cron: "0 1 * * *" }, { name: "other", key: "", cron: "0 2 * * *" }]);
    const res = await installSchedules(boss as never, SCHEDULES.slice(0, 2));
    expect(res.removed.sort()).toEqual(["(no key)", "gone"]);
    expect((await boss.getSchedules(QUEUES.tick)).map((r) => r.key).sort()).toEqual(SCHEDULES.slice(0, 2).map((s) => s.data.kind).sort());
    expect(await boss.getSchedules("other")).toHaveLength(1);
  });
  it("kinds are unique", () => {
    expect(new Set(SCHEDULES.map((s) => s.data.kind)).size).toBe(SCHEDULES.length);
  });
});
