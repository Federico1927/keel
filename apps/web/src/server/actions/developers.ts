"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { API_LIMITS, API_SCOPES, WEBHOOK_EVENT_TYPES, isModuleInPlan } from "@hullwise/config";
import { McpTokenError, WebhookError, apiAvailabilityFor, createApiToken, createWebhookEndpoint, deleteWebhookEndpoint, redeliverWebhook, revokeMcpToken, rotatePersonalAccessToken, rotateWebhookSecret, sendTestWebhook, updateWebhookEndpoint, webhookUrlPolicy, type ServiceContext } from "@hullwise/services";
import { auditActor } from "@/server/audit-actor";
import { ForbiddenError, requireAction, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";
import "@/server/webhooks";

/**
 * Settings → Developers (#81): API tokens and webhook endpoints. Owners and admins only
 * (`manage_integrations`), the API in the plan (Growth and up). Secrets are shown once and never
 * created while a super-admin impersonates the store.
 */

const uuid = z.string().uuid();
const svc = (ctx: TenantContext, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user", userId: ctx.user.id } });
const page = (slug: string) => `/t/${slug}/settings/developers`;

async function developer(slug: string): Promise<TenantContext> {
  const ctx = await requireAction(slug, "manage_integrations");
  if (!isModuleInPlan("core.api", ctx.tenant.planKey)) throw new ForbiddenError("api_unavailable");
  return ctx;
}

function mapError<T>(e: unknown): ActionResult<T> {
  if (e instanceof ForbiddenError) return fail(e.message === "api_unavailable" ? "api_unavailable" : "forbidden");
  if (e instanceof McpTokenError) return fail(e.code);
  if (e instanceof WebhookError) return fail(e.code);
  throw e;
}

/* ---------- API tokens ---------- */

const tokenSchema = z.object({ name: z.string().trim().min(1).max(60), days: z.coerce.number().int().refine((d) => (API_LIMITS.tokenDays as readonly number[]).includes(d)), scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length) });

export async function createApiTokenAction(slug: string, _prev: ActionResult<{ token: string; expiresAt: string }> | null, fd: FormData): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  try {
    const ctx = await developer(slug);
    if (ctx.impersonation) return fail("forbidden");
    if (apiAvailabilityFor({ planKey: ctx.tenant.planKey, status: ctx.tenant.status, mcpDisabledAt: ctx.tenant.mcpDisabledAt }) !== "ok") return fail("api_unavailable");
    const parsed = tokenSchema.safeParse({ name: fd.get("name"), days: fd.get("days"), scopes: fd.getAll("scopes").map(String) });
    if (!parsed.success) return fail(parsed.error.issues.some((i) => i.path[0] === "scopes") ? "no_scopes" : "invalid_input");
    const r = await ctx.run((tx) => createApiToken(svc(ctx, tx), { userId: ctx.user.id, role: ctx.role, name: parsed.data.name, scopes: parsed.data.scopes, days: parsed.data.days }));
    revalidatePath(page(slug));
    return ok({ token: r.token, expiresAt: r.expiresAt.toISOString() });
  } catch (e) {
    return mapError(e);
  }
}

export async function revokeApiTokenAction(slug: string, tokenId: string): Promise<ActionResult> {
  try {
    const ctx = await developer(slug);
    if (!uuid.safeParse(tokenId).success) return fail("invalid_input");
    await ctx.run((tx) => revokeMcpToken(svc(ctx, tx), { tokenId, actorUserId: ctx.user.id, canRevokeOthers: true }));
    revalidatePath(page(slug));
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function rotateApiTokenAction(slug: string, tokenId: string): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  try {
    const ctx = await developer(slug);
    if (ctx.impersonation) return fail("forbidden");
    if (!uuid.safeParse(tokenId).success) return fail("invalid_input");
    const r = await ctx.run((tx) => rotatePersonalAccessToken(svc(ctx, tx), { tokenId, userId: ctx.user.id }));
    revalidatePath(page(slug));
    return ok({ token: r.token, expiresAt: r.expiresAt.toISOString() });
  } catch (e) {
    return mapError(e);
  }
}

/* ---------- webhook endpoints ---------- */

const endpointSchema = z.object({ url: z.string().trim().min(1).max(2000), description: z.string().trim().max(200).optional(), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1) });

export async function createWebhookEndpointAction(slug: string, _prev: ActionResult<{ secret: string }> | null, fd: FormData): Promise<ActionResult<{ secret: string }>> {
  try {
    const ctx = await developer(slug);
    if (ctx.impersonation) return fail("forbidden");
    const parsed = endpointSchema.safeParse({ url: fd.get("url"), description: fd.get("description") || undefined, eventTypes: fd.getAll("eventTypes").map(String) });
    if (!parsed.success) return fail(parsed.error.issues.some((i) => i.path[0] === "eventTypes") ? "invalid_events" : "invalid_url");
    const r = await ctx.run((tx) => createWebhookEndpoint(svc(ctx, tx), parsed.data, { policy: webhookUrlPolicy(), audit: auditActor(ctx) }));
    revalidatePath(page(slug));
    return ok({ secret: r.secret });
  } catch (e) {
    return mapError(e);
  }
}

export async function setWebhookEndpointActiveAction(slug: string, endpointId: string, isActive: boolean): Promise<ActionResult> {
  try {
    const ctx = await developer(slug);
    if (!uuid.safeParse(endpointId).success) return fail("invalid_input");
    await ctx.run((tx) => updateWebhookEndpoint(svc(ctx, tx), endpointId, { isActive }, { policy: webhookUrlPolicy(), audit: auditActor(ctx) }));
    revalidatePath(page(slug));
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function updateWebhookEventsAction(slug: string, endpointId: string, eventTypes: string[]): Promise<ActionResult> {
  try {
    const ctx = await developer(slug);
    if (!uuid.safeParse(endpointId).success) return fail("invalid_input");
    await ctx.run((tx) => updateWebhookEndpoint(svc(ctx, tx), endpointId, { eventTypes }, { policy: webhookUrlPolicy(), audit: auditActor(ctx) }));
    revalidatePath(page(slug));
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function deleteWebhookEndpointAction(slug: string, endpointId: string): Promise<ActionResult> {
  try {
    const ctx = await developer(slug);
    if (!uuid.safeParse(endpointId).success) return fail("invalid_input");
    await ctx.run((tx) => deleteWebhookEndpoint(svc(ctx, tx), endpointId, { audit: auditActor(ctx) }));
    revalidatePath(page(slug));
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function rotateWebhookSecretAction(slug: string, endpointId: string): Promise<ActionResult<{ secret: string }>> {
  try {
    const ctx = await developer(slug);
    if (ctx.impersonation) return fail("forbidden");
    if (!uuid.safeParse(endpointId).success) return fail("invalid_input");
    const r = await ctx.run((tx) => rotateWebhookSecret(svc(ctx, tx), endpointId, { audit: auditActor(ctx) }));
    revalidatePath(page(slug));
    return ok({ secret: r.secret });
  } catch (e) {
    return mapError(e);
  }
}

export async function sendTestWebhookAction(slug: string, endpointId: string): Promise<ActionResult> {
  try {
    const ctx = await developer(slug);
    if (!uuid.safeParse(endpointId).success) return fail("invalid_input");
    await ctx.run((tx) => sendTestWebhook(svc(ctx, tx), endpointId, { audit: auditActor(ctx) }));
    revalidatePath(`${page(slug)}/deliveries`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}

export async function redeliverWebhookAction(slug: string, deliveryId: string): Promise<ActionResult> {
  try {
    const ctx = await developer(slug);
    if (!uuid.safeParse(deliveryId).success) return fail("invalid_input");
    await ctx.run((tx) => redeliverWebhook(svc(ctx, tx), deliveryId, { audit: auditActor(ctx) }));
    revalidatePath(`${page(slug)}/deliveries`);
    return ok();
  } catch (e) {
    return mapError(e);
  }
}
