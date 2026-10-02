import { createHash } from "node:crypto";
import { and, desc, eq, inArray, like, or, recordAudit, schema } from "@hullwise/db";
import { accountingRetryDelayMs, addDaysToKey, accountingSettingsSchema, accountingWindow, buildDailyJournal, dayReadiness, diffRecords, localDateKey, parseAccountingSettings, type AccountingSettings, type AccountingWaitReason, type DailyJournal, type SalesSummaryDay } from "@hullwise/core";
import { ACCOUNTING_INTEGRATION, IntegrationError, MockAccountingProvider, integrationMode, type AccountingAccount, type AccountingProvider, type ConnectionTest } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import type { AnalyticsTenant } from "../analytics";
import { integrationRow } from "../integrations/factory";
import { recordHealth } from "../sync";
import { dailySalesSummaryFor } from "./summary";

/**
 * `addon.accounting` (issue #85): the push of one journal per closed local day to the tenant's
 * accounting system. Every function refuses to run without the add-on; the daily sales summary
 * itself (./summary.ts) belongs to the core.
 */
export const ACCOUNTING_ADDON = "addon.accounting";
/** Health source of the pushes: outbound writes, so silence never makes it stale. */
export const ACCOUNTING_HEALTH_SOURCE = "accounting:writes";

export type AccountingErrorCode = "disabled" | "not_connected" | "not_pushed" | "not_ready" | "not_found" | "unknown_account" | "invalid_input" | "provider";
export class AccountingError extends Error {
  constructor(
    readonly code: AccountingErrorCode,
    message: string,
    readonly details: { reasons?: AccountingWaitReason[]; accounts?: string[] } = {},
  ) {
    super(message);
    this.name = "AccountingError";
  }
}

export async function accountingEnabled(ctx: ServiceContext): Promise<boolean> {
  const [row] = await ctx.tx.select({ id: schema.tenantAddons.id }).from(schema.tenantAddons).where(and(eq(schema.tenantAddons.tenantId, ctx.tenantId), eq(schema.tenantAddons.moduleKey, ACCOUNTING_ADDON), eq(schema.tenantAddons.isActive, true))).limit(1);
  return Boolean(row);
}
export async function assertAccountingEnabled(ctx: ServiceContext): Promise<void> {
  if (!(await accountingEnabled(ctx))) throw new AccountingError("disabled", "addon.accounting is not active for this tenant");
}

/* ---------- settings and chart of accounts ---------- */

export interface AccountingState {
  settings: AccountingSettings;
  accounts: AccountingAccount[];
  accountsSyncedAt: Date | null;
  integration: typeof schema.integrations.$inferSelect | null;
}

export async function getAccountingState(ctx: ServiceContext): Promise<AccountingState> {
  await assertAccountingEnabled(ctx);
  const [row] = await ctx.tx.select().from(schema.accountingSettings).where(eq(schema.accountingSettings.tenantId, ctx.tenantId)).limit(1);
  return { settings: parseAccountingSettings(row?.config), accounts: (row?.accounts as AccountingAccount[] | undefined) ?? [], accountsSyncedAt: row?.accountsSyncedAt ?? null, integration: await integrationRow(ctx, ACCOUNTING_INTEGRATION) };
}

/** Saves the mapping and push settings; codes must exist (and be active) in the chart last read, when one was read. */
export async function saveAccountingSettings(ctx: ServiceContext, input: unknown, by?: AccountingAuditActor): Promise<AccountingSettings> {
  const state = await getAccountingState(ctx);
  const parsed = accountingSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AccountingError("invalid_input", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const next = parsed.data;
  if (state.accounts.length) {
    const active = new Set(state.accounts.filter((a) => a.active).map((a) => a.code));
    const m = next.mapping;
    const used = [m.sales, m.tax, m.shipping, m.discounts, m.refunds, m.fees, m.clearing, ...Object.values(m.byRate).flatMap((r) => [r.sales, r.tax])].filter((c): c is string => !!c);
    const unknown = [...new Set(used.filter((c) => !active.has(c)))];
    if (unknown.length) throw new AccountingError("unknown_account", `Unknown or archived accounts: ${unknown.join(", ")}`, { accounts: unknown });
  }
  await ctx.tx.insert(schema.accountingSettings).values({ tenantId: ctx.tenantId, config: next }).onConflictDoUpdate({ target: schema.accountingSettings.tenantId, set: { config: next, updatedAt: ctx.now ?? new Date() } });
  const flat = (s: AccountingSettings) => ({ ...s.mapping, byRate: JSON.stringify(s.mapping.byRate), startDay: s.startDay, lookbackDays: s.lookbackDays, closeDelayHours: s.closeDelayHours, journalStatus: s.journalStatus });
  const diff = diffRecords<Record<string, unknown>>(flat(state.settings), flat(next));
  if (Object.keys(diff).length) await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditOf(ctx, by), action: "accounting.settings_updated", entityType: "accounting_settings", diff });
  return next;
}

/* ---------- provider ---------- */

const mocks = new Map<string, MockAccountingProvider>();

/**
 * The tenant's accounting system: the simulator while the integration is connected in mock mode
 * (cached per process, so retries and voids persist between requests). Live connectors are built per
 * account on request; until one exists there is no live provider and pushes wait.
 */
export async function getAccountingProviderFor(ctx: ServiceContext): Promise<AccountingProvider | null> {
  const row = await integrationRow(ctx, ACCOUNTING_INTEGRATION);
  if (!row || row.status === "not_connected") return null;
  if (integrationMode() === "live" && row.mode === "live") return null;
  let m = mocks.get(ctx.tenantId);
  if (!m) {
    m = new MockAccountingProvider({ accountName: row.externalAccountName ?? undefined });
    mocks.set(ctx.tenantId, m);
  }
  return m;
}
export function mockAccountingFor(tenantId: string): MockAccountingProvider | undefined {
  return mocks.get(tenantId);
}
export function resetMockAccounting(): void {
  mocks.clear();
}

async function touchIntegration(ctx: ServiceContext, ok: boolean, error: string | null) {
  const now = ctx.now ?? new Date();
  await ctx.tx.update(schema.integrations).set(ok ? { lastSyncAt: now, lastSuccessAt: now, lastError: null, status: "connected", updatedAt: now } : { lastSyncAt: now, lastError: error, status: "error", updatedAt: now }).where(and(eq(schema.integrations.tenantId, ctx.tenantId), eq(schema.integrations.provider, ACCOUNTING_INTEGRATION)));
}

/** Who an audit row names: the acting user, or the system; a web action passes impersonation explicitly. */
export interface AccountingAuditActor {
  actorUserId: string | null;
  actorType: "user" | "impersonation" | "system" | "mcp" | "api";
  impersonatedBy: string | null;
}
function auditOf(ctx: ServiceContext, by?: AccountingAuditActor): AccountingAuditActor {
  if (by) return by;
  const t = ctx.actor.type;
  return { actorUserId: ctx.actor.userId, actorType: t === "user" || t === "mcp" || t === "api" ? t : "system", impersonatedBy: null };
}

const readable = (e: unknown) => (e instanceof IntegrationError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e));

/** Connects the simulated accounting system (mock mode) and reads its chart of accounts. */
export async function connectAccounting(ctx: ServiceContext, by?: AccountingAuditActor): Promise<{ accounts: number }> {
  await assertAccountingEnabled(ctx);
  const now = ctx.now ?? new Date();
  const before = await integrationRow(ctx, ACCOUNTING_INTEGRATION);
  await ctx.tx.insert(schema.integrations).values({ tenantId: ctx.tenantId, provider: ACCOUNTING_INTEGRATION, status: "connected", mode: "mock", externalAccountId: "mock-books", externalAccountName: "Simulated accounting system", config: {} }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: { status: "connected", mode: "mock", lastError: null, updatedAt: now } });
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditOf(ctx, by), action: "integration.connected", entityType: "integration", entityId: ACCOUNTING_INTEGRATION, diff: { status: { from: before?.status ?? "not_connected", to: "connected" } }, metadata: { provider: ACCOUNTING_INTEGRATION, mode: "mock" } });
  return resyncAccountingAccounts(ctx);
}

export async function testAccountingConnection(ctx: ServiceContext): Promise<ConnectionTest> {
  await assertAccountingEnabled(ctx);
  const provider = await getAccountingProviderFor(ctx);
  if (!provider) throw new AccountingError("not_connected", "The accounting system is not connected");
  try {
    const r = await provider.testConnection();
    await touchIntegration(ctx, r.ok, r.ok ? null : r.error ?? null);
    return r;
  } catch (e) {
    await touchIntegration(ctx, false, readable(e));
    return { ok: false, error: readable(e) };
  }
}

/** Re-reads the chart of accounts (the mapping page offers its codes). */
export async function resyncAccountingAccounts(ctx: ServiceContext): Promise<{ accounts: number }> {
  await assertAccountingEnabled(ctx);
  const provider = await getAccountingProviderFor(ctx);
  if (!provider) throw new AccountingError("not_connected", "The accounting system is not connected");
  const now = ctx.now ?? new Date();
  try {
    const accounts = await provider.fetchAccounts();
    await ctx.tx.insert(schema.accountingSettings).values({ tenantId: ctx.tenantId, accounts, accountsSyncedAt: now }).onConflictDoUpdate({ target: schema.accountingSettings.tenantId, set: { accounts, accountsSyncedAt: now, updatedAt: now } });
    await touchIntegration(ctx, true, null);
    return { accounts: accounts.length };
  } catch (e) {
    await touchIntegration(ctx, false, readable(e));
    throw new AccountingError("provider", readable(e));
  }
}

/* ---------- days ---------- */

type JournalRow = typeof schema.accountingJournals.$inferSelect;

/** The current (highest version) row of each day. */
async function currentRows(ctx: ServiceContext, days: readonly string[]): Promise<Map<string, JournalRow>> {
  if (!days.length) return new Map();
  const rows = await ctx.tx.select().from(schema.accountingJournals).where(and(eq(schema.accountingJournals.tenantId, ctx.tenantId), inArray(schema.accountingJournals.day, [...days]))).orderBy(schema.accountingJournals.day, desc(schema.accountingJournals.version));
  const out = new Map<string, JournalRow>();
  for (const r of rows) if (!out.has(r.day)) out.set(r.day, r);
  return out;
}

/** Orders of each day still syncing (an `orders/*` or `refunds/*` webhook pending or failed) or waiting for a write to the platform (pending, running or failed). */
async function blockedOrders(ctx: ServiceContext, orderIds: readonly string[]): Promise<{ syncing: Set<string>; writes: Set<string> }> {
  if (!orderIds.length) return { syncing: new Set(), writes: new Set() };
  const orders = await ctx.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId }).from(schema.orders).where(and(eq(schema.orders.tenantId, ctx.tenantId), inArray(schema.orders.id, [...orderIds])));
  const ext = new Map(orders.filter((o) => o.externalId).map((o) => [o.externalId!, o.id]));
  const hooks = ext.size ? await ctx.tx.selectDistinct({ externalId: schema.webhookEvents.externalId }).from(schema.webhookEvents).where(and(eq(schema.webhookEvents.tenantId, ctx.tenantId), eq(schema.webhookEvents.source, "shopify"), inArray(schema.webhookEvents.status, ["pending", "failed"]), inArray(schema.webhookEvents.externalId, [...ext.keys()]), or(like(schema.webhookEvents.topic, "orders/%"), like(schema.webhookEvents.topic, "refunds/%")))) : [];
  const writes = await ctx.tx.selectDistinct({ id: schema.platformWrites.entityId }).from(schema.platformWrites).where(and(eq(schema.platformWrites.tenantId, ctx.tenantId), eq(schema.platformWrites.entityType, "order"), inArray(schema.platformWrites.entityId, [...orderIds]), inArray(schema.platformWrites.status, ["pending", "running", "failed"])));
  return { syncing: new Set(hooks.map((h) => ext.get(h.externalId)!).filter(Boolean)), writes: new Set(writes.map((w) => w.id!).filter(Boolean)) };
}

export interface DayEvaluation {
  day: string;
  summary: SalesSummaryDay;
  journal: DailyJournal;
  ready: boolean;
  reasons: AccountingWaitReason[];
}

/** Builds and checks the journals of some days (one summary load for all of them). */
export async function evaluateAccountingDays(ctx: ServiceContext, tenant: AnalyticsTenant, settings: AccountingSettings, days: readonly { day: string; version: number }[], now: Date): Promise<DayEvaluation[]> {
  if (!days.length) return [];
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const summary = await dailySalesSummaryFor(ctx, tenant, { fromDay: sorted[0]!.day, toDay: sorted[sorted.length - 1]!.day });
  const names = new Map<string, string>([...summary.entries, ...summary.feeEntries].map((e) => [e.orderId, e.name]));
  const wanted = new Set(sorted.map((d) => d.day));
  const blocked = await blockedOrders(ctx, [...new Set(summary.days.filter((d) => wanted.has(d.day)).flatMap((d) => d.orderIds))]);
  return sorted.map(({ day, version }) => {
    const s = summary.days.find((d) => d.day === day)!;
    const { journal, missing } = buildDailyJournal(s, settings.mapping, { currency: tenant.currency, version });
    const r = dayReadiness({ day, now, timeZone: tenant.timezone, settings, journal, missing, syncingOrders: s.orderIds.filter((id) => blocked.syncing.has(id)).map((id) => names.get(id) ?? id), pendingWriteOrders: s.orderIds.filter((id) => blocked.writes.has(id)).map((id) => names.get(id) ?? id) });
    return { day, summary: s, journal, ...r };
  });
}

const hashJournal = (j: DailyJournal) => createHash("sha256").update(JSON.stringify({ day: j.day, currency: j.currency, lines: j.lines })).digest("hex").slice(0, 32);
const summarySnapshot = (s: SalesSummaryDay) => ({ totalMinor: s.totalMinor, feesMinor: s.feesMinor, netMinor: s.netMinor, taxMinor: s.taxMinor, saleOrders: s.saleOrders, refundOrders: s.refundOrders });

async function upsertRow(ctx: ServiceContext, values: typeof schema.accountingJournals.$inferInsert): Promise<JournalRow> {
  const { tenantId: _t, day: _d, version: _v, ...set } = values;
  const [row] = await ctx.tx.insert(schema.accountingJournals).values(values).onConflictDoUpdate({ target: [schema.accountingJournals.tenantId, schema.accountingJournals.day, schema.accountingJournals.version], set: { ...set, updatedAt: ctx.now ?? new Date() } }).returning();
  return row!;
}

export interface AccountingRunResult {
  connected: boolean;
  days: number;
  pushed: number;
  waiting: number;
  failed: number;
  empty: number;
  skipped: number;
}

/**
 * The push tick for one tenant, idempotent per (tenant, day): days already pushed (or empty) are
 * left alone, failed ones wait for their next attempt (unless `force`), the others are rebuilt from
 * the summary and pushed when they reconcile, else marked waiting with the reasons. The idempotency
 * key sent to the system is tenant + day + version, so a run repeated after a crash creates nothing twice.
 */
export async function runAccountingPush(ctx: ServiceContext, tenant: AnalyticsTenant, opts: { days?: string[]; force?: boolean; by?: AccountingAuditActor } = {}): Promise<AccountingRunResult> {
  const state = await getAccountingState(ctx);
  const now = ctx.now ?? new Date();
  const result: AccountingRunResult = { connected: false, days: 0, pushed: 0, waiting: 0, failed: 0, empty: 0, skipped: 0 };
  const provider = await getAccountingProviderFor(ctx);
  if (!provider) return result;
  result.connected = true;
  const days = opts.days ?? accountingWindow(now, tenant.timezone, state.settings, localDateKey(now, tenant.timezone));
  result.days = days.length;
  const current = await currentRows(ctx, days);
  const todo: { day: string; version: number; row: JournalRow | undefined }[] = [];
  for (const day of days) {
    const row = current.get(day);
    if (row && (row.status === "pushed" || row.status === "empty")) {
      result.skipped++;
      continue;
    }
    if (row?.status === "failed" && !opts.force && row.nextAttemptAt && row.nextAttemptAt > now) {
      result.skipped++;
      continue;
    }
    todo.push({ day, version: row ? (row.status === "voided" ? row.version + 1 : row.version) : 1, row: row?.status === "voided" ? undefined : row });
  }
  const evals = await evaluateAccountingDays(ctx, tenant, state.settings, todo, now);
  let lastError: string | null = null;
  for (const ev of evals) {
    const { version, row } = todo.find((x) => x.day === ev.day)!;
    const base = { tenantId: ctx.tenantId, day: ev.day, version, provider: provider.provider, currency: tenant.currency, journal: ev.journal, debitMinor: ev.journal.debitMinor, creditMinor: ev.journal.creditMinor, summary: summarySnapshot(ev.summary), requestedBy: opts.force ? ctx.actor.userId : null };
    if (!ev.ready) {
      await upsertRow(ctx, { ...base, status: "waiting", reasons: ev.reasons, payloadHash: null });
      result.waiting++;
      continue;
    }
    if (!ev.journal.lines.length) {
      await upsertRow(ctx, { ...base, status: "empty", reasons: [], payloadHash: null });
      result.empty++;
      continue;
    }
    const attempts = (row?.attempts ?? 0) + 1;
    const pushed = await pushOne(ctx, provider, state.settings, ev.journal, version);
    if (pushed.ok) {
      const pushedRow = await upsertRow(ctx, { ...base, status: "pushed", reasons: [], payloadHash: hashJournal(ev.journal), externalId: pushed.externalId, externalStatus: pushed.status, attempts, nextAttemptAt: null, lastError: null, lastErrorCode: null, pushedAt: now });
      await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditOf(ctx, opts.by), action: "accounting.journal_pushed", entityType: "accounting_journal", entityId: pushedRow.id, diff: { status: { from: row?.status ?? null, to: "pushed" } }, metadata: { day: ev.day, version, externalId: pushed.externalId, debitMinor: ev.journal.debitMinor, replayed: pushed.replayed } });
      result.pushed++;
    } else {
      lastError = pushed.error;
      await upsertRow(ctx, { ...base, status: "failed", reasons: [], payloadHash: hashJournal(ev.journal), attempts, nextAttemptAt: new Date(now.getTime() + accountingRetryDelayMs(attempts, pushed.retryAfterMs)), lastError: pushed.error, lastErrorCode: pushed.code });
      result.failed++;
    }
  }
  if (result.pushed || result.failed) await recordHealth(ctx, ACCOUNTING_HEALTH_SOURCE, result.failed === 0, { rowsWritten: result.pushed, error: lastError, freshnessMinutes: 36 * 60 });
  return result;
}

async function pushOne(ctx: ServiceContext, provider: AccountingProvider, settings: AccountingSettings, journal: DailyJournal, version: number): Promise<{ ok: true; externalId: string; status: string; replayed: boolean } | { ok: false; error: string; code: string; retryAfterMs?: number }> {
  try {
    const r = await provider.pushJournal({ date: journal.day, currency: journal.currency, narration: journal.narration, reference: journal.reference, status: settings.journalStatus, lines: journal.lines.map((l) => ({ accountCode: l.accountCode, description: l.description, debitMinor: l.debitMinor, creditMinor: l.creditMinor })) }, { idempotencyKey: `${ctx.tenantId}:${journal.day}:v${version}` });
    // read back: the journal must exist in the system before the day counts as pushed
    const back = await provider.getJournalStatus(r.externalId);
    if (back.status === "not_found") return { ok: false, error: `The accounting system did not return journal ${r.externalId}`, code: "not_found" };
    return { ok: true, externalId: r.externalId, status: back.status, replayed: r.replayed };
  } catch (e) {
    return { ok: false, error: readable(e), code: e instanceof IntegrationError ? e.code : "unknown", retryAfterMs: e instanceof IntegrationError ? e.retryAfterMs : undefined };
  }
}

/** Retry now a day that failed or waits (manual, from the push log). */
export async function retryAccountingDay(ctx: ServiceContext, tenant: AnalyticsTenant, day: string, by?: AccountingAuditActor): Promise<AccountingRunResult> {
  await assertAccountingEnabled(ctx);
  const [row] = (await currentRows(ctx, [day])).values();
  if (!row) throw new AccountingError("not_found", `No journal for ${day}`);
  if (row.status === "pushed" || row.status === "empty") throw new AccountingError("not_ready", `${day} is already ${row.status}`);
  const r = await runAccountingPush(ctx, tenant, { days: [day], force: true, by });
  if (!r.connected) throw new AccountingError("not_connected", "The accounting system is not connected");
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditOf(ctx, by), action: "accounting.journal_retried", entityType: "accounting_journal", entityId: row.id, diff: { status: { from: row.status, to: r.pushed ? "pushed" : r.failed ? "failed" : r.waiting ? "waiting" : "empty" } }, metadata: { day, version: row.version } });
  return r;
}

/**
 * Re-push a pushed day: the day must reconcile now; the pushed journal is voided in the accounting
 * system and replaced by version + 1 built from today's summary. Audited with the before/after.
 */
export async function repushAccountingDay(ctx: ServiceContext, tenant: AnalyticsTenant, day: string, opts: { note?: string | null; by?: AccountingAuditActor } = {}): Promise<{ version: number; status: string }> {
  const state = await getAccountingState(ctx);
  const provider = await getAccountingProviderFor(ctx);
  if (!provider) throw new AccountingError("not_connected", "The accounting system is not connected");
  const [row] = (await currentRows(ctx, [day])).values();
  if (!row || row.status !== "pushed" || !row.externalId) throw new AccountingError("not_pushed", `${day} has no pushed journal to replace`);
  const now = ctx.now ?? new Date();
  const version = row.version + 1;
  const [ev] = await evaluateAccountingDays(ctx, tenant, state.settings, [{ day, version }], now);
  if (!ev!.ready) throw new AccountingError("not_ready", `${day} does not reconcile now`, { reasons: ev!.reasons });
  try {
    await provider.voidJournal(row.externalId);
  } catch (e) {
    throw new AccountingError("provider", readable(e));
  }
  await ctx.tx.update(schema.accountingJournals).set({ status: "voided", externalStatus: "voided", voidedAt: now, updatedAt: now, note: opts.note ?? null }).where(eq(schema.accountingJournals.id, row.id));
  const r = await runAccountingPush(ctx, tenant, { days: [day], force: true, by: opts.by });
  const [next] = (await currentRows(ctx, [day])).values();
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...auditOf(ctx, opts.by), action: "accounting.journal_repushed", entityType: "accounting_journal", entityId: next?.id ?? row.id, diff: { version: { from: row.version, to: version }, externalId: { from: row.externalId, to: next?.externalId ?? null }, debitMinor: { from: row.debitMinor, to: next?.debitMinor ?? null }, status: { from: "pushed", to: next?.status ?? "voided" } }, metadata: { day, note: opts.note ?? null, pushed: r.pushed } });
  return { version, status: next?.status ?? "voided" };
}

/* ---------- reads ---------- */

export const ACCOUNTING_LOG_STATUSES = ["waiting", "pushed", "failed", "voided", "empty"] as const;

export interface AccountingLogRow {
  id: string;
  day: string;
  version: number;
  status: string;
  reasons: AccountingWaitReason[];
  debitMinor: number;
  totalMinor: number | null;
  netMinor: number | null;
  externalId: string | null;
  externalStatus: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  pushedAt: Date | null;
  voidedAt: Date | null;
  updatedAt: Date;
  current: boolean;
}

/** The push log, newest day first (every version, the current one flagged), and the count of current days per status. */
export async function accountingPushLog(ctx: ServiceContext, opts: { status?: string; page?: number; pageSize?: number } = {}): Promise<{ rows: AccountingLogRow[]; total: number; page: number; pageSize: number; counts: Record<string, number>; lastPushedDay: string | null }> {
  await assertAccountingEnabled(ctx);
  const pageSize = opts.pageSize ?? 40;
  const page = Math.max(1, opts.page ?? 1);
  const all = await ctx.tx.select().from(schema.accountingJournals).where(eq(schema.accountingJournals.tenantId, ctx.tenantId)).orderBy(desc(schema.accountingJournals.day), desc(schema.accountingJournals.version));
  const seen = new Set<string>();
  const rows: AccountingLogRow[] = all.map((r) => {
    const current = !seen.has(r.day);
    seen.add(r.day);
    const s = r.summary as { totalMinor?: number; netMinor?: number };
    return { id: r.id, day: r.day, version: r.version, status: r.status, reasons: r.reasons as AccountingWaitReason[], debitMinor: r.debitMinor, totalMinor: s.totalMinor ?? null, netMinor: s.netMinor ?? null, externalId: r.externalId, externalStatus: r.externalStatus, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, lastError: r.lastError, pushedAt: r.pushedAt, voidedAt: r.voidedAt, updatedAt: r.updatedAt, current };
  });
  const counts: Record<string, number> = Object.fromEntries(ACCOUNTING_LOG_STATUSES.map((s) => [s, 0]));
  for (const r of rows) if (r.current) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const filtered = opts.status ? rows.filter((r) => r.status === opts.status && (r.current || r.status === "voided")) : rows;
  const lastPushedDay = rows.find((r) => r.current && r.status === "pushed")?.day ?? null;
  return { rows: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize, counts, lastPushedDay };
}

/** One version of a day's journal with its lines (detail view). */
export async function accountingJournalDetail(ctx: ServiceContext, day: string): Promise<JournalRow[]> {
  await assertAccountingEnabled(ctx);
  return ctx.tx.select().from(schema.accountingJournals).where(and(eq(schema.accountingJournals.tenantId, ctx.tenantId), eq(schema.accountingJournals.day, day))).orderBy(desc(schema.accountingJournals.version));
}

/** Tax rates seen in the orders of the last 30 days and the configured ones: the mapping page offers one row per rate. */
export async function recentRateKeys(ctx: ServiceContext, tenant: AnalyticsTenant): Promise<string[]> {
  const today = localDateKey(ctx.now ?? new Date(), tenant.timezone);
  const s = await dailySalesSummaryFor(ctx, tenant, { fromDay: addDaysToKey(today, -30), toDay: today });
  const configured = await ctx.tx.select({ country: schema.tenantTaxRates.country, rateBps: schema.tenantTaxRates.rateBps }).from(schema.tenantTaxRates).where(eq(schema.tenantTaxRates.tenantId, ctx.tenantId));
  return [...new Set([...s.rateKeys.map((r) => r.rateKey), ...configured.map((r) => `${r.country}|${r.rateBps}`)])].sort();
}

/** Health rows of the add-on's sources (the integration card). */
export async function accountingHealth(ctx: ServiceContext) {
  await assertAccountingEnabled(ctx);
  return ctx.tx.select().from(schema.integrationHealth).where(and(eq(schema.integrationHealth.tenantId, ctx.tenantId), like(schema.integrationHealth.source, "accounting:%"))).orderBy(schema.integrationHealth.source);
}
