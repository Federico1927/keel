import { and, eq, inArray, schema, sql } from "@keel/db";
import type { QueueData, WidgetLoader } from "@keel/services";

/**
 * The add-on's dashboard widget (issue #43): COD orders waiting for a confirmation call. Registered
 * next to the core loaders by the app; `loadWidgetData` refuses it for tenants without `addon.cod`.
 */
const codQueue: WidgetLoader = async (ctx) => {
  const [r] = await ctx.tx
    .select({ n: sql<number>`count(*)::int`, unassigned: sql<number>`count(*) filter (where ${schema.codQueueItems.assignedTo} is null)::int` })
    .from(schema.codQueueItems)
    .where(and(eq(schema.codQueueItems.tenantId, ctx.tenantId), inArray(schema.codQueueItems.status, ["pending", "scheduled"])));
  return { count: r?.n ?? 0, path: "cod", parts: { unassigned: r?.unassigned ?? 0 } } satisfies QueueData;
};

export const COD_WIDGET_LOADERS: Record<"cod_queue", WidgetLoader> = { cod_queue: codQueue };
