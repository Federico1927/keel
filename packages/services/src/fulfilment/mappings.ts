import { and, asc, eq, recordAudit, schema } from "@hullwise/db";
import { SHIPMENT_STATUSES, diffRecords, normalizeExternalStatus, type ShipmentStatus, type StatusMapping } from "@hullwise/core";
import type { ServiceContext } from "../context";

/**
 * Tenant-editable mapping "source external status → canonical shipment status / exception / final"
 * (`shipment_status_mappings`). The shipment resolver reads it on every fulfilment import; the
 * editor lives in Settings → Fulfilment.
 */

export type MappingRow = typeof schema.shipmentStatusMappings.$inferSelect;

export class MappingError extends Error {
  constructor(public readonly code: "invalid_input" | "duplicate" | "not_found") {
    super(code);
    this.name = "MappingError";
  }
}

export async function listStatusMappings(ctx: ServiceContext): Promise<MappingRow[]> {
  return ctx.tx.select().from(schema.shipmentStatusMappings).where(eq(schema.shipmentStatusMappings.tenantId, ctx.tenantId)).orderBy(asc(schema.shipmentStatusMappings.source), asc(schema.shipmentStatusMappings.externalStatus));
}

/** The rows in the shape the resolver uses. */
export async function loadStatusMappings(ctx: ServiceContext): Promise<StatusMapping[]> {
  const rows = await listStatusMappings(ctx);
  return rows.filter((r) => (SHIPMENT_STATUSES as readonly string[]).includes(r.canonicalStatus)).map((r) => ({ source: r.source, externalStatus: r.externalStatus, canonicalStatus: r.canonicalStatus as ShipmentStatus, isException: r.isException, isFinal: r.isFinal }));
}

export interface MappingInput {
  source: string;
  externalStatus: string;
  canonicalStatus: string;
  isException: boolean;
  isFinal: boolean;
}

function clean(input: MappingInput): MappingInput {
  const source = input.source.trim().toLowerCase();
  const externalStatus = normalizeExternalStatus(input.externalStatus);
  if (!/^[a-z0-9_.-]{1,40}$/.test(source) || !externalStatus || externalStatus.length > 80 || !(SHIPMENT_STATUSES as readonly string[]).includes(input.canonicalStatus)) throw new MappingError("invalid_input");
  return { source, externalStatus, canonicalStatus: input.canonicalStatus, isException: input.isException, isFinal: input.isFinal };
}

const audited = (r: Pick<MappingRow, "source" | "externalStatus" | "canonicalStatus" | "isException" | "isFinal"> | null): Record<string, unknown> => (r ? { source: r.source, externalStatus: r.externalStatus, canonicalStatus: r.canonicalStatus, isException: r.isException, isFinal: r.isFinal } : { source: null, externalStatus: null, canonicalStatus: null, isException: null, isFinal: null });

/** Creates (no id) or updates a mapping; one row per source and external status. Audited with the field diff. */
export async function saveStatusMapping(ctx: ServiceContext, input: MappingInput & { id?: string | null }): Promise<MappingRow> {
  const v = clean(input);
  const [clash] = await ctx.tx.select({ id: schema.shipmentStatusMappings.id }).from(schema.shipmentStatusMappings).where(and(eq(schema.shipmentStatusMappings.tenantId, ctx.tenantId), eq(schema.shipmentStatusMappings.source, v.source), eq(schema.shipmentStatusMappings.externalStatus, v.externalStatus))).limit(1);
  if (clash && clash.id !== input.id) throw new MappingError("duplicate");
  let before: MappingRow | null = null;
  let row: MappingRow;
  if (input.id) {
    before = (await ctx.tx.select().from(schema.shipmentStatusMappings).where(and(eq(schema.shipmentStatusMappings.tenantId, ctx.tenantId), eq(schema.shipmentStatusMappings.id, input.id))).limit(1))[0] ?? null;
    if (!before) throw new MappingError("not_found");
    [row] = (await ctx.tx.update(schema.shipmentStatusMappings).set(v).where(eq(schema.shipmentStatusMappings.id, input.id)).returning()) as [MappingRow];
  } else {
    [row] = (await ctx.tx.insert(schema.shipmentStatusMappings).values({ tenantId: ctx.tenantId, ...v }).returning()) as [MappingRow];
  }
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? "user" : "system", action: before ? "shipment_mapping.updated" : "shipment_mapping.created", entityType: "shipment_status_mapping", entityId: row.id, diff: diffRecords(audited(before), audited(row)) });
  return row;
}

export async function deleteStatusMapping(ctx: ServiceContext, id: string): Promise<boolean> {
  const [row] = await ctx.tx.delete(schema.shipmentStatusMappings).where(and(eq(schema.shipmentStatusMappings.tenantId, ctx.tenantId), eq(schema.shipmentStatusMappings.id, id))).returning();
  if (row) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "user" ? "user" : "system", action: "shipment_mapping.deleted", entityType: "shipment_status_mapping", entityId: id, diff: diffRecords(audited(row), audited(null)) });
  return Boolean(row);
}

/** External statuses seen on source states that no mapping covers yet (suggestions for the editor). */
export async function unmappedExternalStatuses(ctx: ServiceContext, limit = 20): Promise<{ source: string; externalStatus: string; count: number }[]> {
  const mapped = new Set((await listStatusMappings(ctx)).map((m) => `${m.source}:${normalizeExternalStatus(m.externalStatus)}`));
  const rows = await ctx.tx
    .select({ source: schema.shipmentSourceStates.source, externalStatus: schema.shipmentSourceStates.externalStatus })
    .from(schema.shipmentSourceStates)
    .where(eq(schema.shipmentSourceStates.tenantId, ctx.tenantId))
    .limit(5000);
  const counts = new Map<string, { source: string; externalStatus: string; count: number }>();
  for (const r of rows) {
    const ext = normalizeExternalStatus(r.externalStatus);
    if (!ext || mapped.has(`${r.source}:${ext}`)) continue;
    const k = `${r.source}:${ext}`;
    const c = counts.get(k) ?? { source: r.source, externalStatus: ext, count: 0 };
    c.count++;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
