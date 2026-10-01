import { canDo, canViewPage, canWritePage, type ActionKey, type PageKey, type TenantRole } from "./roles";

/** Lists with selection, saved views and CSV export. The key is also the page key of the permission matrix. */
export const LIST_KEYS = ["orders", "products", "returns", "customers", "purchasing"] as const;
export type ListKey = (typeof LIST_KEYS)[number];

export function isListKey(v: unknown): v is ListKey {
  return typeof v === "string" && (LIST_KEYS as readonly string[]).includes(v);
}

/** Lists whose CSV is built here (purchase orders get theirs with the purchasing list, analytics tables with analytics). */
export const EXPORT_LISTS = ["orders", "products", "returns", "customers"] as const satisfies readonly ListKey[];
export type ExportListKey = (typeof EXPORT_LISTS)[number];
export function isExportList(v: unknown): v is ExportListKey {
  return typeof v === "string" && (EXPORT_LISTS as readonly string[]).includes(v);
}

/** Above this many rows an export runs in the background and the user is notified when the file is ready. */
export const EXPORT_DIRECT_MAX_ROWS = 5000;
/** Hard cap of one export file. */
export const EXPORT_MAX_ROWS = 100_000;
/** At most this many platform calls of one bulk action run at the same time. */
export const BULK_CONCURRENCY = 3;
/** Most records one bulk action may touch (a page of the list is 50). */
export const BULK_MAX_ITEMS = 200;

/** Bulk actions per list and the permission each one needs: a named action, or write level on the list's page. */
export const BULK_ACTIONS = {
  orders: { status: "change_order_state", cancel: "cancel_order", assign: "assign", tag: "edit" },
  products: { status: "page", price: "page", compare_at: "page", tags: "page" },
  returns: { approve: "approve_return", reject: "approve_return", receive: "approve_return", refund: "approve_return" },
} as const satisfies Partial<Record<ListKey, Record<string, ActionKey | "page">>>;
export type BulkList = keyof typeof BULK_ACTIONS;
export type BulkActionKey<L extends BulkList = BulkList> = keyof (typeof BULK_ACTIONS)[L] & string;

export function isBulkAction(list: BulkList, action: unknown): boolean {
  return typeof action === "string" && Object.prototype.hasOwnProperty.call(BULK_ACTIONS[list], action);
}

export function canBulk(role: TenantRole, list: BulkList, action: string): boolean {
  if (!isBulkAction(list, action)) return false;
  const need = (BULK_ACTIONS[list] as Record<string, ActionKey | "page">)[action]!;
  return need === "page" ? canWritePage(role, list) : canDo(role, need) && canViewPage(role, list);
}

/** Bulk actions a role may run on a list (the selection bar shows only these). */
export function bulkActionsFor(role: TenantRole, list: BulkList): string[] {
  return Object.keys(BULK_ACTIONS[list]).filter((a) => canBulk(role, list, a));
}

/**
 * CSV export of a list: the role must see the page and either write it or hold the generic
 * `export` action (marketing exports the lists it reads). Viewers never export.
 */
export function canExportList(role: TenantRole, page: PageKey): boolean {
  return canViewPage(role, page) && (canWritePage(role, page) || canDo(role, "export"));
}
