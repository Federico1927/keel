import { sql } from "drizzle-orm";
import { pgPolicy, pgRole, timestamp, uuid } from "drizzle-orm/pg-core";

/** Roles exist before migrations run (bootstrap / docker init). */
export const keelApp = pgRole("keel_app").existing();
export const keelAdmin = pgRole("keel_admin").existing();

/** The tenant predicate used by every RLS policy. Empty/unset setting → no rows. */
export const tenantPredicate = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

export const id = () => uuid("id").primaryKey().defaultRandom();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Tenant isolation policy for the application role. */
export const tenantIsolation = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: "permissive",
    for: "all",
    to: keelApp,
    using: tenantPredicate,
    withCheck: tenantPredicate,
  });
