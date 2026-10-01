import { describe, expect, it } from "vitest";
import { resolveNotificationChannels, notificationTypesFor } from "@keel/config";
import { DEFAULT_TASK_RULES, isTaskOverdue, pickAssignee, planTaskChanges, taskRuleMatches, taskRuleSchema, type TaskRecordState, type TaskRule } from "./tasks";
import { digestSummary, isCriticalWithoutIncoming, isLateToShip, isSyncDelayed } from "./notifications";

const now = new Date("2026-10-01T12:00:00Z");
const h = (n: number) => new Date(now.getTime() - n * 3600e3);
const inspect: TaskRule = { id: "r1", entityType: "return", statuses: ["received"], minHoursInStatus: 0, overdueAfterHours: null, isActive: true };
const onHold: TaskRule = { id: "r2", entityType: "order", statuses: ["on_hold"], minHoursInStatus: 72, overdueAfterHours: null, isActive: true };
const poLate: TaskRule = { id: "r3", entityType: "purchase_order", statuses: ["sent", "confirmed", "in_transit"], minHoursInStatus: 0, overdueAfterHours: 24, isActive: true };
const rec = (p: Partial<TaskRecordState>): TaskRecordState => ({ entityType: "return", entityId: "x", status: "received", statusSince: h(1), dueAt: null, episode: "received:1", ...p });

describe("task rules", () => {
  it("return received opens an inspection task, inspected closes it", () => {
    expect(planTaskChanges([inspect], rec({}), [], now)).toEqual({ create: ["r1"], close: [] });
    const open = [{ id: "t1", ruleId: "r1", status: "open", episode: "received:1" }];
    expect(planTaskChanges([inspect], rec({}), open, now)).toEqual({ create: [], close: [] });
    expect(planTaskChanges([inspect], rec({ status: "inspected", episode: "inspected:2" }), open, now)).toEqual({ create: [], close: ["t1"] });
  });
  it("does not reopen a task closed by hand while the record stays in the same episode", () => {
    const done = [{ id: "t1", ruleId: "r1", status: "done", episode: "received:1" }];
    expect(planTaskChanges([inspect], rec({}), done, now).create).toEqual([]);
    expect(planTaskChanges([inspect], rec({ episode: "received:9" }), done, now).create).toEqual(["r1"]);
  });
  it("waits for the time in status and for the due date", () => {
    expect(taskRuleMatches(onHold, rec({ entityType: "order", status: "on_hold", statusSince: h(71) }), now)).toBe(false);
    expect(taskRuleMatches(onHold, rec({ entityType: "order", status: "on_hold", statusSince: h(73) }), now)).toBe(true);
    expect(taskRuleMatches(onHold, rec({ entityType: "order", status: "on_hold", statusSince: null }), now)).toBe(false);
    expect(taskRuleMatches(poLate, rec({ entityType: "purchase_order", status: "confirmed", dueAt: h(10) }), now)).toBe(false);
    expect(taskRuleMatches(poLate, rec({ entityType: "purchase_order", status: "confirmed", dueAt: h(30) }), now)).toBe(true);
    expect(taskRuleMatches(poLate, rec({ entityType: "purchase_order", status: "received", dueAt: h(30) }), now)).toBe(false);
    expect(taskRuleMatches({ ...poLate, isActive: false }, rec({ entityType: "purchase_order", status: "confirmed", dueAt: h(30) }), now)).toBe(false);
  });
  it("ignores rules of other record types", () => {
    expect(planTaskChanges([inspect, onHold, poLate], rec({}), [], now)).toEqual({ create: ["r1"], close: [] });
  });
  it("validates statuses and assignees, and the defaults are valid", () => {
    expect(taskRuleSchema.safeParse({ entityType: "return", statuses: ["shipped"], title: "x" }).success).toBe(false);
    expect(taskRuleSchema.safeParse({ entityType: "return", statuses: ["received"], title: "x", assigneeMode: "user" }).success).toBe(false);
    for (const d of DEFAULT_TASK_RULES) expect(taskRuleSchema.safeParse({ ...d.rule, title: d.title.en }).success).toBe(true);
  });
  it("picks the least loaded assignee and flags overdue tasks", () => {
    expect(pickAssignee([{ userId: "a", openTasks: 3 }, { userId: "b", openTasks: 1 }, { userId: "c", openTasks: 1 }])).toBe("b");
    expect(pickAssignee([])).toBeNull();
    expect(isTaskOverdue({ status: "open", dueAt: h(1) }, now)).toBe(true);
    expect(isTaskOverdue({ status: "done", dueAt: h(1) }, now)).toBe(false);
  });
});

describe("notification checks", () => {
  it("sync delay uses freshness plus grace", () => {
    expect(isSyncDelayed({ lastSuccessAt: h(1), connectedAt: null, freshnessMinutes: 60, graceMinutes: 60, now }).delayed).toBe(false);
    expect(isSyncDelayed({ lastSuccessAt: h(3), connectedAt: null, freshnessMinutes: 60, graceMinutes: 60, now })).toEqual({ delayed: true, minutesLate: 60 });
    expect(isSyncDelayed({ lastSuccessAt: null, connectedAt: null, freshnessMinutes: 60, graceMinutes: 0, now }).delayed).toBe(false);
  });
  it("late to ship counts from payment, only for orders still to ship", () => {
    expect(isLateToShip({ status: "confirmed", placedAt: h(100), paidAt: h(10) }, 48, now)).toBe(false);
    expect(isLateToShip({ status: "fulfilling", placedAt: h(50) }, 48, now)).toBe(true);
    expect(isLateToShip({ status: "shipped", placedAt: h(500) }, 48, now)).toBe(false);
  });
  it("critical stock only when selling and nothing incoming", () => {
    expect(isCriticalWithoutIncoming({ risk: "critical", incoming: 0, unitsSold: 4 })).toBe(true);
    expect(isCriticalWithoutIncoming({ risk: "critical", incoming: 10, unitsSold: 4 })).toBe(false);
    expect(isCriticalWithoutIncoming({ risk: "critical", incoming: 0, unitsSold: 0 })).toBe(false);
  });
  it("digest groups by type", () => {
    expect(digestSummary([{ type: "mention", title: "a" }, { type: "alert", title: "b" }, { type: "mention", title: "c" }])).toEqual([{ type: "mention", count: 2, titles: ["a", "c"] }, { type: "alert", count: 1, titles: ["b"] }]);
  });
});

describe("notification channels", () => {
  it("defaults, overrides and unknown types", () => {
    expect(resolveNotificationChannels("mention")).toEqual({ in_app: true, email: true, slack: false });
    expect(resolveNotificationChannels("mention", { email: false })).toEqual({ in_app: true, email: false, slack: false });
    expect(resolveNotificationChannels("digest", { in_app: true })).toEqual({ in_app: false, email: false, slack: false });
    expect(resolveNotificationChannels("something_new")).toEqual({ in_app: true, email: false, slack: false });
  });
  it("add-on types only with the add-on", () => {
    expect(notificationTypesFor([])).not.toContain("cod_assigned");
    expect(notificationTypesFor(["addon.cod"])).toContain("cod_assigned");
  });
});
