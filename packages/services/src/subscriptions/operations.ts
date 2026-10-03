import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, recordAudit, schema, sql, type SQL } from "@hullwise/db";
import { NO_SUBSCRIPTION_CAPABILITIES, diffRecords, projectRenewalDates, recoveryEpisodes, renewalStockForecast, subscriptionActionAllowed, type RenewalDemand, type RenewalStockRow, type SubscriptionAction, type SubscriptionCapabilities, type SubscriptionInterval } from "@hullwise/core";
import type { NormalizedSubscriptionContract } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import { runPlatformWriteNow, type PlatformWriteKind } from "../writes";
import { loadBillingAttemptFacts, movementContractIds } from "./analytics";
import { assertSubscriptionsEnabled, getSubscriptionProviderFor, subscriptionIntegration, subscriptionsEnabled } from "./provider";
import { cancellationReasons, importSubscriptionContract, type ContractRow } from "./sync";

const LIVE = ["active", "paused"];
const PAGE_SIZE = 50;

/* ---------- subscribers list ---------- */

export interface SubscriberFilters {
  status?: string[];
  q?: string;
  risk?: string;
  failing?: boolean;
  /** Activation month `YYYY-MM` (cohort drill-down). */
  cohort?: string;
  /** MRR movement drill-down: `YYYY-MM:new|expansion|contraction|churned|reactivated`. */
  movement?: string;
  /** Ended within the period with this kind (churn drill-down). */
  endedFrom?: string;
  endedTo?: string;
  /** Activated within the period (new subscribers drill-down). */
  activatedFrom?: string;
  activatedTo?: string;
  kind?: "voluntary" | "involuntary";
  reason?: string;
  variant?: string;
  page?: number;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
export function parseSubscriberFilters(sp: Record<string, string | string[] | undefined>): SubscriberFilters {
  const status = (one(sp.status) ?? "").split(",").filter((s) => ["active", "paused", "cancelled", "expired", "failed"].includes(s));
  const date = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  return {
    status: status.length ? status : undefined,
    q: one(sp.q)?.trim().slice(0, 80) || undefined,
    risk: ["low", "medium", "high"].find((r) => r === one(sp.risk)),
    failing: one(sp.failing) === "1" || undefined,
    cohort: /^\d{4}-\d{2}$/.test(one(sp.cohort) ?? "") ? one(sp.cohort) : undefined,
    movement: /^\d{4}-\d{2}:(new|expansion|contraction|churned|reactivated)$/.test(one(sp.movement) ?? "") ? one(sp.movement) : undefined,
    endedFrom: date(one(sp.endedFrom)),
    endedTo: date(one(sp.endedTo)),
    activatedFrom: date(one(sp.activatedFrom)),
    activatedTo: date(one(sp.activatedTo)),
    kind: one(sp.kind) === "voluntary" || one(sp.kind) === "involuntary" ? (one(sp.kind) as "voluntary" | "involuntary") : undefined,
    reason: /^[a-z0-9_]{1,40}$/.test(one(sp.reason) ?? "") ? one(sp.reason) : undefined,
    variant: /^[0-9a-f-]{36}$/i.test(one(sp.variant) ?? "") ? one(sp.variant) : undefined,
    page: Math.max(1, Number(one(sp.page) ?? 1) || 1),
  };
}

export interface SubscriberRow {
  id: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  email: string | null;
  priceMinor: number;
  mrrMinor: number;
  currency: string;
  intervalUnit: string;
  intervalCount: number;
  nextBillingAt: Date | null;
  activatedAt: Date;
  endedAt: Date | null;
  renewals: number;
  churnRisk: string | null;
  paymentFailingSince: Date | null;
  products: string;
  cancellationReasonCode: string | null;
}

/** Subscribers with server-side filters (status, search, risk, failing payment, cohort, movement, churn kind, reason, variant) and pagination. */
export async function listSubscribers(ctx: ServiceContext, f: SubscriberFilters = {}, opts: { timezone?: string } = {}): Promise<{ rows: SubscriberRow[]; total: number; page: number; pageSize: number }> {
  const c = schema.subscriptionContracts;
  const conds: SQL[] = [eq(c.tenantId, ctx.tenantId)];
  if (f.status?.length) conds.push(inArray(c.status, f.status));
  if (f.risk) conds.push(eq(c.churnRisk, f.risk));
  if (f.failing) conds.push(isNotNull(c.paymentFailingSince), inArray(c.status, LIVE));
  if (f.cohort) conds.push(sql`to_char(${c.activatedAt} at time zone ${opts.timezone ?? "UTC"}, 'YYYY-MM') = ${f.cohort}`);
  if (f.endedFrom) conds.push(gte(c.endedAt, new Date(`${f.endedFrom}T00:00:00Z`)));
  if (f.endedTo) conds.push(sql`${c.endedAt} < ${new Date(`${f.endedTo}T00:00:00Z`)}`);
  if (f.activatedFrom) conds.push(gte(c.activatedAt, new Date(`${f.activatedFrom}T00:00:00Z`)));
  if (f.activatedTo) conds.push(sql`${c.activatedAt} < ${new Date(`${f.activatedTo}T00:00:00Z`)}`);
  if (f.kind) conds.push(eq(c.cancellationKind, f.kind));
  if (f.reason) conds.push(eq(c.cancellationReasonCode, f.reason));
  if (f.variant) conds.push(sql`exists (select 1 from subscription_contract_lines l where l.contract_id = ${c.id} and l.variant_id = ${f.variant})`);
  if (f.movement) {
    const [month, bucket] = f.movement.split(":") as [string, "new"];
    const ids = await movementContractIds(ctx, month, bucket);
    conds.push(ids.length ? inArray(c.id, ids) : sql`false`);
  }
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "")}%`;
    conds.push(or(ilike(schema.customers.email, like), ilike(sql`coalesce(${schema.customers.firstName}, '') || ' ' || coalesce(${schema.customers.lastName}, '')`, like), ilike(c.externalId, like))!);
  }
  const page = f.page ?? 1;
  const where = and(...conds);
  const [count] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(c).leftJoin(schema.customers, eq(schema.customers.id, c.customerId)).where(where);
  const rows = await ctx.tx
    .select({ c, first: schema.customers.firstName, last: schema.customers.lastName, email: schema.customers.email, products: sql<string>`coalesce((select string_agg(l.title || coalesce(' · ' || l.variant_title, '') || case when l.quantity > 1 then ' ×' || l.quantity else '' end, ', ') from subscription_contract_lines l where l.contract_id = ${c.id}), '')` })
    .from(c)
    .leftJoin(schema.customers, eq(schema.customers.id, c.customerId))
    .where(where)
    .orderBy(sql`${c.status} in ('active', 'paused') desc`, sql`${c.paymentFailingSince} is not null desc`, desc(c.activatedAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return {
    rows: rows.map(({ c: r, first, last, email, products }) => ({ id: r.id, status: r.status, customerId: r.customerId, customerName: [first, last].filter(Boolean).join(" ") || null, email, priceMinor: r.priceMinor, mrrMinor: r.mrrMinor, currency: r.currency, intervalUnit: r.intervalUnit, intervalCount: r.intervalCount, nextBillingAt: r.nextBillingAt, activatedAt: r.activatedAt, endedAt: r.endedAt, renewals: r.renewalsCount, churnRisk: r.churnRisk, paymentFailingSince: r.paymentFailingSince, products, cancellationReasonCode: r.cancellationReasonCode })),
    total: count?.n ?? 0,
    page,
    pageSize: PAGE_SIZE,
  };
}

/* ---------- detail ---------- */

export async function subscriptionCapabilities(ctx: ServiceContext): Promise<SubscriptionCapabilities> {
  const p = await getSubscriptionProviderFor(ctx);
  return p?.capabilities ?? NO_SUBSCRIPTION_CAPABILITIES;
}

/** One contract with its lines (and the swap options: the other variants of each product), charges, timeline, orders and the actions the app allows. */
export async function subscriptionDetail(ctx: ServiceContext, contractId: string) {
  const [row] = await ctx.tx.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.id, contractId))).limit(1);
  if (!row) return null;
  const [customer] = row.customerId ? await ctx.tx.select().from(schema.customers).where(eq(schema.customers.id, row.customerId)).limit(1) : [];
  const lines = await ctx.tx.select().from(schema.subscriptionContractLines).where(eq(schema.subscriptionContractLines.contractId, row.id)).orderBy(asc(schema.subscriptionContractLines.createdAt));
  const productIds = [...new Set(lines.map((l) => l.productId).filter((x): x is string => Boolean(x)))];
  const swapOptions = productIds.length ? await ctx.tx.select({ id: schema.productVariants.id, productId: schema.productVariants.productId, title: schema.productVariants.title, externalId: schema.productVariants.externalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), inArray(schema.productVariants.productId, productIds), eq(schema.productVariants.isActive, true), isNotNull(schema.productVariants.externalId))).orderBy(schema.productVariants.title) : [];
  const attempts = await ctx.tx.select().from(schema.subscriptionBillingAttempts).where(eq(schema.subscriptionBillingAttempts.contractId, row.id)).orderBy(desc(schema.subscriptionBillingAttempts.attemptedAt)).limit(40);
  const events = await ctx.tx.select({ e: schema.subscriptionEvents, actorName: sql<string | null>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(schema.subscriptionEvents).leftJoin(schema.users, eq(schema.users.id, schema.subscriptionEvents.actorUserId)).where(eq(schema.subscriptionEvents.contractId, row.id)).orderBy(desc(schema.subscriptionEvents.occurredAt), desc(schema.subscriptionEvents.createdAt)).limit(100);
  const orders = await ctx.tx.select({ id: schema.orders.id, name: schema.orders.name, placedAt: schema.orders.placedAt, totalMinor: schema.orders.totalMinor, status: schema.orders.status, renewalNumber: schema.orders.renewalNumber }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.subscriptionContractId, row.id))).orderBy(desc(schema.orders.placedAt)).limit(60);
  const [assignee] = row.assignedTo ? await ctx.tx.select({ name: sql<string>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(schema.users).where(eq(schema.users.id, row.assignedTo)).limit(1) : [];
  const caps = await subscriptionCapabilities(ctx);
  const integration = await subscriptionIntegration(ctx);
  // team members named in assignment diffs, so the timeline shows names instead of ids
  const named = [...new Set(events.flatMap((x) => Object.values(((x.e.diff ?? {}) as Record<string, { from?: unknown; to?: unknown }>).assignedTo ?? {})).filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)))];
  const people = named.length ? Object.fromEntries((await ctx.tx.select({ id: schema.users.id, name: sql<string>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(schema.users).where(inArray(schema.users.id, named))).map((u) => [u.id, u.name])) : {};
  return { contract: row, customer: customer ?? null, lines, swapOptions, attempts, events: events.map((x) => ({ ...x.e, actorName: x.actorName })), people: people as Record<string, string>, orders, capabilities: caps, provider: integration?.provider ?? null, assigneeName: assignee?.name ?? null, reasons: await cancellationReasons(ctx) };
}

/* ---------- customer-care actions ---------- */

export class SubscriptionActionError extends Error {
  constructor(readonly code: "not_found" | "not_allowed" | "no_provider" | "invalid_input" | "disabled", message?: string) {
    super(message ?? code);
    this.name = "SubscriptionActionError";
  }
}

export interface SubscriptionActionInput {
  contractId: string;
  action: SubscriptionAction;
  /** One per confirmation dialog: the same request sent twice reaches the provider once. */
  requestKey: string;
  resumeAt?: string | null;
  lineId?: string;
  variantId?: string;
  unit?: SubscriptionInterval;
  count?: number;
  nextBillingAt?: string;
  reason?: string;
  note?: string | null;
  /** MCP and other callers can add metadata to the timeline entry. */
  eventMetadata?: Record<string, unknown>;
}

const ACTION_KIND: Record<SubscriptionAction, PlatformWriteKind> = { pause: "subscription.pause", resume: "subscription.resume", skip: "subscription.skip", swap: "subscription.swap", frequency: "subscription.frequency", reschedule: "subscription.reschedule", cancel: "subscription.cancel", payment_link: "subscription.payment_link" };
const ACTION_EVENT: Record<SubscriptionAction, string> = { pause: "paused", resume: "resumed", skip: "skipped", swap: "swapped", frequency: "frequency_changed", reschedule: "rescheduled", cancel: "cancelled", payment_link: "payment_link_sent" };
const snapshot = (c: ContractRow, lines: { externalId: string; variantTitle: string | null; variantExternalId: string | null }[]) => ({ status: c.status, nextBillingAt: c.nextBillingAt?.toISOString().slice(0, 10) ?? null, interval: `${c.intervalCount} ${c.intervalUnit}`, priceMinor: c.priceMinor, mrrMinor: c.mrrMinor, variant: lines.map((l) => l.variantTitle ?? l.variantExternalId).join(", ") });

/**
 * A customer-care action on a contract, through the merchant's subscription app and only when the
 * app has the capability: one outbox write keyed per contract, action and confirmation request (a
 * repeated request returns the first answer and writes nothing), the contract updated from the
 * app's answer, a timeline entry by the staff member with the field diff, and an audit row.
 */
export async function subscriptionAction(ctx: ServiceContext, input: SubscriptionActionInput): Promise<{ contract: ContractRow; replayed: boolean }> {
  if (!(await subscriptionsEnabled(ctx))) throw new SubscriptionActionError("disabled");
  const [c] = await ctx.tx.select().from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.id, input.contractId))).limit(1).for("update");
  if (!c) throw new SubscriptionActionError("not_found");
  const key = `subscription:${c.id}:${input.action}:${input.requestKey.slice(0, 80)}`;
  // the same confirmation sent again: the provider was already called and the timeline written
  const [done] = await ctx.tx.select({ id: schema.subscriptionEvents.id }).from(schema.subscriptionEvents).where(and(eq(schema.subscriptionEvents.contractId, c.id), sql`${schema.subscriptionEvents.metadata}->>'requestKey' = ${key}`)).limit(1);
  if (done) return { contract: c, replayed: true };
  const provider = await getSubscriptionProviderFor(ctx);
  if (!provider) throw new SubscriptionActionError("no_provider");
  if (!subscriptionActionAllowed(input.action, c.status, provider.capabilities)) throw new SubscriptionActionError("not_allowed");
  const lines = await ctx.tx.select().from(schema.subscriptionContractLines).where(eq(schema.subscriptionContractLines.contractId, c.id));
  const before = snapshot(c, lines);
  const ext = c.externalId;
  let payload: Record<string, unknown>;
  let reasonCode: string | null = null;
  switch (input.action) {
    case "pause": payload = { contractExternalId: ext, resumeAt: input.resumeAt ?? null }; break;
    case "resume": payload = { contractExternalId: ext }; break;
    case "skip": payload = { contractExternalId: ext, nextBillingAt: c.nextBillingAt?.toISOString() ?? null }; break;
    case "swap": {
      const line = lines.find((l) => l.id === input.lineId) ?? (lines.length === 1 ? lines[0] : undefined);
      const [variant] = input.variantId ? await ctx.tx.select({ externalId: schema.productVariants.externalId }).from(schema.productVariants).where(and(eq(schema.productVariants.tenantId, ctx.tenantId), eq(schema.productVariants.id, input.variantId))).limit(1) : [];
      if (!line || !variant?.externalId) throw new SubscriptionActionError("invalid_input");
      payload = { contractExternalId: ext, lineExternalId: line.externalId, variantExternalId: variant.externalId };
      break;
    }
    case "frequency":
      if (!input.unit || !input.count || input.count < 1 || input.count > 52) throw new SubscriptionActionError("invalid_input");
      payload = { contractExternalId: ext, unit: input.unit, count: Math.round(input.count) };
      break;
    case "reschedule": {
      const d = input.nextBillingAt ? new Date(input.nextBillingAt) : null;
      if (!d || Number.isNaN(d.getTime()) || d.getTime() < (ctx.now ?? new Date()).getTime() - 864e5) throw new SubscriptionActionError("invalid_input");
      payload = { contractExternalId: ext, nextBillingAt: d.toISOString() };
      break;
    }
    case "cancel": {
      const reasons = await cancellationReasons(ctx);
      reasonCode = reasons.find((r) => r.code === input.reason)?.code ?? null;
      if (!reasonCode) throw new SubscriptionActionError("invalid_input");
      payload = { contractExternalId: ext, reason: reasons.find((r) => r.code === reasonCode)!.label, note: input.note?.slice(0, 500) ?? null };
      break;
    }
    case "payment_link": payload = { contractExternalId: ext }; break;
  }
  const result = await runPlatformWriteNow(ctx, provider, { kind: ACTION_KIND[input.action], entityType: "subscription", entityId: c.id, payload: payload as never, idempotencyKey: key });
  const now = ctx.now ?? new Date();
  if (input.action !== "payment_link") await importSubscriptionContract(ctx, result as NormalizedSubscriptionContract, { provider: c.provider, source: "action", skipEvents: true });
  const extra: Partial<typeof schema.subscriptionContracts.$inferInsert> = { updatedAt: now };
  if (input.action === "skip") extra.skipsCount = c.skipsCount + 1;
  if (input.action === "payment_link") extra.lastContactAt = now;
  if (input.action === "cancel") Object.assign(extra, { cancellationKind: "voluntary", cancellationReasonCode: reasonCode, cancellationReasonRaw: [(payload as { reason: string }).reason, input.note].filter(Boolean).join(" — ") });
  await ctx.tx.update(schema.subscriptionContracts).set(extra).where(eq(schema.subscriptionContracts.id, c.id));
  const [after] = await ctx.tx.select().from(schema.subscriptionContracts).where(eq(schema.subscriptionContracts.id, c.id)).limit(1);
  const afterLines = await ctx.tx.select().from(schema.subscriptionContractLines).where(eq(schema.subscriptionContractLines.contractId, c.id));
  const diff = diffRecords<Record<string, unknown>>(before, snapshot(after!, afterLines)) as Record<string, unknown>;
  const authorType = ctx.actor.type === "user" || ctx.actor.type === "mcp" ? "staff" : "system";
  await ctx.tx.insert(schema.subscriptionEvents).values({ tenantId: ctx.tenantId, contractId: c.id, type: ACTION_EVENT[input.action], authorType, actorUserId: ctx.actor.userId, diff, metadata: { requestKey: key, provider: c.provider, ...(reasonCode ? { reason: reasonCode, note: input.note ?? null } : {}), ...(ctx.actor.type === "mcp" ? { via: "mcp" } : {}), ...input.eventMetadata }, occurredAt: now });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, actorType: ctx.actor.type === "mcp" ? "mcp" : undefined, action: `subscription.${input.action}`, entityType: "subscription_contract", entityId: c.id, diff, metadata: { provider: c.provider, requestKey: key } });
  return { contract: after!, replayed: false };
}

/** Internal note on a contract (recovery follow-up); `contacted` also records the contact time. */
export async function addSubscriptionNote(ctx: ServiceContext, contractId: string, body: string, opts: { contacted?: boolean } = {}): Promise<void> {
  await assertSubscriptionsEnabled(ctx);
  const text = body.trim().slice(0, 2000);
  if (!text) throw new SubscriptionActionError("invalid_input");
  const [c] = await ctx.tx.select({ id: schema.subscriptionContracts.id, lastContactAt: schema.subscriptionContracts.lastContactAt }).from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.id, contractId))).limit(1);
  if (!c) throw new SubscriptionActionError("not_found");
  const now = ctx.now ?? new Date();
  await ctx.tx.insert(schema.subscriptionEvents).values({ tenantId: ctx.tenantId, contractId, type: "note", authorType: "staff", actorUserId: ctx.actor.userId, diff: opts.contacted ? { lastContactAt: { from: c.lastContactAt?.toISOString() ?? null, to: now.toISOString() } } : {}, metadata: { body: text, contacted: Boolean(opts.contacted) }, occurredAt: now });
  if (opts.contacted) await ctx.tx.update(schema.subscriptionContracts).set({ lastContactAt: now }).where(eq(schema.subscriptionContracts.id, contractId));
}

/** Assigns the recovery follow-up of a contract to a member (null = unassigned). */
export async function assignSubscription(ctx: ServiceContext, contractId: string, userId: string | null): Promise<void> {
  await assertSubscriptionsEnabled(ctx);
  const [c] = await ctx.tx.select({ id: schema.subscriptionContracts.id, assignedTo: schema.subscriptionContracts.assignedTo }).from(schema.subscriptionContracts).where(and(eq(schema.subscriptionContracts.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.id, contractId))).limit(1);
  if (!c) throw new SubscriptionActionError("not_found");
  if (userId) {
    const [m] = await ctx.tx.select({ id: schema.tenantMemberships.id }).from(schema.tenantMemberships).where(and(eq(schema.tenantMemberships.tenantId, ctx.tenantId), eq(schema.tenantMemberships.userId, userId), eq(schema.tenantMemberships.isActive, true))).limit(1);
    if (!m) throw new SubscriptionActionError("invalid_input");
  }
  if (c.assignedTo === userId) return;
  await ctx.tx.update(schema.subscriptionContracts).set({ assignedTo: userId, updatedAt: ctx.now ?? new Date() }).where(eq(schema.subscriptionContracts.id, contractId));
  await ctx.tx.insert(schema.subscriptionEvents).values({ tenantId: ctx.tenantId, contractId, type: "assigned", authorType: "staff", actorUserId: ctx.actor.userId, diff: { assignedTo: { from: c.assignedTo, to: userId } }, metadata: {}, occurredAt: ctx.now ?? new Date() });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, actorUserId: ctx.actor.userId, action: "subscription.assigned", entityType: "subscription_contract", entityId: contractId, diff: { assignedTo: { from: c.assignedTo, to: userId } } });
}

/* ---------- failed payment recovery ---------- */

export interface RecoveryRow {
  contractId: string;
  customerId: string | null;
  customerName: string | null;
  email: string | null;
  valueAtRiskMinor: number;
  mrrMinor: number;
  failingSince: Date;
  failures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextRetryAt: Date | null;
  lastContactAt: Date | null;
  assignedTo: string | null;
  assigneeName: string | null;
  churnRisk: string | null;
}

/**
 * The failed-payment recovery queue: live contracts whose latest renewal charge is failing, with
 * the value at risk (the renewal amount), the provider's retry schedule, the last contact and the
 * assignee; plus the recovery rate over the last 90 days and the value recovered in the last 30.
 */
export async function recoveryQueue(ctx: ServiceContext, opts: { assigned?: "me" | "none"; asOf?: Date } = {}) {
  const asOf = opts.asOf ?? ctx.now ?? new Date();
  const c = schema.subscriptionContracts;
  const conds: SQL[] = [eq(c.tenantId, ctx.tenantId), isNotNull(c.paymentFailingSince), inArray(c.status, LIVE)];
  if (opts.assigned === "me") conds.push(ctx.actor.userId ? eq(c.assignedTo, ctx.actor.userId) : sql`false`);
  if (opts.assigned === "none") conds.push(isNull(c.assignedTo));
  const rows = await ctx.tx.select({ c, first: schema.customers.firstName, last: schema.customers.lastName, email: schema.customers.email, assignee: sql<string | null>`coalesce(${schema.users.preferredName}, ${schema.users.name}, ${schema.users.email})` }).from(c).leftJoin(schema.customers, eq(schema.customers.id, c.customerId)).leftJoin(schema.users, eq(schema.users.id, c.assignedTo)).where(and(...conds)).orderBy(desc(c.priceMinor), asc(c.paymentFailingSince));
  const ids = rows.map((r) => r.c.id);
  const attempts = ids.length ? await ctx.tx.select().from(schema.subscriptionBillingAttempts).where(and(eq(schema.subscriptionBillingAttempts.tenantId, ctx.tenantId), inArray(schema.subscriptionBillingAttempts.contractId, ids))).orderBy(desc(schema.subscriptionBillingAttempts.attemptedAt)) : [];
  const queue: RecoveryRow[] = rows.map(({ c: r, first, last, email, assignee }) => {
    const own = attempts.filter((a) => a.contractId === r.id);
    const cycle = own[0]?.cycleKey;
    const failures = own.filter((a) => a.cycleKey === cycle && a.status === "failed");
    return { contractId: r.id, customerId: r.customerId, customerName: [first, last].filter(Boolean).join(" ") || null, email, valueAtRiskMinor: r.priceMinor, mrrMinor: r.mrrMinor, failingSince: r.paymentFailingSince!, failures: failures.length, lastErrorCode: failures[0]?.errorCode ?? null, lastErrorMessage: failures[0]?.errorMessage ?? null, nextRetryAt: own[0]?.status === "failed" ? own[0].nextRetryAt : null, lastContactAt: r.lastContactAt, assignedTo: r.assignedTo, assigneeName: assignee, churnRisk: r.churnRisk };
  });
  const facts = (await loadBillingAttemptFacts(ctx)).filter((a) => a.attemptedAt.getTime() >= asOf.getTime() - 90 * 864e5);
  const contracts = await ctx.tx.select({ id: c.id, status: c.status }).from(c).where(eq(c.tenantId, ctx.tenantId));
  const rec = recoveryEpisodes(facts, new Map(contracts.map((x) => [x.id, { live: LIVE.includes(x.status) }])));
  const recovered30 = rec.episodes.filter((e) => e.outcome === "recovered" && e.recoveredAt && e.recoveredAt.getTime() >= asOf.getTime() - 30 * 864e5);
  return { rows: queue, valueAtRiskMinor: queue.reduce((s, r) => s + r.valueAtRiskMinor, 0), recoveryRate: rec.rate, recovered: rec.recovered, lost: rec.lost, open: rec.open, recoveredValue30Minor: recovered30.reduce((s, e) => s + e.amountMinor, 0) };
}

/* ---------- renewal stock ---------- */

export interface RenewalStockView extends RenewalStockRow {
  label: string;
  sku: string | null;
  productId: string;
  supplierId: string | null;
}

/** Scheduled renewals of active contracts in the next `weeks` weeks, per variant, against stock and incoming purchase orders. */
export async function renewalStock(ctx: ServiceContext, opts: { weeks?: number; asOf?: Date; variantIds?: string[] } = {}): Promise<RenewalStockView[]> {
  const asOf = opts.asOf ?? ctx.now ?? new Date();
  const weeks = Math.min(26, Math.max(1, opts.weeks ?? 4));
  const until = new Date(asOf.getTime() + weeks * 7 * 864e5);
  const lines = await ctx.tx.select({ contractId: schema.subscriptionContracts.id, next: schema.subscriptionContracts.nextBillingAt, unit: schema.subscriptionContracts.intervalUnit, count: schema.subscriptionContracts.intervalCount, variantId: schema.subscriptionContractLines.variantId, quantity: schema.subscriptionContractLines.quantity }).from(schema.subscriptionContractLines).innerJoin(schema.subscriptionContracts, eq(schema.subscriptionContracts.id, schema.subscriptionContractLines.contractId)).where(and(eq(schema.subscriptionContractLines.tenantId, ctx.tenantId), eq(schema.subscriptionContracts.status, "active"), isNotNull(schema.subscriptionContractLines.variantId), ...(opts.variantIds ? [inArray(schema.subscriptionContractLines.variantId, opts.variantIds.length ? opts.variantIds : ["00000000-0000-0000-0000-000000000000"])] : [])));
  const renewals: RenewalDemand[] = lines.flatMap((l) => projectRenewalDates({ nextBillingAt: l.next, intervalUnit: l.unit, intervalCount: l.count }, asOf, until).map((date) => ({ variantId: l.variantId!, date, units: l.quantity, contractId: l.contractId })));
  const variantIds = [...new Set(renewals.map((r) => r.variantId))];
  if (!variantIds.length) return [];
  const variants = await ctx.tx.select({ id: schema.productVariants.id, title: schema.productVariants.title, sku: schema.productVariants.sku, productId: schema.productVariants.productId, productTitle: schema.products.title }).from(schema.productVariants).innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId)).where(inArray(schema.productVariants.id, variantIds));
  const levels = await ctx.tx.select({ variantId: schema.inventoryLevels.variantId, available: sql<number>`coalesce(sum(${schema.inventoryLevels.available}), 0)::int` }).from(schema.inventoryLevels).where(and(eq(schema.inventoryLevels.tenantId, ctx.tenantId), inArray(schema.inventoryLevels.variantId, variantIds))).groupBy(schema.inventoryLevels.variantId);
  const incoming = await ctx.tx.select({ variantId: schema.purchaseOrderLines.variantId, units: sql<number>`(${schema.purchaseOrderLines.quantity} - ${schema.purchaseOrderLines.receivedQuantity})::int`, expectedAt: schema.purchaseOrders.expectedAt }).from(schema.purchaseOrderLines).innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId)).where(and(eq(schema.purchaseOrderLines.tenantId, ctx.tenantId), inArray(schema.purchaseOrderLines.variantId, variantIds), inArray(schema.purchaseOrders.status, ["sent", "confirmed", "in_transit", "partially_received"])));
  const links = await ctx.tx.select().from(schema.supplierVariants).where(and(eq(schema.supplierVariants.tenantId, ctx.tenantId), inArray(schema.supplierVariants.variantId, variantIds)));
  const link = (id: string) => links.filter((l) => l.variantId === id).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
  const rows = renewalStockForecast({ asOf, weeks, renewals, variants: variantIds.map((id) => ({ variantId: id, available: levels.find((l) => l.variantId === id)?.available ?? 0, incoming: incoming.filter((i) => i.variantId === id && i.units > 0).map((i) => ({ units: i.units, expectedAt: i.expectedAt })), moq: link(id)?.moq ?? null, multiple: link(id)?.orderMultiple ?? null })) });
  return rows.map((r) => {
    const v = variants.find((x) => x.id === r.variantId)!;
    return { ...r, label: `${v.productTitle} · ${v.title}`, sku: v.sku, productId: v.productId, supplierId: link(r.variantId)?.supplierId ?? null };
  });
}

/** Renewal demand for reorder planning (#26/#29): empty when the add-on is off. */
export async function renewalDemandForPlanning(ctx: ServiceContext, variantIds: string[], weeks = 6): Promise<Map<string, RenewalStockRow>> {
  if (!variantIds.length || !(await subscriptionsEnabled(ctx))) return new Map();
  return new Map((await renewalStock(ctx, { weeks, variantIds })).map((r) => [r.variantId, r]));
}

/* ---------- cards on the customer and order pages ---------- */

export interface SubscriptionCardRow {
  id: string;
  status: string;
  priceMinor: number;
  mrrMinor: number;
  currency: string;
  intervalUnit: string;
  intervalCount: number;
  nextBillingAt: Date | null;
  activatedAt: Date;
  renewals: number;
  churnRisk: string | null;
  paymentFailingSince: Date | null;
  products: string;
}

async function cardRows(ctx: ServiceContext, where: SQL): Promise<SubscriptionCardRow[]> {
  const c = schema.subscriptionContracts;
  const rows = await ctx.tx.select({ c, products: sql<string>`coalesce((select string_agg(l.title || coalesce(' · ' || l.variant_title, ''), ', ') from subscription_contract_lines l where l.contract_id = ${c.id}), '')` }).from(c).where(and(eq(c.tenantId, ctx.tenantId), where)).orderBy(sql`${c.status} in ('active', 'paused') desc`, desc(c.activatedAt)).limit(10);
  return rows.map(({ c: r, products }) => ({ id: r.id, status: r.status, priceMinor: r.priceMinor, mrrMinor: r.mrrMinor, currency: r.currency, intervalUnit: r.intervalUnit, intervalCount: r.intervalCount, nextBillingAt: r.nextBillingAt, activatedAt: r.activatedAt, renewals: r.renewalsCount, churnRisk: r.churnRisk, paymentFailingSince: r.paymentFailingSince, products }));
}

export async function customerSubscriptions(ctx: ServiceContext, customerId: string): Promise<SubscriptionCardRow[]> {
  if (!(await subscriptionsEnabled(ctx))) return [];
  return cardRows(ctx, eq(schema.subscriptionContracts.customerId, customerId));
}

/** The contract behind a subscription-generated order, with the order's place in it. */
export async function orderSubscription(ctx: ServiceContext, orderId: string): Promise<(SubscriptionCardRow & { renewalNumber: number | null; isFirst: boolean }) | null> {
  if (!(await subscriptionsEnabled(ctx))) return null;
  const [o] = await ctx.tx.select({ contractId: schema.orders.subscriptionContractId, renewalNumber: schema.orders.renewalNumber, isFirst: schema.orders.isFirstSubscriptionOrder }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), eq(schema.orders.id, orderId))).limit(1);
  if (!o?.contractId) return null;
  const [row] = await cardRows(ctx, eq(schema.subscriptionContracts.id, o.contractId));
  return row ? { ...row, renewalNumber: o.renewalNumber, isFirst: o.isFirst } : null;
}
