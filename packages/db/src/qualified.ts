import { getTableName, sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * A column written as `"table"."column"`, for the outer reference of a correlated subquery in a select list.
 * Drizzle drops the table prefix from select-list columns when the query reads one table without joins, so
 * `sql`(select v.sku from product_variants v where v.product_id = ${products.id})`` renders `v.product_id = "id"`,
 * which Postgres resolves to the inner `v.id`: the subquery silently compares the inner table with itself.
 * WHERE, ORDER BY, GROUP BY, HAVING and update SET keep the prefix; wrapping the column here keeps it everywhere.
 */
export const qualified = (column: AnyColumn): SQL => sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
