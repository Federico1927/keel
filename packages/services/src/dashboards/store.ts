import { and, eq, inArray, or, recordAudit, schema } from "@keel/db";
import { DASHBOARD_LAYOUT_VERSION, DASHBOARD_WIDGET_CAP, canSeeDashboard, isWidgetAvailable, keelTemplate, normalizeLayout, parseDashboardSettings, parseWidget, type DashboardScope, type DashboardSettings, type DashboardWidget, type TenantRole } from "@keel/config";
import type { ServiceContext } from "../context";
import type { AuditIdentity } from "../catalog/costs";

/**
 * Tenant dashboards (issue #43): the tenant home, home variants per role, extra named dashboards and
 * personal copies, all in `dashboards`. A tenant without a home row renders Keel's template, so template
 * updates reach every tenant that never customised and "reset to template" is deleting the rows.
 */

export type DashboardRow = typeof schema.dashboards.$inferSelect;

export type DashboardErrorCode = "not_found" | "invalid_layout" | "too_many_widgets" | "module_disabled" | "role_taken" | "home_exists" | "invalid_input";
export class DashboardError extends Error {
  constructor(public code: DashboardErrorCode) {
    super(code);
    this.name = "DashboardError";
  }
}

export interface DashboardView {
  /** null: Keel's template (nothing stored). */
  id: string | null;
  name: string;
  scope: DashboardScope;
  roles: string[];
  isHome: boolean;
  userId: string | null;
  widgets: DashboardWidget[];
  /** Unpublished edits, when any. */
  draft: DashboardWidget[] | null;
  settings: DashboardSettings;
  isTemplate: boolean;
  publishedAt: Date | null;
  updatedAt: Date | null;
}

export function dashboardView(row: DashboardRow): DashboardView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as DashboardScope,
    roles: row.roles,
    isHome: row.isHome,
    userId: row.userId,
    widgets: normalizeLayout(row.layoutVersion, row.widgets),
    draft: row.draftWidgets ? normalizeLayout(DASHBOARD_LAYOUT_VERSION, row.draftWidgets) : null,
    settings: parseDashboardSettings(row.settings),
    isTemplate: false,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

export function templateView(activeAddons: readonly string[]): DashboardView {
  return { id: null, name: "", scope: "tenant", roles: [], isHome: true, userId: null, widgets: keelTemplate(activeAddons), draft: null, settings: parseDashboardSettings({}), isTemplate: true, publishedAt: null, updatedAt: null };
}

const identityOf = (ctx: ServiceContext, a?: AuditIdentity): AuditIdentity => a ?? { actorUserId: ctx.actor.userId, actorType: ctx.actor.userId ? "user" : "system", impersonatedBy: null };
const summary = (ws: readonly DashboardWidget[]) => ws.map((w) => `${w.type}:${w.id}`);

async function audit(ctx: ServiceContext, action: string, id: string | null, diff: Record<string, { from: unknown; to: unknown }>, a?: AuditIdentity, metadata: Record<string, unknown> = {}) {
  await recordAudit(ctx.tx, { tenantId: ctx.tenantId, ...identityOf(ctx, a), action, entityType: "dashboard", entityId: id ?? undefined, diff, metadata });
}

/**
 * Validates a layout: every widget known and valid for its type, unique ids, at most the cap, and
 * only widgets of the tenant's modules and add-ons (a COD widget is refused without `addon.cod`).
 */
export function validateLayout(raw: unknown, activeAddons: readonly string[]): DashboardWidget[] {
  if (!Array.isArray(raw)) throw new DashboardError("invalid_layout");
  if (raw.length > DASHBOARD_WIDGET_CAP) throw new DashboardError("too_many_widgets");
  const widgets = raw.map(parseWidget);
  if (widgets.some((w) => w === null)) throw new DashboardError("invalid_layout");
  const list = widgets as DashboardWidget[];
  if (new Set(list.map((w) => w.id)).size !== list.length) throw new DashboardError("invalid_layout");
  if (list.some((w) => !isWidgetAvailable(w.type, activeAddons))) throw new DashboardError("module_disabled");
  return list;
}

export async function getDashboard(ctx: ServiceContext, id: string): Promise<DashboardRow | null> {
  const [row] = await ctx.tx.select().from(schema.dashboards).where(and(eq(schema.dashboards.tenantId, ctx.tenantId), eq(schema.dashboards.id, id))).limit(1);
  return row ?? null;
}

async function homeRows(ctx: ServiceContext): Promise<DashboardRow[]> {
  return ctx.tx.select().from(schema.dashboards).where(and(eq(schema.dashboards.tenantId, ctx.tenantId), eq(schema.dashboards.isHome, true), inArray(schema.dashboards.scope, ["tenant", "role"])));
}

/** The home a role sees: its role variant, else the tenant home, else Keel's template. */
export async function resolveHomeDashboard(ctx: ServiceContext, role: TenantRole, activeAddons: readonly string[]): Promise<DashboardView> {
  const rows = await homeRows(ctx);
  const variant = rows.find((r) => r.scope === "role" && r.roles.includes(role));
  const base = rows.find((r) => r.scope === "tenant");
  const row = variant ?? base;
  return row ? dashboardView(row) : templateView(activeAddons);
}

/** The tenant-wide home (what roles without a variant see): its row or Keel's template. */
export async function tenantHomeView(ctx: ServiceContext, activeAddons: readonly string[]): Promise<DashboardView> {
  const row = (await homeRows(ctx)).find((r) => r.scope === "tenant");
  return row ? dashboardView(row) : templateView(activeAddons);
}

/** Dashboards a user may open: tenant ones visible to their role (all for managers) and their own personal ones. */
export async function listDashboards(ctx: ServiceContext, viewer: { role: TenantRole; userId: string; personalAllowed: boolean }): Promise<DashboardView[]> {
  const rows = await ctx.tx
    .select()
    .from(schema.dashboards)
    .where(and(eq(schema.dashboards.tenantId, ctx.tenantId), or(inArray(schema.dashboards.scope, ["tenant", "role"]), and(eq(schema.dashboards.scope, "personal"), eq(schema.dashboards.userId, viewer.userId)))))
    .orderBy(schema.dashboards.scope, schema.dashboards.name);
  return rows.filter((r) => canSeeDashboard(viewer.role, viewer.userId, r, viewer.personalAllowed)).map(dashboardView);
}

export interface CreateDashboardInput {
  name: string;
  scope: DashboardScope;
  roles?: string[];
  isHome?: boolean;
  widgets?: unknown;
  settings?: unknown;
}

export async function createDashboard(ctx: ServiceContext, input: CreateDashboardInput, opts: { activeAddons: readonly string[]; audit?: AuditIdentity }): Promise<DashboardRow> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new DashboardError("invalid_input");
  const widgets = validateLayout(input.widgets ?? [], opts.activeAddons);
  const roles = [...new Set(input.roles ?? [])];
  const isHome = input.scope === "role" ? true : input.scope === "tenant" ? Boolean(input.isHome) : false;
  if (input.scope === "role" && roles.length === 0) throw new DashboardError("invalid_input");
  const homes = isHome ? await homeRows(ctx) : [];
  if (input.scope === "tenant" && isHome && homes.some((r) => r.scope === "tenant")) throw new DashboardError("home_exists");
  if (input.scope === "role" && homes.some((r) => r.scope === "role" && r.roles.some((x) => roles.includes(x)))) throw new DashboardError("role_taken");
  const now = ctx.now ?? new Date();
  const [row] = await ctx.tx
    .insert(schema.dashboards)
    .values({ tenantId: ctx.tenantId, userId: input.scope === "personal" ? ctx.actor.userId : null, scope: input.scope, roles: input.scope === "personal" ? [] : roles, isHome, layoutVersion: DASHBOARD_LAYOUT_VERSION, name, widgets, settings: parseDashboardSettings(input.settings), publishedAt: now, updatedBy: ctx.actor.userId })
    .returning();
  await audit(ctx, "dashboard.created", row!.id, { widgets: { from: null, to: summary(widgets) } }, opts.audit, { scope: input.scope, roles, isHome, name });
  return row!;
}

/** Creates the tenant home from Keel's template (or returns the existing one), ready to edit. */
export async function customiseHome(ctx: ServiceContext, opts: { activeAddons: readonly string[]; name: string; audit?: AuditIdentity }): Promise<DashboardRow> {
  const existing = (await homeRows(ctx)).find((r) => r.scope === "tenant");
  if (existing) return existing;
  return createDashboard(ctx, { name: opts.name, scope: "tenant", isHome: true, widgets: keelTemplate(opts.activeAddons) }, opts);
}

export interface SaveDashboardInput {
  widgets: unknown;
  name?: string;
  roles?: string[];
  settings?: unknown;
  /** Publish at once instead of keeping a draft. */
  publish?: boolean;
}

/** Saves a layout as the draft (or publishes it); name, roles and period apply at once. Audited with the diff. */
export async function saveDashboard(ctx: ServiceContext, id: string, input: SaveDashboardInput, opts: { activeAddons: readonly string[]; audit?: AuditIdentity }): Promise<DashboardRow> {
  const row = await getDashboard(ctx, id);
  if (!row) throw new DashboardError("not_found");
  const widgets = validateLayout(input.widgets, opts.activeAddons);
  const name = input.name === undefined ? row.name : input.name.trim().slice(0, 80);
  if (!name) throw new DashboardError("invalid_input");
  let roles = row.roles;
  if (input.roles !== undefined && row.scope !== "personal") {
    roles = [...new Set(input.roles)];
    if (row.scope === "role") {
      if (!roles.length) throw new DashboardError("invalid_input");
      const others = (await homeRows(ctx)).filter((r) => r.scope === "role" && r.id !== row.id);
      if (others.some((r) => r.roles.some((x) => roles.includes(x)))) throw new DashboardError("role_taken");
    }
  }
  const settings = input.settings === undefined ? parseDashboardSettings(row.settings) : parseDashboardSettings(input.settings);
  const now = ctx.now ?? new Date();
  const before = dashboardView(row);
  const [updated] = await ctx.tx
    .update(schema.dashboards)
    .set(input.publish ? { widgets, draftWidgets: null, layoutVersion: DASHBOARD_LAYOUT_VERSION, publishedAt: now, name, roles, settings, updatedBy: ctx.actor.userId, updatedAt: now } : { draftWidgets: widgets, name, roles, settings, updatedBy: ctx.actor.userId, updatedAt: now })
    .where(and(eq(schema.dashboards.tenantId, ctx.tenantId), eq(schema.dashboards.id, id)))
    .returning();
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const prevWidgets = summary(before.draft ?? before.widgets);
  if (JSON.stringify(prevWidgets) !== JSON.stringify(summary(widgets)) || input.publish) diff.widgets = { from: summary(before.widgets), to: summary(widgets) };
  if (name !== row.name) diff.name = { from: row.name, to: name };
  if (JSON.stringify(roles) !== JSON.stringify(row.roles)) diff.roles = { from: row.roles, to: roles };
  if (settings.period !== before.settings.period) diff.period = { from: before.settings.period, to: settings.period };
  await audit(ctx, input.publish ? "dashboard.published" : "dashboard.draft_saved", id, diff, opts.audit, { scope: row.scope });
  return updated!;
}

/** Publishes the draft (no-op without one). */
export async function publishDashboard(ctx: ServiceContext, id: string, opts: { activeAddons: readonly string[]; audit?: AuditIdentity }): Promise<DashboardRow> {
  const row = await getDashboard(ctx, id);
  if (!row) throw new DashboardError("not_found");
  if (!row.draftWidgets) return row;
  return saveDashboard(ctx, id, { widgets: row.draftWidgets, publish: true }, opts);
}

export async function discardDashboardDraft(ctx: ServiceContext, id: string, opts: { audit?: AuditIdentity } = {}): Promise<void> {
  const row = await getDashboard(ctx, id);
  if (!row) throw new DashboardError("not_found");
  if (!row.draftWidgets) return;
  await ctx.tx.update(schema.dashboards).set({ draftWidgets: null, updatedAt: ctx.now ?? new Date() }).where(eq(schema.dashboards.id, id));
  await audit(ctx, "dashboard.draft_discarded", id, {}, opts.audit);
}

export async function deleteDashboard(ctx: ServiceContext, id: string, opts: { audit?: AuditIdentity } = {}): Promise<void> {
  const [gone] = await ctx.tx.delete(schema.dashboards).where(and(eq(schema.dashboards.tenantId, ctx.tenantId), eq(schema.dashboards.id, id))).returning();
  if (!gone) throw new DashboardError("not_found");
  await audit(ctx, "dashboard.deleted", id, { widgets: { from: summary(normalizeLayout(gone.layoutVersion, gone.widgets)), to: null } }, opts.audit, { scope: gone.scope, name: gone.name });
}

/** Copies a tenant dashboard (or the template, with null) into a personal one of the acting user. */
export async function duplicateToPersonal(ctx: ServiceContext, source: DashboardView, opts: { name: string; activeAddons: readonly string[]; audit?: AuditIdentity }): Promise<DashboardRow> {
  return createDashboard(ctx, { name: opts.name, scope: "personal", widgets: source.widgets.filter((w) => isWidgetAvailable(w.type, opts.activeAddons)), settings: source.settings }, opts);
}

/**
 * Back to Keel's template: deletes the tenant home (`tenant`) or the home and every role variant
 * (`all`, the super-admin support reset). Extra and personal dashboards are kept.
 */
export async function resetHomeToTemplate(ctx: ServiceContext, scope: "tenant" | "all", opts: { audit?: AuditIdentity } = {}): Promise<number> {
  const gone = await ctx.tx
    .delete(schema.dashboards)
    .where(and(eq(schema.dashboards.tenantId, ctx.tenantId), eq(schema.dashboards.isHome, true), inArray(schema.dashboards.scope, scope === "all" ? ["tenant", "role"] : ["tenant"])))
    .returning({ id: schema.dashboards.id, scope: schema.dashboards.scope, roles: schema.dashboards.roles, name: schema.dashboards.name });
  await audit(ctx, "dashboard.reset_to_template", null, { home: { from: gone.map((g) => `${g.scope}:${g.name}`), to: "keel_template" } }, opts.audit, { scope });
  return gone.length;
}
