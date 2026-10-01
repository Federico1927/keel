import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

/**
 * A named filter set of one list page. `query` is the list's URL query string (without the page
 * number), applied as is when the view is reopened. Private views are visible to their owner only,
 * shared views to everyone in the tenant who can open the page.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    ...tenantColumns(),
    /** List key (packages/config LIST_KEYS): orders, products, returns, customers, purchasing. */
    pageKey: text("page_key").notNull(),
    name: text("name").notNull(),
    query: text("query").notNull().default(""),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isShared: boolean("is_shared").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("saved_views_page_idx").on(t.tenantId, t.pageKey), uniqueIndex("saved_views_owner_name_uq").on(t.tenantId, t.pageKey, t.ownerUserId, t.name), tenantIsolation("saved_views")],
).enableRLS();

/**
 * CSV exports that ran in the background (more rows than a direct download allows). The file is
 * kept here until downloaded or purged; only the user who asked for it can download it.
 */
export const listExports = pgTable(
  "list_exports",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    list: text("list").notNull(),
    query: text("query").notNull().default(""),
    /** pending | running | done | failed */
    status: text("status").notNull().default("pending"),
    rowCount: integer("row_count"),
    fileName: text("file_name"),
    content: text("content"),
    error: text("error"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
  },
  (t) => [index("list_exports_user_idx").on(t.tenantId, t.userId, t.createdAt), tenantIsolation("list_exports")],
).enableRLS();
