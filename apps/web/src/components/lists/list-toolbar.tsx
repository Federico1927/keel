import { canExportList, isExportList, type ListKey } from "@keel/config";
import { listSavedViews } from "@keel/services";
import type { TenantContext } from "@/server/tenant";
import { ListToolbarClient } from "./list-toolbar-client";

/**
 * Saved views and CSV export of a list page, one line per page:
 * `<ListToolbar ctx={ctx} list="orders" basePath={base} />`. Views are the user's own plus the
 * tenant's shared ones; the export link carries the page's current filters.
 */
export async function ListToolbar({ ctx, list, basePath, exportHref }: { ctx: TenantContext; list: ListKey; basePath: string; /** Lists whose CSV lives elsewhere pass their own link. */ exportHref?: string }) {
  const views = await ctx.run((tx) => listSavedViews({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } }, list, ctx.user.id));
  const canExport = canExportList(ctx.role, list) && (isExportList(list) || Boolean(exportHref));
  return <ListToolbarClient slug={ctx.tenant.slug} list={list} basePath={basePath} views={views} canExport={canExport} exportHref={exportHref ?? `${basePath}/export`} canManageShared={ctx.role === "owner" || ctx.role === "admin"} />;
}
