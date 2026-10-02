"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { adminDb, eq, recordAudit, schema } from "@keel/db";
import { MCP_PAT_DAYS, MCP_SCOPES } from "@keel/config";
import { diffRecords, narrowMcpScopes } from "@keel/core";
import { McpTokenError, OAuthError, ProposalError, checkAuthorizeRequest, createAuthorizationCode, createPersonalAccessToken, decideProposal, getCommercePlatformFor, mcpAvailabilityFor, revokeMcpToken, rotatePersonalAccessToken, setMcpKillSwitch, type ServiceContext } from "@keel/services";
import { auditActor } from "@/server/audit-actor";
import { requireSuperAdmin } from "@/server/admin";
import { mcpDeps, mcpOrigin } from "@/server/mcp";
import { dispatchPlatformWrites } from "@/server/platform-writes";
import { getCurrentUser } from "@/server/session";
import { ForbiddenError, getTenantContext, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

const uuid = z.string().uuid();
const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const isAdmin = (ctx: TenantContext) => ctx.role === "owner" || ctx.role === "admin";

/* ---------- OAuth consent (#21) ---------- */

const AUTHORIZE_KEYS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const;
function authorizeParams(fd: FormData): Record<string, string | undefined> {
  return Object.fromEntries(AUTHORIZE_KEYS.map((k) => [k, (fd.get(k) as string | null) ?? undefined]));
}
function backToClient(redirectUri: string, params: Record<string, string | null>): never {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set("iss", mcpOrigin());
  redirect(u.toString());
}

/** The person approves the connection: one workspace, the scopes they kept. Issues the code and returns to the client. */
export async function approveMcpAuthorization(fd: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const deps = mcpDeps();
  const checked = await checkAuthorizeRequest(deps.admin, authorizeParams(fd));
  if (!checked.ok) {
    if (checked.redirect) backToClient(checked.redirectUri, { error: checked.error, error_description: checked.description, state: checked.state });
    redirect("/oauth/authorize?error=invalid_request");
  }
  const tenantId = uuid.safeParse(fd.get("tenantId"));
  if (!tenantId.success) redirect(`/oauth/authorize?${new URLSearchParams(Object.entries(authorizeParams(fd)).filter((e): e is [string, string] => !!e[1])).toString()}`);
  const scopes = narrowMcpScopes(checked.request.scopes, fd.getAll("scopes").map(String));
  let code: string;
  try {
    code = await createAuthorizationCode(deps, { tenantId: tenantId.data, userId: user.id, request: checked.request, scopes });
  } catch (e) {
    if (e instanceof OAuthError) backToClient(checked.request.redirectUri, { error: e.error, error_description: e.description, state: checked.request.state });
    throw e;
  }
  backToClient(checked.request.redirectUri, { code, state: checked.request.state });
}

export async function denyMcpAuthorization(fd: FormData): Promise<void> {
  const checked = await checkAuthorizeRequest(adminDb(), authorizeParams(fd));
  if (checked.ok) backToClient(checked.request.redirectUri, { error: "access_denied", error_description: "The user denied the request.", state: checked.request.state });
  if (!checked.ok && checked.redirect) backToClient(checked.redirectUri, { error: "access_denied", state: checked.state });
  redirect("/");
}

/* ---------- personal access tokens and connections ---------- */

const patSchema = z.object({ name: z.string().trim().min(1).max(60), days: z.coerce.number().int().refine((d) => (MCP_PAT_DAYS as readonly number[]).includes(d)), scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length) });

/** Any member creates their own token for this workspace; shown once. */
export async function createMcpTokenAction(slug: string, _prev: ActionResult<{ token: string; expiresAt: string }> | null, fd: FormData): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  const ctx = await getTenantContext(slug);
  if (ctx.impersonation) return fail("forbidden");
  if (mcpAvailabilityFor({ planKey: ctx.tenant.planKey, status: ctx.tenant.status, settings: ctx.settings, mcpDisabledAt: ctx.tenant.mcpDisabledAt }) !== "ok") return fail("mcp_unavailable");
  const parsed = patSchema.safeParse({ name: fd.get("name"), days: fd.get("days"), scopes: fd.getAll("scopes").map(String) });
  if (!parsed.success) return fail("invalid_input");
  try {
    const r = await ctx.run((tx) => createPersonalAccessToken(svc(ctx, tx), { userId: ctx.user.id, name: parsed.data.name, scopes: parsed.data.scopes, days: parsed.data.days }));
    revalidatePath(`/t/${slug}/profile`);
    return ok({ token: r.token, expiresAt: r.expiresAt.toISOString() });
  } catch (e) {
    if (e instanceof McpTokenError) return fail(e.code);
    throw e;
  }
}

export async function rotateMcpTokenAction(slug: string, tokenId: string): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  const ctx = await getTenantContext(slug);
  if (ctx.impersonation || !uuid.safeParse(tokenId).success) return fail("forbidden");
  try {
    const r = await ctx.run((tx) => rotatePersonalAccessToken(svc(ctx, tx), { tokenId, userId: ctx.user.id }));
    revalidatePath(`/t/${slug}/profile`);
    return ok({ token: r.token, expiresAt: r.expiresAt.toISOString() });
  } catch (e) {
    if (e instanceof McpTokenError) return fail(e.code);
    throw e;
  }
}

/** People revoke their own connections; owners and admins any connection of the workspace. */
export async function revokeMcpTokenAction(slug: string, tokenId: string): Promise<ActionResult> {
  const ctx = await getTenantContext(slug);
  if (!uuid.safeParse(tokenId).success) return fail("invalid_input");
  try {
    await ctx.run((tx) => revokeMcpToken(svc(ctx, tx), { tokenId, actorUserId: ctx.user.id, canRevokeOthers: isAdmin(ctx) }));
    revalidatePath(`/t/${slug}/profile`);
    revalidatePath(`/t/${slug}/settings/ai`);
    return ok();
  } catch (e) {
    if (e instanceof McpTokenError) return fail(e.code);
    throw e;
  }
}

/* ---------- tenant switches ---------- */

const switchesSchema = z.object({ mcpEnabled: z.boolean(), mcpFullPii: z.boolean() });

export async function updateMcpSettings(slug: string, input: { mcpEnabled: boolean; mcpFullPii: boolean }): Promise<ActionResult> {
  try {
    const ctx = await requireAction(slug, "manage_settings", "settings");
    const parsed = switchesSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const next = { ...ctx.settings, ...parsed.data };
    // tenants is a platform table: written through the admin connection, audited in the tenant.
    await adminDb().update(schema.tenants).set({ settings: next }).where(eq(schema.tenants.id, ctx.tenant.id));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "tenant.settings.mcp_updated", entityType: "tenant", entityId: ctx.tenant.id, diff: diffRecords({ mcpEnabled: ctx.settings.mcpEnabled, mcpFullPii: ctx.settings.mcpFullPii }, parsed.data) }));
    revalidatePath(`/t/${slug}/settings/ai`);
    return ok();
  } catch (e) {
    if (e instanceof ForbiddenError) return fail("forbidden");
    throw e;
  }
}

/* ---------- approvals ---------- */

export async function decideProposalAction(slug: string, proposalId: string, decision: "approve" | "reject", note?: string): Promise<ActionResult<{ status: string; error?: string }>> {
  const ctx = await getTenantContext(slug);
  if (!uuid.safeParse(proposalId).success || (decision !== "approve" && decision !== "reject")) return fail("invalid_input");
  try {
    const r = await ctx.run((tx) => {
      const s = svc(ctx, tx);
      return decideProposal(s, { id: proposalId, decision, note: note ?? null, role: ctx.role, commerce: () => getCommercePlatformFor(s, ctx.tenant) });
    });
    await dispatchPlatformWrites(ctx, r.writes);
    revalidatePath(`/t/${slug}/approvals`);
    return ok({ status: r.status, error: r.error });
  } catch (e) {
    if (e instanceof ProposalError) return fail(e.code);
    throw e;
  }
}

/* ---------- console ---------- */

export async function setMcpKillSwitchAction(tenantId: string, disabled: boolean, note: string): Promise<ActionResult> {
  const { user, db } = await requireSuperAdmin();
  if (!uuid.safeParse(tenantId).success) return fail("invalid_input");
  const done = await setMcpKillSwitch(db, { tenantId, disabled, note, actorUserId: user.id });
  if (!done) return fail("not_found");
  revalidatePath("/admin/mcp");
  return ok();
}
