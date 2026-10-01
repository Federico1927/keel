"use server";
import { after } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { SUPPORTED_LOCALES } from "@keel/config";
import { parseTenantSettings } from "@keel/core";
import { adminDb, eq, recordAudit, schema, withTenant } from "@keel/db";
import { PortalError, deletePortalPhoto, getCommercePlatformFor, getPortalConfig, portalLookup, portalOrderView, portalSubmit, savePortalPhoto, syncReturnToPlatform, verifyPortalSession, type PortalOrderView, type ServiceContext } from "@keel/services";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Public actions of the customer return portal. No session: the tenant comes from the slug in
 * the URL, the order from a signed one-hour token issued by a successful lookup.
 */

async function portalTenant(slug: string) {
  const [t] = await adminDb().select({ id: schema.tenants.id, status: schema.tenants.status, orderNumberPrefix: schema.tenants.orderNumberPrefix, settings: schema.tenants.settings, currency: schema.tenants.currency, country: schema.tenants.country }).from(schema.tenants).where(eq(schema.tenants.slug, slug)).limit(1);
  return t && t.status === "active" ? t : null;
}
const sys = (tenantId: string, tx: ServiceContext["tx"]): ServiceContext => ({ tenantId, tx, actor: { type: "system", userId: null } });

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || h.get("cf-connecting-ip") || null;
}

export type PortalView = Omit<PortalOrderView, "deadline" | "returns"> & { deadline: string | null; returns: { number: number; status: string; requestedAt: string; resolution: string }[] };
const serialize = (v: PortalOrderView): PortalView => ({ ...v, deadline: v.deadline?.toISOString() ?? null, returns: v.returns.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() })) });

function portalFail<T>(e: unknown): ActionResult<T> {
  if (e instanceof PortalError) return fail(e.code, e.code === "rate_limited" ? { retryAfter: String((e.detail as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 900) } : e.code === "fields_invalid" ? { fields: (e.detail as string[]).join(",") } : undefined) as ActionResult<T>;
  throw e;
}

const lookupSchema = z.object({ orderNumber: z.string().trim().min(1).max(40), contact: z.string().trim().min(3).max(120) });

export async function portalLookupAction(slug: string, input: unknown): Promise<ActionResult<PortalView>> {
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_input");
  const tenant = await portalTenant(slug);
  if (!tenant) return fail("disabled");
  const ip = await clientIp();
  try {
    const view = await withTenant(tenant.id, async (tx) => {
      const ctx = sys(tenant.id, tx);
      return portalLookup(ctx, parseTenantSettings(tenant.settings), tenant, await getPortalConfig(ctx), { ...parsed.data, ip });
    });
    return view ? ok(serialize(view)) : fail("not_found");
  } catch (e) {
    return portalFail(e);
  }
}

/** Fresh view of the order (returnable lines and existing returns) for a valid token. */
export async function portalRefreshAction(slug: string, token: string): Promise<ActionResult<PortalView>> {
  const tenant = await portalTenant(slug);
  const session = verifyPortalSession(token);
  if (!tenant || !session || session.tenantId !== tenant.id) return fail("session_expired");
  const view = await withTenant(tenant.id, async (tx) => {
    const ctx = sys(tenant.id, tx);
    return portalOrderView(ctx, parseTenantSettings(tenant.settings), await getPortalConfig(ctx), session.orderId, token);
  });
  return ok(serialize(view));
}

export async function portalPhotoAction(slug: string, token: string, formData: FormData): Promise<ActionResult<{ id: string }>> {
  const tenant = await portalTenant(slug);
  const session = verifyPortalSession(token);
  if (!tenant || !session || session.tenantId !== tenant.id) return fail("session_expired");
  const file = formData.get("photo");
  if (!(file instanceof File)) return fail("invalid_input");
  try {
    const id = await withTenant(tenant.id, async (tx) => {
      const ctx = sys(tenant.id, tx);
      return savePortalPhoto(ctx, await getPortalConfig(ctx), session, { contentType: file.type, data: Buffer.from(await file.arrayBuffer()) });
    });
    return ok({ id });
  } catch (e) {
    return portalFail(e);
  }
}

export async function portalDeletePhotoAction(slug: string, token: string, id: string): Promise<ActionResult> {
  const tenant = await portalTenant(slug);
  const session = verifyPortalSession(token);
  if (!tenant || !session || session.tenantId !== tenant.id || !z.string().uuid().safeParse(id).success) return fail("session_expired");
  await withTenant(tenant.id, (tx) => deletePortalPhoto(sys(tenant.id, tx), session, id));
  return ok();
}

const submitSchema = z.object({
  lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.number().int().min(0).max(1000) })).min(1).max(100),
  reasonCode: z.string().min(1).max(40),
  resolution: z.string().max(20),
  customerNote: z.string().max(2000).optional().nullable(),
  exchangeNote: z.string().max(500).optional().nullable(),
  trackingCode: z.string().max(60).optional().nullable(),
  trackingCarrier: z.string().max(40).optional().nullable(),
  bankHolder: z.string().max(120).optional().nullable(),
  iban: z.string().max(50).optional().nullable(),
  answers: z.record(z.string(), z.union([z.string().max(2000), z.boolean()])).optional(),
  confirmed: z.boolean().optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  idempotencyKey: z.string().min(8).max(80),
});

export async function portalSubmitAction(slug: string, token: string, input: unknown): Promise<ActionResult<{ number: number; view: PortalView }>> {
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_input");
  const tenant = await portalTenant(slug);
  const session = verifyPortalSession(token);
  if (!tenant || !session || session.tenantId !== tenant.id) return fail("session_expired");
  const settings = parseTenantSettings(tenant.settings);
  try {
    const { created, view } = await withTenant(tenant.id, async (tx) => {
      const ctx = sys(tenant.id, tx);
      const config = await getPortalConfig(ctx);
      const created = await portalSubmit(ctx, settings, config, session, { ...parsed.data, lines: parsed.data.lines.filter((l) => l.quantity > 0) });
      if (!created.duplicate) await recordAudit(tx, { tenantId: tenant.id, actorType: "system", action: "return.created", entityType: "return", entityId: created.id, metadata: { source: "portal", number: created.number } });
      return { created, view: await portalOrderView(ctx, settings, config, session.orderId, token) };
    });
    // the platform hears about it after the customer has their answer
    if (!created.duplicate && settings.returnsWriteBack) {
      after(async () => {
        await withTenant(tenant.id, async (tx) => {
          const ctx = sys(tenant.id, tx);
          await syncReturnToPlatform(ctx, await getCommercePlatformFor(ctx, tenant), settings, created.id);
        }).catch((e) => console.error("[portal] platform sync failed", e));
      });
    }
    return ok({ number: created.number, view: serialize(view) });
  } catch (e) {
    return portalFail(e);
  }
}
