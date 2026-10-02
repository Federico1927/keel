import { and, asc, desc, eq, inArray, isNull, recordAudit, schema, sql } from "@hullwise/db";
import { DEFAULT_CANCELLATION_REASONS, diffRecords, normalizeCancellationReason, normalizeEmail, subscriptionMonthlyAmount, type CancellationReasonDef } from "@hullwise/core";
import { IntegrationError, type NormalizedBillingAttempt, type NormalizedSubscriptionContract, type SubscriptionProvider } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { recordHealth } from "../sync";
import { linkContractOrders } from "./link";

export type ContractRow = typeof schema.subscriptionContracts.$inferSelect;
export type SyncSource = "sync" | "webhook" | "action" | "seed";

/* ---------- cancellation reasons (tenant list) ---------- */

/** The tenant's cancellation reasons, created from the defaults the first time. */
export async function cancellationReasons(ctx: ServiceContext): Promise<(CancellationReasonDef & { id: string; position: number; isActive: boolean })[]> {
  let rows = await ctx.tx.select().from(schema.subscriptionCancellationReasons).where(eq(schema.subscriptionCancellationReasons.tenantId, ctx.tenantId)).orderBy(asc(schema.subscriptionCancellationReasons.position));
  if (!rows.length) {
    await ctx.tx.insert(schema.subscriptionCancellationReasons).values(DEFAULT_CANCELLATION_REASONS.map((r, i) => ({ tenantId: ctx.tenantId, code: r.code, label: r.label, kind: r.kind, keywords: [...r.keywords], position: i }))).onConflictDoNothing();
    rows = await ctx.tx.select().from(schema.subscriptionCancellationReasons).where(eq(schema.subscriptionCancellationReasons.tenantId, ctx.tenantId)).orderBy(asc(schema.subscriptionCancellationReasons.position));
  }
  return rows.map((r) => ({ id: r.id, code: r.code, label: r.label, kind: r.kind as CancellationReasonDef["kind"], keywords: r.keywords, position: r.position, isActive: r.isActive }));
}

/** Adds or edits one reason of the list (code is stable; label, kind, keywords, order and active flag are the tenant's). */
export async function saveCancellationReason(ctx: ServiceContext, input: { code: string; label: string; kind: "voluntary" | "involuntary"; keywords: string[]; position?: number; isActive?: boolean }): Promise<void> {
  const code = input.code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  if (!code || !input.label.trim()) throw new Error("invalid_reason");
  await cancellationReasons(ctx);
  const [before] = await ctx.tx.select().from(schema.subscriptionCancellationReasons).where(and(eq(schema.subscriptionCancellationReasons.tenantId, ctx.tenantId), eq(schema.subscriptionCancellationReasons.code, code))).limit(1);
  const values = { label: input.label.trim().slice(0, 80), kind: input.kind, keywords: input.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 30), position: input.position ?? before?.position ?? 99, isActive: input.isActive ?? true, updatedAt: ctx.now ?? new Date() };
  await ctx.tx.insert(schema.subscriptionCancellationReasons).values({ tenantId: ctx.tenantId, code, ...values }).onConflictDoUpdate({ target: [schema.subscriptionCancellationReasons.tenantId, schema.subscriptionCancellationReasons.code], set: values });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "mcp" ? "mcp" : undefined, action: before ? "subscriptions.reason_updated" : "subscriptions.reason_created", entityType: "subscription_cancellation_reason", entityId: code, diff: diffRecords({ label: before?.label ?? null, kind: before?.kind ?? null, isActive: before?.isActive ?? null }, { label: values.label, kind: values.kind, isActive: values.isActive }) as Record<string, unknown> });
}

/* ---------- import ---------- */

async function resolveCustomer(ctx: ServiceContext, c: NormalizedSubscriptionContract): Promise<string | null> {
  if (!c.customer) return null;
  if (c.customer.externalId) {
    const [byExt] = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.externalId, c.customer.externalId))).limit(1);
    if (byExt) return byExt.id;
  }
  const email = normalizeEmail(c.customer.email);
  if (email) {
    const [byEmail] = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.emailNormalized, email))).limit(1);
    if (byEmail) return byEmail.id;
  }
  return null;
}

async function orderIdByExternal(ctx: ServiceContext, externalId: string | null): Promise<string | null> {
  if (!externalId) return null;
  const [o] = await ctx.tx.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.externalId, externalId))).limit(1);
  return o?.id ?? null;
}

const STATUS_EVENT: Record<string, string> = { "active>paused": "paused", "paused>active": "resumed", "active>cancelled": "cancelled", "paused>cancelled": "cancelled", "active>failed": "cancelled", "active>expired": "cancelled", "cancelled>active": "reactivated", "failed>active": "reactivated", "expired>active": "reactivated" };

export interface ImportContractOptions {
  provider: string;
  source: SyncSource;
  reasons?: CancellationReasonDef[];
  /** A Hullwise action already wrote the staff event: the import must not add a provider event for the same change. */
  skipEvents?: boolean;
}

/**
 * Upserts one contract as the provider holds it: customer matched by platform id then e-mail,
 * MRR from the price and interval, lines matched to the catalog, cancellation reason normalized
 * onto the tenant's list (raw text kept), origin order linked. Status, price, frequency and
 * variant changes seen for the first time become provider events with the field diff.
 */
export async function importSubscriptionContract(ctx: ServiceContext, c: NormalizedSubscriptionContract, opts: ImportContractOptions): Promise<{ id: string; outcome: "created" | "updated" | "unchanged" }> {
  const now = ctx.now ?? new Date();
  const [existing] = await ctx.tx.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.provider, opts.provider), eq(schema.subscriptionContracts.externalId, c.externalId))).limit(1);
  if (existing?.platformUpdatedAt && existing.platformUpdatedAt.getTime() > c.updatedAt.getTime()) return { id: existing.id, outcome: "unchanged" };
  const reasons = opts.reasons ?? (await cancellationReasons(ctx));
  const ended = c.status === "cancelled" || c.status === "expired" || c.status === "failed";
  const involuntary = ended && (c.cancelledForNonPayment || c.status === "failed");
  const values = {
    customerId: (await resolveCustomer(ctx, c)) ?? existing?.customerId ?? null,
    status: c.status,
    currency: c.currency,
    priceMinor: c.priceMinor,
    mrrMinor: subscriptionMonthlyAmount(c.priceMinor, c.intervalUnit, c.intervalCount),
    intervalUnit: c.intervalUnit,
    intervalCount: c.intervalCount,
    nextBillingAt: c.nextBillingAt,
    activatedAt: existing?.activatedAt ?? c.createdAt,
    pausedAt: c.status === "paused" ? (c.pausedAt ?? existing?.pausedAt ?? now) : null,
    endedAt: ended ? (c.endedAt ?? existing?.endedAt ?? now) : null,
    cancellationKind: ended ? (involuntary ? "involuntary" : "voluntary") : null,
    cancellationReasonCode: ended ? normalizeCancellationReason(c.cancellationReasonRaw ?? existing?.cancellationReasonRaw, reasons, { involuntary }) : null,
    cancellationReasonRaw: ended ? (c.cancellationReasonRaw ?? existing?.cancellationReasonRaw ?? null) : null,
    discounts: c.discounts,
    originOrderExternalId: c.originOrderExternalId ?? existing?.originOrderExternalId ?? null,
    originOrderId: (await orderIdByExternal(ctx, c.originOrderExternalId)) ?? existing?.originOrderId ?? null,
    paymentFailingSince: ended ? null : (existing?.paymentFailingSince ?? null),
    platformUpdatedAt: c.updatedAt,
    syncedAt: now,
    updatedAt: now,
  };
  let id: string;
  let outcome: "created" | "updated" | "unchanged" = "unchanged";
  const events: (typeof schema.subscriptionEvents.$inferInsert)[] = [];
  if (!existing) {
    const [row] = await ctx.tx.insert(schema.subscriptionContracts).values({ tenantId: ctx.tenantId, provider: opts.provider, externalId: c.externalId, ...values }).returning({ id: schema.subscriptionContracts.id });
    id = row!.id;
    outcome = "created";
    events.push({ tenantId: ctx.tenantId, contractId: id, type: "created", authorType: "provider", diff: {}, metadata: { source: opts.source, mrrMinor: values.mrrMinor, priceMinor: c.priceMinor }, occurredAt: c.createdAt });
    if (c.status === "paused") events.push({ tenantId: ctx.tenantId, contractId: id, type: "paused", authorType: "provider", diff: { status: { from: "active", to: "paused" } }, metadata: { source: opts.source }, occurredAt: values.pausedAt ?? now });
    if (ended) events.push({ tenantId: ctx.tenantId, contractId: id, type: "cancelled", authorType: involuntary ? "system" : "customer", diff: { status: { from: "active", to: c.status } }, metadata: { source: opts.source, reason: values.cancellationReasonCode, raw: values.cancellationReasonRaw }, occurredAt: values.endedAt ?? now });
  } else {
    id = existing.id;
    await ctx.tx.update(schema.subscriptionContracts).set(values).where(eq(schema.subscriptionContracts.id, id));
    const diff = diffRecords<Record<string, unknown>>({ status: existing.status, mrrMinor: existing.mrrMinor, priceMinor: existing.priceMinor, intervalUnit: existing.intervalUnit, intervalCount: existing.intervalCount, nextBillingAt: existing.nextBillingAt?.toISOString() ?? null }, { status: values.status, mrrMinor: values.mrrMinor, priceMinor: values.priceMinor, intervalUnit: values.intervalUnit, intervalCount: values.intervalCount, nextBillingAt: values.nextBillingAt?.toISOString() ?? null });
    if (Object.keys(diff).length) outcome = "updated";
    if (!opts.skipEvents) {
      const statusType = existing.status !== values.status ? STATUS_EVENT[`${existing.status}>${values.status}`] : undefined;
      if (statusType) events.push({ tenantId: ctx.tenantId, contractId: id, type: statusType, authorType: statusType === "cancelled" && involuntary ? "system" : "provider", diff: { status: { from: existing.status, to: values.status } }, metadata: { source: opts.source, ...(statusType === "cancelled" ? { reason: values.cancellationReasonCode, raw: values.cancellationReasonRaw } : {}) }, occurredAt: statusType === "cancelled" ? (values.endedAt ?? now) : statusType === "paused" ? (values.pausedAt ?? now) : now });
      if (existing.intervalUnit !== values.intervalUnit || existing.intervalCount !== values.intervalCount) events.push({ tenantId: ctx.tenantId, contractId: id, type: "frequency_changed", authorType: "provider", diff: { interval: { from: `${existing.intervalCount} ${existing.intervalUnit}`, to: `${values.intervalCount} ${values.intervalUnit}` }, mrrMinor: { from: existing.mrrMinor, to: values.mrrMinor } }, metadata: { source: opts.source }, occurredAt: now });
      else if (existing.mrrMinor !== values.mrrMinor) events.push({ tenantId: ctx.tenantId, contractId: id, type: "price_changed", authorType: "provider", diff: { priceMinor: { from: existing.priceMinor, to: values.priceMinor }, mrrMinor: { from: existing.mrrMinor, to: values.mrrMinor } }, metadata: { source: opts.source }, occurredAt: now });
    }
  }
  // lines: upsert by external id, matched to the catalog; lines the provider no longer has are removed
  const variantExt = c.lines.map((l) => l.variantExternalId).filter((v): v is string => Boolean(v));
  const variants = variantExt.length ? await ctx.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, ext: schema.productVariants.externalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.externalId, variantExt))) : [];
  const prevLines = existing ? await ctx.tx.select().from(schema.subscriptionContractLines).where(eq(schema.subscriptionContractLines.contractId, id)) : [];
  for (const l of c.lines) {
    const v = variants.find((x) => x.ext === l.variantExternalId);
    const lv = { productId: v?.productId ?? null, variantId: v?.id ?? null, variantExternalId: l.variantExternalId, sku: l.sku, title: l.title || "—", variantTitle: l.variantTitle, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, updatedAt: now };
    const prev = prevLines.find((p) => p.externalId === l.externalId);
    if (prev && prev.variantExternalId !== l.variantExternalId && !opts.skipEvents) events.push({ tenantId: ctx.tenantId, contractId: id, type: "swapped", authorType: "provider", diff: { variant: { from: prev.variantTitle ?? prev.variantExternalId, to: l.variantTitle ?? l.variantExternalId } }, metadata: { source: opts.source, lineExternalId: l.externalId }, occurredAt: now });
    await ctx.tx.insert(schema.subscriptionContractLines).values({ tenantId: ctx.tenantId, contractId: id, externalId: l.externalId, ...lv }).onConflictDoUpdate({ target: [schema.subscriptionContractLines.tenantId, schema.subscriptionContractLines.contractId, schema.subscriptionContractLines.externalId], set: lv });
  }
  const keep = c.lines.map((l) => l.externalId);
  if (prevLines.some((p) => !keep.includes(p.externalId))) await ctx.tx.delete(schema.subscriptionContractLines).where(and(eq(schema.subscriptionContractLines.contractId, id), sql`${schema.subscriptionContractLines.externalId} <> all(${sql.param(keep)}::text[])`));
  if (events.length) await ctx.tx.insert(schema.subscriptionEvents).values(events);
  if (values.originOrderId) await linkContractOrders(ctx, id);
  return { id, outcome };
}

/** Upserts one billing attempt; a new failure opens (or continues) the failed-payment episode, a later success closes it. */
export async function importBillingAttempt(ctx: ServiceContext, a: NormalizedBillingAttempt, opts: { provider: string; source: SyncSource }): Promise<"created" | "updated" | "unchanged" | "skipped"> {
  const [contract] = await ctx.tx.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.provider, opts.provider), eq(schema.subscriptionContracts.externalId, a.contractExternalId))).limit(1);
  if (!contract) return "skipped";
  const orderId = await orderIdByExternal(ctx, a.orderExternalId);
  const [prev] = await ctx.tx.select().from(schema.subscriptionBillingAttempts).where(and(eq(schema.subscriptionBillingAttempts.tenantId, ctx.tenantId), eq(schema.subscriptionBillingAttempts.externalId, a.externalId))).limit(1);
  const values = { contractId: contract.id, status: a.status, errorCode: a.errorCode, errorMessage: a.errorMessage, amountMinor: a.amountMinor, currency: a.currency, orderId: orderId ?? prev?.orderId ?? null, orderExternalId: a.orderExternalId, attemptedAt: a.attemptedAt, nextRetryAt: a.nextRetryAt, cycleKey: a.cycleKey };
  if (prev && prev.status === values.status && prev.orderId === values.orderId && (prev.nextRetryAt?.getTime() ?? null) === (values.nextRetryAt?.getTime() ?? null)) return "unchanged";
  await ctx.tx.insert(schema.subscriptionBillingAttempts).values({ tenantId: ctx.tenantId, externalId: a.externalId, ...values }).onConflictDoUpdate({ target: [schema.subscriptionBillingAttempts.tenantId, schema.subscriptionBillingAttempts.externalId], set: values });
  if (!prev || prev.status !== a.status) {
    if (a.status === "failed") await ctx.tx.insert(schema.subscriptionEvents).values({ tenantId: ctx.tenantId, contractId: contract.id, type: "payment_failed", authorType: "provider", diff: {}, metadata: { source: opts.source, errorCode: a.errorCode, message: a.errorMessage, amountMinor: a.amountMinor, nextRetryAt: a.nextRetryAt?.toISOString() ?? null, cycle: a.cycleKey }, occurredAt: a.attemptedAt });
    if (a.status === "success") {
      const [failedBefore] = await ctx.tx.select({ id: schema.subscriptionBillingAttempts.id }).from(schema.subscriptionBillingAttempts).where(and(eq(schema.subscriptionBillingAttempts.contractId, contract.id), eq(schema.subscriptionBillingAttempts.cycleKey, a.cycleKey), eq(schema.subscriptionBillingAttempts.status, "failed"))).limit(1);
      if (failedBefore) await ctx.tx.insert(schema.subscriptionEvents).values({ tenantId: ctx.tenantId, contractId: contract.id, type: "payment_recovered", authorType: "provider", diff: {}, metadata: { source: opts.source, cycle: a.cycleKey, amountMinor: a.amountMinor }, occurredAt: a.attemptedAt });
    }
  }
  await refreshPaymentState(ctx, contract.id);
  if (values.orderId && a.status === "success") await linkContractOrders(ctx, contract.id);
  return prev ? "updated" : "created";
}

/** `payment_failing_since`: the first failure of the latest cycle when that cycle has no success yet and the contract is live. */
export async function refreshPaymentState(ctx: ServiceContext, contractId: string): Promise<void> {
  await ctx.tx.execute(sql`
    update subscription_contracts c set payment_failing_since = (
      select case when c.status in ('active', 'paused') and bool_or(a.status = 'failed') and not bool_or(a.status = 'success') then min(a.attempted_at) filter (where a.status = 'failed') end
      from subscription_billing_attempts a
      where a.contract_id = c.id and a.cycle_key = (select a2.cycle_key from subscription_billing_attempts a2 where a2.contract_id = c.id order by a2.attempted_at desc limit 1)
    ) where c.id = ${contractId}`);
}

/* ---------- runs ---------- */

interface SubsCursor { phase: "contracts" | "attempts"; nextCursor: string | null; updatedSince: string | null; counts: { contracts: number; attempts: number; changed: number } }

const errText = (e: unknown) => (e instanceof IntegrationError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Resumable sync of the subscription app: contracts, then billing attempts, cursor saved in
 * `sync_runs` after every page; stops at the time budget and resumes on the next run. Delta reads
 * what changed since the last successful run (5 minutes of overlap); a reconcile reads everything.
 * Health is recorded on the provider's source with a readable error.
 */
export async function runSubscriptionSync(ctx: ServiceContext, provider: SubscriptionProvider, opts: { kind?: "delta" | "reconcile"; budgetMs?: number; pageSize?: number } = {}): Promise<{ runId: string; finished: boolean; contracts: number; attempts: number; changed: number; error: string | null }> {
  const kind = opts.kind ?? "delta";
  const key = provider.provider;
  const started = Date.now();
  const now = ctx.now ?? new Date();
  const [paused] = await ctx.tx.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, key), eq(schema.syncRuns.objectType, "subscriptions"), eq(schema.syncRuns.status, "paused"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1);
  let cursor: SubsCursor;
  let runId: string;
  if (paused) {
    cursor = paused.cursor as unknown as SubsCursor;
    runId = paused.id;
    await ctx.tx.update(schema.syncRuns).set({ status: "running" }).where(eq(schema.syncRuns.id, runId));
  } else {
    const [last] = kind === "delta" ? await ctx.tx.select({ startedAt: schema.syncRuns.startedAt }).from(schema.syncRuns).where(and(eq(schema.syncRuns.tenantId, ctx.tenantId), eq(schema.syncRuns.provider, key), eq(schema.syncRuns.objectType, "subscriptions"), eq(schema.syncRuns.status, "success"))).orderBy(desc(schema.syncRuns.startedAt)).limit(1) : [];
    cursor = { phase: "contracts", nextCursor: null, updatedSince: last ? new Date(last.startedAt.getTime() - 5 * 60_000).toISOString() : null, counts: { contracts: 0, attempts: 0, changed: 0 } };
    const [row] = await ctx.tx.insert(schema.syncRuns).values({ tenantId: ctx.tenantId, provider: key, objectType: "subscriptions", kind, status: "running", cursor, startedAt: now }).returning({ id: schema.syncRuns.id });
    runId = row!.id;
  }
  const c = cursor.counts;
  const stats = () => ({ rowsScanned: c.contracts + c.attempts, rowsWritten: c.changed, durationMs: Date.now() - started, summary: { ...c } });
  const reasons = await cancellationReasons(ctx);
  const since = cursor.updatedSince ? new Date(cursor.updatedSince) : null;
  try {
    for (;;) {
      if (cursor.phase === "contracts") {
        const page = await provider.fetchContracts({ cursor: cursor.nextCursor, updatedSince: since, limit: opts.pageSize ?? 100 });
        for (const item of page.items) {
          const r = await importSubscriptionContract(ctx, item, { provider: key, source: "sync", reasons });
          c.contracts++;
          if (r.outcome !== "unchanged") c.changed++;
        }
        cursor = page.nextCursor ? { ...cursor, nextCursor: page.nextCursor } : { ...cursor, phase: "attempts", nextCursor: null };
      } else {
        const page = await provider.fetchBillingAttempts({ cursor: cursor.nextCursor, createdSince: since, limit: opts.pageSize ?? 200 });
        for (const a of page.items) {
          const r = await importBillingAttempt(ctx, a, { provider: key, source: "sync" });
          c.attempts++;
          if (r === "created" || r === "updated") c.changed++;
        }
        if (!page.nextCursor) {
          await ctx.tx.update(schema.syncRuns).set({ status: "success", cursor, ...stats(), finishedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
          await recordHealth(ctx, key, true, { rowsWritten: c.changed, freshnessMinutes: 24 * 60 });
          return { runId, finished: true, ...c, error: null };
        }
        cursor = { ...cursor, nextCursor: page.nextCursor };
      }
      await ctx.tx.update(schema.syncRuns).set({ cursor, ...stats() }).where(eq(schema.syncRuns.id, runId));
      if (Date.now() - started > (opts.budgetMs ?? 20_000)) {
        await ctx.tx.update(schema.syncRuns).set({ status: "paused", cursor, ...stats() }).where(eq(schema.syncRuns.id, runId));
        return { runId, finished: false, ...c, error: null };
      }
    }
  } catch (e) {
    const error = errText(e);
    await ctx.tx.update(schema.syncRuns).set({ status: "error", error, cursor, ...stats(), errorCount: 1, finishedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
    await recordHealth(ctx, key, false, { error });
    return { runId, finished: false, ...c, error };
  }
}

/**
 * A verified webhook of the subscription app: the event is stored once (idempotent on source,
 * topic and event id), then the contract is read back from the provider and imported, with its
 * recent billing attempts.
 */
export async function processSubscriptionWebhook(ctx: ServiceContext, provider: SubscriptionProvider, headers: Record<string, string | undefined>, rawBody: string): Promise<{ status: "processed" | "duplicate" | "skipped"; contractId: string | null }> {
  const w = await provider.verifyWebhook(headers, rawBody);
  const [row] = await ctx.tx.insert(schema.webhookEvents).values({ tenantId: ctx.tenantId, source: provider.provider, topic: w.topic, externalId: w.externalId, sourceUpdatedAt: w.sourceUpdatedAt, payload: w.payload as Record<string, unknown>, status: "pending", receivedAt: ctx.now ?? new Date() }).onConflictDoNothing().returning({ id: schema.webhookEvents.id });
  if (!row) return { status: "duplicate", contractId: null };
  if (!w.contractExternalId) {
    await ctx.tx.update(schema.webhookEvents).set({ status: "processed", processedAt: new Date() }).where(eq(schema.webhookEvents.id, row.id));
    return { status: "skipped", contractId: null };
  }
  const contract = await provider.fetchContract(w.contractExternalId);
  let id: string | null = null;
  if (contract) {
    id = (await importSubscriptionContract(ctx, contract, { provider: provider.provider, source: "webhook" })).id;
    const attempts = await provider.fetchBillingAttempts({ createdSince: new Date((ctx.now ?? new Date()).getTime() - 40 * 864e5), limit: 200 });
    for (const a of attempts.items.filter((x) => x.contractExternalId === w.contractExternalId)) await importBillingAttempt(ctx, a, { provider: provider.provider, source: "webhook" });
  }
  await ctx.tx.update(schema.webhookEvents).set({ status: "processed", processedAt: new Date(), attempts: 1 }).where(eq(schema.webhookEvents.id, row.id));
  return { status: "processed", contractId: id };
}

/** Orders flagged as created by a subscription but whose contract is no longer known (maintenance check). */
export async function unlinkedSubscriptionOrders(ctx: ServiceContext): Promise<number> {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(schema.orders).leftJoin(schema.subscriptionContracts, eq(schema.subscriptionContracts.id, schema.orders.subscriptionContractId)).where(and(eq(schema.orders.tenantId, ctx.tenantId), sql`${schema.orders.subscriptionContractId} is not null`, isNull(schema.subscriptionContracts.id)));
  return r?.n ?? 0;
}
