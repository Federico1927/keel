import { z } from "zod";
import { hullwiseLink, majorUnits, type HullwiseTool } from "../tools";
import { accountingPushLog } from "./push";

/**
 * MCP tool of `addon.accounting` (#85), read-only. It carries `module: "addon.accounting"`: the MCP
 * server neither lists nor runs it for a tenant without the add-on.
 */
const input = z.object({ limit: z.number().int().min(1).max(60).default(14).describe("Most recent days to return") });
const getPushStatus: HullwiseTool<typeof input> = {
  name: "get_accounting_push_status",
  title: "Accounting: daily journals pushed, waiting or failed",
  description: "The push log of the daily sales journals sent to the store's accounting system: how many days are pushed, waiting (with the reason: day not closed, order still syncing or waiting for a platform write, unmapped account) or failed (with the error and the next attempt), and the most recent days. Example: { \"limit\": 7 }.",
  page: "accounting",
  module: "addon.accounting",
  scope: "read",
  effect: "read",
  input,
  async run(rt, args) {
    const log = await accountingPushLog(rt.ctx, { pageSize: 500 });
    const cur = rt.tenant.currency;
    const days = log.rows.filter((r) => r.current).slice(0, args.limit);
    return {
      data: {
        currency: cur,
        counts: log.counts,
        lastPushedDay: log.lastPushedDay,
        days: days.map((r) => ({ day: r.day, version: r.version, status: r.status, total: majorUnits(r.totalMinor, cur), net: majorUnits(r.netMinor, cur), reasons: r.reasons.map((x) => x.code), error: r.lastError, nextAttempt: r.nextAttemptAt?.toISOString() ?? null, journal: r.externalId })),
        link: hullwiseLink(rt, "/accounting"),
      },
    };
  },
};

export const ACCOUNTING_MCP_TOOLS: readonly HullwiseTool[] = [getPushStatus] as unknown as HullwiseTool[];
