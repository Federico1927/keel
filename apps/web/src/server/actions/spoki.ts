"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, recordAudit, schema } from "@hullwise/db";
import { MockSpokiChannel, SpokiChannel, encryptJson, integrationMode, type ConnectionTest, type SpokiDeliveryStatus } from "@hullwise/integrations";
import { SpokiError, getSpokiApiFor, saveSpokiSettings, syncSpokiTemplates } from "@hullwise/addon-spoki";
import { getCodSettings, saveCodSettings, parseTagList } from "@hullwise/addon-cod";
import { handleSpokiEvent } from "@hullwise/jobs";
import { ORDER_MESSAGE_EVENTS } from "@hullwise/core";
import { auditActor } from "@/server/audit-actor";
import { spokiWebhookUrl } from "@/server/spoki-webhook";
import { ForbiddenError, requireAction, requireWrite, type TenantContext } from "@/server/tenant";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Server actions of the Spoki WhatsApp add-on (issue #9). Every action checks the add-on's page
 * (`whatsapp_settings`, a 404-equivalent `module_disabled` when the add-on is off) and the role:
 * settings need write on the page, the connection needs `manage_integrations`.
 */
const svc = (ctx: TenantContext, tx: Parameters<Parameters<TenantContext["run"]>[0]>[0]) => ({ tenantId: ctx.tenant.id, tx, actor: { type: "user" as const, userId: ctx.user.id } });
const handle = (e: unknown): ActionResult => {
  if (e instanceof ForbiddenError) return fail(e.message === "module_disabled" ? "module_disabled" : "forbidden");
  if (e instanceof SpokiError) return fail(`spoki_${e.code}`, e.detail ? { platform: e.detail } : undefined);
  throw e;
};
const requireManage = (slug: string) => requireAction(slug, "manage_integrations", "whatsapp_settings");
const paths = (slug: string) => {
  revalidatePath(`/t/${slug}/whatsapp/settings`);
  revalidatePath(`/t/${slug}/integrations`);
};

const list = (v: FormDataEntryValue | null) => parseTagList(String(v ?? "")).slice(0, 20);

/** Sender, template language, template per event (id + custom fields), notifications, opt-out keywords. */
export async function saveSpokiSettingsAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "whatsapp_settings");
    const keys = String(formData.get("templateKeys") ?? "").split(",").filter(Boolean);
    const templates: Record<string, unknown> = {};
    for (const k of keys) {
      const id = String(formData.get(`tpl:${k}`) ?? "").trim();
      const fields = Object.fromEntries(String(formData.get(`fields:${k}`) ?? "").split(/[,\n]/).map((x) => x.split("=").map((y) => y.trim())).filter((p) => p.length === 2 && p[0] && p[1]) as [string, string][]);
      const name = String(formData.get(`name:${k}`) ?? "").trim() || null;
      templates[k] = id || Object.keys(fields).length ? { templateId: id || null, templateName: name, fields } : null;
    }
    const patch = {
      senderNumber: String(formData.get("senderNumber") ?? "").replace(/[\s()-]/g, "") || null,
      templateLanguage: String(formData.get("templateLanguage") ?? "").trim() || null,
      templates,
      notify: Object.fromEntries(ORDER_MESSAGE_EVENTS.map((e) => [e, formData.get(`notify:${e}`) === "on"])),
      optOutKeywords: list(formData.get("optOutKeywords")),
    };
    await ctx.run((tx) => saveSpokiSettings(svc(ctx, tx), patch));
    paths(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** COD reply keywords (both add-ons on): stored in the COD settings, where the COD add-on reads them. */
export async function saveCodRepliesAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireWrite(slug, "whatsapp_settings");
    if (!ctx.activeAddons.includes("addon.cod")) return fail("module_disabled");
    const next = { confirm: list(formData.get("confirm")), cancel: list(formData.get("cancel")) };
    await ctx.run(async (tx) => {
      const before = (await getCodSettings(svc(ctx, tx))).messagingReplies;
      await saveCodSettings(svc(ctx, tx), { messagingReplies: next });
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "cod.settings_updated", entityType: "cod_settings", diff: { messagingReplies: { from: before, to: next } } });
    });
    paths(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

async function upsertIntegration(ctx: TenantContext, values: { mode: string; externalAccountId: string; externalAccountName: string; credentialsEncrypted: string | null }, diff: Record<string, unknown>) {
  await ctx.run(async (tx) => {
    const now = new Date();
    const row = { status: "connected", ...values, config: { webhookUrl: spokiWebhookUrl(ctx.tenant.id) }, lastError: null, lastSuccessAt: now, updatedAt: now };
    await tx.insert(schema.integrations).values({ tenantId: ctx.tenant.id, provider: "spoki", ...row }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: row });
    await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.connected", entityType: "integration", entityId: "spoki", diff });
    const s = svc(ctx, tx);
    const api = await getSpokiApiFor(s);
    if (api) await syncSpokiTemplates(s, api).catch(() => undefined);
  });
}

const connectSchema = z.object({ apiKey: z.string().trim().min(16).max(200) });
/** Live connection with the store's Spoki API key: tested with one template page, stored encrypted (AES-GCM), templates read. */
export async function connectSpokiAction(slug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireManage(slug);
    const parsed = connectSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) return fail("invalid_input");
    if (integrationMode() !== "live") return fail("mock_mode");
    const test = await new SpokiChannel({ apiKey: parsed.data.apiKey }).testConnection();
    if (!test.ok) return fail("connection_failed", { platform: test.error ?? "" });
    await upsertIntegration(ctx, { mode: "live", externalAccountId: "spoki", externalAccountName: test.accountName ?? "Spoki", credentialsEncrypted: encryptJson({ apiKey: parsed.data.apiKey }) }, { status: { from: null, to: "connected" }, mode: { from: null, to: "live" } });
    paths(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

/** Mock mode: connects the simulated Spoki account (records sends, approved demo templates). */
export async function connectSpokiMockAction(slug: string): Promise<ActionResult> {
  try {
    const ctx = await requireManage(slug);
    const [row] = await ctx.run((tx) => tx.select().from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki"))).limit(1));
    if (integrationMode() === "live" && row?.mode === "live" && row.status !== "not_connected") return fail("live_mode");
    await upsertIntegration(ctx, { mode: "mock", externalAccountId: "spoki-mock", externalAccountName: "Simulated Spoki account", credentialsEncrypted: null }, { status: { from: row?.status ?? null, to: "connected" }, mode: { from: row?.mode ?? null, to: "mock" } });
    paths(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function disconnectSpokiAction(slug: string): Promise<ActionResult> {
  try {
    const ctx = await requireManage(slug);
    await ctx.run(async (tx) => {
      await tx.update(schema.integrations).set({ status: "not_connected", credentialsEncrypted: null, mode: "mock", lastError: null, updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki")));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.disconnected", entityType: "integration", entityId: "spoki", diff: { status: { from: "connected", to: "not_connected" } } });
    });
    paths(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}

export async function testSpokiAction(slug: string): Promise<ActionResult<ConnectionTest>> {
  try {
    const ctx = await requireManage(slug);
    const r = await ctx.run(async (tx) => {
      const api = await getSpokiApiFor(svc(ctx, tx));
      if (!api) return { ok: false, error: "not connected" } satisfies ConnectionTest;
      const test = await api.testConnection().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as ConnectionTest);
      await tx.update(schema.integrations).set(test.ok ? { lastSuccessAt: new Date(), lastError: null, status: "connected", updatedAt: new Date() } : { lastError: test.error ?? "connection failed", status: "error", updatedAt: new Date() }).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki")));
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.tested", entityType: "integration", entityId: "spoki", diff: { ok: { from: null, to: test.ok } } });
      return test;
    });
    paths(slug);
    return ok(r);
  } catch (e) {
    return handle(e) as ActionResult<ConnectionTest>;
  }
}

/** "Resync": reads the account's templates (the settings page offers the approved ones per event). */
export async function resyncSpokiAction(slug: string): Promise<ActionResult<{ templates: number; approved: number }>> {
  try {
    const ctx = await requireManage(slug);
    const r = await ctx.run(async (tx) => {
      const s = svc(ctx, tx);
      const api = await getSpokiApiFor(s);
      if (!api) throw new SpokiError("not_connected");
      await recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.resync_requested", entityType: "integration", entityId: "spoki" });
      return syncSpokiTemplates(s, api);
    });
    paths(slug);
    return ok(r);
  } catch (e) {
    return handle(e) as ActionResult<{ templates: number; approved: number }>;
  }
}

const simulateSchema = z.object({ messageId: z.string().min(1).max(120), kind: z.enum(["delivered", "read", "failed", "reply", "stop"]), text: z.string().max(300).optional() });

/**
 * Mock mode only: Spoki's webhook for one logged message (a receipt, a reply or an opt-out),
 * posted to this tenant's own webhook URL, so the route, the token, idempotency and processing run
 * exactly as with the provider.
 */
export async function simulateSpokiWebhookAction(slug: string, input: unknown): Promise<ActionResult<{ status: number }>> {
  try {
    const ctx = await requireManage(slug);
    const parsed = simulateSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_input");
    const [msg] = await ctx.run((tx) => tx.select({ phone: schema.spokiMessages.phone, providerMessageId: schema.spokiMessages.providerMessageId }).from(schema.spokiMessages).where(and(eq(schema.spokiMessages.tenantId, ctx.tenant.id), eq(schema.spokiMessages.providerMessageId, parsed.data.messageId))).limit(1));
    if (!msg) return fail("not_found");
    const [row] = await ctx.run((tx) => tx.select({ mode: schema.integrations.mode }).from(schema.integrations).where(and(eq(schema.integrations.tenantId, ctx.tenant.id), eq(schema.integrations.provider, "spoki"))).limit(1));
    if (integrationMode() === "live" && row?.mode === "live") return fail("live_mode");
    const { kind } = parsed.data;
    const body = kind === "reply" || kind === "stop" ? MockSpokiChannel.inboundBody(msg.phone, kind === "stop" ? "STOP" : (parsed.data.text?.trim() || "OK"), { replyTo: msg.providerMessageId }) : MockSpokiChannel.statusBody(msg.providerMessageId!, kind as SpokiDeliveryStatus, { phone: msg.phone, errorCode: kind === "failed" ? "whatsapp::131026" : undefined });
    const res = await fetch(spokiWebhookUrl(ctx.tenant.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // the route processes after answering: give it a moment so the page shows the result
    await new Promise((r) => setTimeout(r, 400));
    await ctx.run((tx) => recordAudit(tx, { tenantId: ctx.tenant.id, ...auditActor(ctx), action: "integration.webhook_simulated", entityType: "integration", entityId: "spoki", diff: { scenario: { from: null, to: kind }, status: { from: null, to: res.status } }, metadata: { messageId: parsed.data.messageId } }));
    paths(slug);
    revalidatePath(`/t/${slug}/orders`, "layout");
    revalidatePath(`/t/${slug}/cod`);
    return ok({ status: res.status });
  } catch (e) {
    return handle(e) as ActionResult<{ status: number }>;
  }
}

/** Replays one stored Spoki webhook event now (the Integrations page's "Replay"). */
export async function replaySpokiEventAction(slug: string, eventId: string): Promise<ActionResult> {
  try {
    const ctx = await requireManage(slug);
    if (!z.string().uuid().safeParse(eventId).success) return fail("invalid_input");
    await handleSpokiEvent(ctx.tenant.id, eventId).catch(() => undefined);
    paths(slug);
    return ok();
  } catch (e) {
    return handle(e);
  }
}
