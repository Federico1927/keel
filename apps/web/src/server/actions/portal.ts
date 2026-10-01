"use server";
import { after } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { SUPPORTED_LOCALES } from "@keel/config";
import { parseTenantSettings } from "@keel/core";
import { adminDb, eq, recordAudit, schema, withTenant } from "@keel/db";
import { PortalError, customerTracking, deletePortalPhoto, signReturnLink, getCommercePlatformFor, getPortalConfig, portalLookup, portalOrderView, portalSubmit, savePortalPhoto, syncReturnToPlatform, verifyPortalSession, type PortalOrderView, type ServiceContext } from "@keel/services";
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
  exchangeLines: z.array(z.object({ orderLineId: z.string().uuid(), variantId: z.string().uuid(), quantity: z.number().int().min(1).max(1000) })).max(100).optional(),
});

export async function portalSubmitAction(slug: string, token: string, input: unknown): Promise<ActionResult<{ number: number; view: PortalView; labelPath: string | null }>> {
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_input");
  const tenant = await portalTenant(slug);
  const session = verifyPortalSession(token);
  if (!tenant || !session || session.tenantId !== tenant.id) return fail("session_expired");
  const settings = parseTenantSettings(tenant.settings);
  try {
    const { created, view, hasLabel } = await withTenant(tenant.id, async (tx) => {
      const ctx = sys(tenant.id, tx);
      const config = await getPortalConfig(ctx);
      const created = await portalSubmit(ctx, settings, config, session, { ...parsed.data, lines: parsed.data.lines.filter((l) => l.quantity > 0) });
      if (!created.duplicate) await recordAudit(tx, { tenantId: tenant.id, actorType: "system", action: "return.created", entityType: "return", entityId: created.id, metadata: { source: "portal", number: created.number } });
      const [row] = await tx.select({ labelProvider: schema.returnRequests.labelProvider }).from(schema.returnRequests).where(eq(schema.returnRequests.id, created.id)).limit(1);
      return { created, view: await portalOrderView(ctx, settings, config, session.orderId, token), hasLabel: Boolean(row?.labelProvider) };
    });
    // the platform hears about it after the customer has their answer
    if (!created.duplicate && settings.returnsWriteBack) {
      after(async () => {
        await withTenant(tenant.id, async (tx) => {
          const ctx = sys(tenant.id, tx);
          await syncReturnToPlatform(ctx, await getCommercePlatformFor(ctx, tenant), settings, created.id, { country: tenant.country });
        }).catch((e) => console.error("[portal] platform sync failed", e));
      });
    }
    return ok({ number: created.number, view: serialize(view), labelPath: hasLabel ? `/r/${slug}/label/${created.id}?sig=${signReturnLink(tenant.id, created.id)}` : null });
  } catch (e) {
    return portalFail(e);
  }
}

export interface TrackingView {
  orderName: string;
  status: string;
  placedAt: string;
  shipments: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; status: string; shippedAt: string | null; deliveredAt: string | null; estimatedDelivery: string | null; events: { status: string; description: string | null; location: string | null; occurredAt: string }[] }[];
  returns: PortalView["returns"];
}

/** Public order tracking: the same lookup (and rate limit) as the return portal, then parcels and events. */
export async function portalTrackAction(slug: string, input: unknown): Promise<ActionResult<TrackingView>> {
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) return fail("invalid_input");
  const tenant = await portalTenant(slug);
  if (!tenant) return fail("disabled");
  const ip = await clientIp();
  try {
    const out = await withTenant(tenant.id, async (tx) => {
      const ctx = sys(tenant.id, tx);
      const config = await getPortalConfig(ctx);
      if (!config.trackingPage) return null;
      const view = await portalLookup(ctx, parseTenantSettings(tenant.settings), tenant, config, { ...parsed.data, ip });
      if (!view) return { notFound: true as const };
      const session = verifyPortalSession(view.token)!;
      const tr = await customerTracking(ctx, session.orderId);
      return tr ? { view, tr } : { notFound: true as const };
    });
    if (out === null) return fail("disabled");
    if ("notFound" in out) return fail("not_found");
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return ok({
      orderName: out.tr.orderName,
      status: out.tr.status,
      placedAt: out.tr.placedAt.toISOString(),
      shipments: out.tr.shipments.map((s) => ({ ...s, shippedAt: iso(s.shippedAt), deliveredAt: iso(s.deliveredAt), estimatedDelivery: iso(s.estimatedDelivery), events: s.events.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })) })),
      returns: serialize(out.view).returns,
    });
  } catch (e) {
    return portalFail(e);
  }
}
