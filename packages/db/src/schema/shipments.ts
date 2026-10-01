import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { orders } from "./orders";

/** One row per shipment; the visible `status` is resolved from `shipment_source_states`. */
export const shipments = pgTable(
  "shipments",
  {
    ...tenantColumns(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    carrier: text("carrier"),
    status: text("status").notNull().default("pending"),
    sourceOfTruth: text("source_of_truth"),
    exceptionReason: text("exception_reason"),
    exceptionSince: timestamp("exception_since", { withTimezone: true }),
    isLocked: boolean("is_locked").notNull().default(false),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    estimatedDelivery: timestamp("estimated_delivery", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shipments_tenant_external_uq").on(t.tenantId, t.externalId),
    index("shipments_order_idx").on(t.orderId),
    index("shipments_tenant_status_idx").on(t.tenantId, t.status, t.shippedAt),
    tenantIsolation("shipments"),
  ],
).enableRLS();

/** Each source (platform, carrier, aggregator, 3PL) owns one row; never writes `shipments.status`. */
export const shipmentSourceStates = pgTable(
  "shipment_source_states",
  {
    ...tenantColumns(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    status: text("status").notNull(),
    detail: text("detail"),
    externalStatus: text("external_status"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("shipment_source_states_uq").on(t.shipmentId, t.source), tenantIsolation("shipment_source_states")],
).enableRLS();

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    ...tenantColumns(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    status: text("status").notNull(),
    description: text("description"),
    location: text("location"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("shipment_events_shipment_idx").on(t.shipmentId, t.occurredAt), tenantIsolation("shipment_events")],
).enableRLS();

/** Tenant-editable mapping provider status → canonical status. */
export const shipmentStatusMappings = pgTable(
  "shipment_status_mappings",
  {
    ...tenantColumns(),
    source: text("source").notNull(),
    externalStatus: text("external_status").notNull(),
    canonicalStatus: text("canonical_status").notNull(),
    isException: boolean("is_exception").notNull().default(false),
    isFinal: boolean("is_final").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shipment_status_mappings_uq").on(t.tenantId, t.source, t.externalStatus), tenantIsolation("shipment_status_mappings")],
).enableRLS();
