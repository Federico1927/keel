import { uuid } from "drizzle-orm/pg-core";
import { id } from "./_common";
import { tenants } from "./tenants";

/** Every domain table starts with these columns. */
export const tenantColumns = () => ({
  id: id(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
});
