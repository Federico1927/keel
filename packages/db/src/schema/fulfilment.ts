import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { orders } from "./orders";
import { shipments } from "./shipments";

/**
 * Work items on shipments (issue #28): a delivery exception to resolve (`exception`) or a parcel
 * back at the sender to review (`return_to_sender`). Opened automatically from the resolved
 * shipment status, claimed by one person, closed by itself when the shipment moves on (exceptions)
 * or by a person once the follow-ups are done (returns to sender). One open case per shipment and kind.
 */
export const shipmentCases = pgTable(
  "shipment_cases",
  {
    ...tenantColumns(),
    kind: text("kind").notNull(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** open → claimed → instructed (exceptions) → closed. */
    status: text("status").notNull().default("open"),
    /** Shipment status and exception reason when the case opened. */
    shipmentStatus: text("shipment_status").notNull(),
    reason: text("reason"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    claimedBy: uuid("claimed_by").references(() => users.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** redeliver | new_address | pickup_point | return (exceptions). */
    resolution: text("resolution"),
    resolutionDetail: jsonb("resolution_detail").notNull().default(sql`'{}'::jsonb`),
    /** Delivery instruction: sent once (the guard is `instruction_sent_at is null`). */
    instructionChannel: text("instruction_channel"),
    instructionTo: text("instruction_to"),
    instructionRef: text("instruction_ref"),
    instructionSentAt: timestamp("instruction_sent_at", { withTimezone: true }),
    instructionSentBy: uuid("instruction_sent_by").references(() => users.id, { onDelete: "set null" }),
    /** Return-to-sender follow-ups: kind → { outcome: done | skipped, at, by }. */
    followUps: jsonb("follow_ups").notNull().default(sql`'{}'::jsonb`),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** moved_on (the shipment changed by itself) | resolved | dismissed. */
    closeReason: text("close_reason"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shipment_cases_open_uq").on(t.shipmentId, t.kind).where(sql`closed_at is null`),
    index("shipment_cases_tenant_queue_idx").on(t.tenantId, t.kind, t.closedAt, t.openedAt),
    index("shipment_cases_order_idx").on(t.orderId),
    tenantIsolation("shipment_cases"),
  ],
).enableRLS();
