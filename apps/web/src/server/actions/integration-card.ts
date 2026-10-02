"use server";
import { connectTiktokMock, disconnectIntegration, resyncIntegration, simulateReturnWebhook, simulateWebhook, testIntegration } from "@/server/actions/integrations";
import { disconnectGa4, resyncGa4, testGa4 } from "@/server/actions/ga4";
import { disconnectSpokiAction, resyncSpokiAction, testSpokiAction } from "@/server/actions/spoki";
import { resyncSubscriptionsAction, simulateRenewalAction, testSubscriptionProviderAction } from "@/server/actions/subscriptions";
import { resyncAccountsAction, simulateAccountingFailureAction, testAccountingAction } from "@/server/actions/accounting";
import type { ActionResult } from "@/server/action-result";
import type { SetupFacts } from "@/server/integration-verify";
import { CARD_SIMULATIONS } from "@/server/integration-setup";

/**
 * One entry point for the actions of the shared integration card (#90): Test connection, Resync,
 * Disconnect and the mock-only simulations, for every provider. It calls the provider's own action
 * (which checks the role, the plan and the add-on) and answers in one shape the card can show: message
 * keys with their values, or the plain-words setup error of the provider's guide and what was verified.
 */
export type CardMessage = { key: string; values?: Record<string, string | number> };
export interface CardOutcome {
  ok: boolean;
  messages: CardMessage[];
  /** A failed call: the error code (resolved against the integration namespaces) and the vendor's words. */
  error?: { code: string; detail: string | null } | null;
  /** A failed test explained by a setup guide (`guide` = its provider key). */
  setup?: { guide: string; code: string; detail: string | null } | null;
  /** A passed test: what the adapter found (the guide's verification line). */
  verified?: { guide: string; facts: SetupFacts | null } | null;
}

const CORE = ["shopify", "meta", "google", "tiktok", "anthropic", "address"] as const;
type Core = (typeof CORE)[number];
const isCore = (p: string): p is Core => (CORE as readonly string[]).includes(p);


const failed = (r: { ok: false; error: string; fieldErrors?: Record<string, string> }): CardOutcome => ({ ok: false, messages: [], error: { code: r.error, detail: r.fieldErrors?.platform ?? null } });
const done = (...messages: CardMessage[]): CardOutcome => ({ ok: true, messages });

async function test(slug: string, provider: string): Promise<CardOutcome> {
  if (isCore(provider)) {
    const r = await testIntegration(slug, provider);
    if (!r.ok) return failed(r);
    const d = r.data!;
    if (!d.ok) return d.setup ? { ok: false, messages: [], setup: { guide: provider, code: d.setup, detail: d.error ?? null } } : { ok: false, messages: [{ key: "integrations.test_failed", values: { error: d.error ?? "" } }] };
    const messages: CardMessage[] = [{ key: "integrations.test_ok", values: { account: d.accountName ?? "" } }];
    // Shopify: the scopes still missing on the app version (#89)
    if (d.missingRequiredScopes?.length) messages.push({ key: "integration_setup.shopify.errors.missing_scopes.message", values: { detail: d.missingRequiredScopes.join(", ") } }, { key: "integration_setup.shopify.errors.missing_scopes.fix", values: { detail: "" } });
    else if (provider === "shopify" && d.missingScopes?.length) messages.push({ key: "integration_setup.shopify.missing_optional", values: { scopes: d.missingScopes.join(", ") } });
    return { ok: true, messages, verified: provider === "shopify" ? null : { guide: provider, facts: d.verification } };
  }
  if (provider === "ga4") {
    const r = await testGa4(slug);
    if (!r.ok) return failed(r);
    return r.data!.ok ? done({ key: "integrations.test_ok", values: { account: r.data!.accountName ?? "" } }) : { ok: false, messages: [], setup: { guide: "ga4", code: r.data!.setup ?? "unknown", detail: r.data!.error ?? null } };
  }
  if (provider === "spoki") {
    const r = await testSpokiAction(slug);
    if (!r.ok) return failed(r);
    const d = r.data!;
    if (!d.ok) return d.setup ? { ok: false, messages: [], setup: { guide: "spoki", code: d.setup, detail: d.error ?? null } } : { ok: false, messages: [{ key: "integrations.test_failed", values: { error: d.error ?? "" } }] };
    return { ok: true, messages: [{ key: "integrations.test_ok", values: { account: d.accountName ?? "" } }], verified: { guide: "spoki", facts: d.verification ?? null } };
  }
  if (provider === "subscriptions") {
    const r = await testSubscriptionProviderAction(slug);
    if (!r.ok) return failed(r);
    const d = r.data!;
    const guide = d.provider ?? "shopify_subscriptions";
    if (!d.ok) return d.setup ? { ok: false, messages: [], setup: { guide, code: d.setup, detail: d.error ?? null } } : { ok: false, messages: [{ key: "subscriptions.provider.test_failed", values: { error: d.error ?? "" } }] };
    return { ok: true, messages: [{ key: "subscriptions.provider.test_ok", values: { account: d.accountName ?? "" } }], verified: { guide, facts: d.verification ?? null } };
  }
  if (provider === "accounting") {
    const r = await testAccountingAction(slug);
    if (!r.ok) return failed(r);
    return r.data!.ok ? done({ key: "accounting.connection.test_ok", values: { account: r.data!.accountName ?? "" } }) : { ok: false, messages: [{ key: "accounting.connection.test_failed", values: { error: r.data!.error ?? "" } }] };
  }
  return { ok: false, messages: [], error: { code: "invalid_input", detail: null } };
}

async function resync(slug: string, provider: string): Promise<CardOutcome> {
  if (isCore(provider)) {
    const r = await resyncIntegration(slug, provider);
    return r.ok ? done(r.data!.queued ? { key: "integrations.resync_queued" } : { key: "integrations.resync_done", values: { summary: r.data!.summary } }) : failed(r);
  }
  if (provider === "ga4") {
    const r = await resyncGa4(slug);
    return r.ok ? done(r.data!.queued ? { key: "ga4.card.resync_queued" } : { key: r.data!.finished ? "ga4.card.resync_done" : "ga4.card.backfill_running", values: { n: r.data!.rows } }) : failed(r);
  }
  if (provider === "spoki") {
    const r = await resyncSpokiAction(slug);
    return r.ok ? done({ key: "whatsapp.connection.resynced", values: { n: r.data!.templates, approved: r.data!.approved } }) : failed(r);
  }
  if (provider === "subscriptions") {
    const r = await resyncSubscriptionsAction(slug);
    return r.ok ? done({ key: "subscriptions.provider.resync_done", values: { summary: r.data!.summary } }) : failed(r);
  }
  if (provider === "accounting") {
    const r = await resyncAccountsAction(slug);
    return r.ok ? done({ key: "accounting.connection.resync_done", values: { n: r.data!.accounts } }) : failed(r);
  }
  return { ok: false, messages: [], error: { code: "invalid_input", detail: null } };
}

async function disconnect(slug: string, provider: string): Promise<CardOutcome> {
  const r = isCore(provider) ? await disconnectIntegration(slug, provider) : provider === "ga4" ? await disconnectGa4(slug) : provider === "spoki" ? await disconnectSpokiAction(slug) : null;
  if (!r) return { ok: false, messages: [], error: { code: "invalid_input", detail: null } };
  return r.ok ? done({ key: "integrations.disconnected" }) : failed(r);
}

async function simulate(slug: string, provider: string, kind: string): Promise<CardOutcome> {
  if (!(CARD_SIMULATIONS[provider] ?? []).includes(kind)) return { ok: false, messages: [], error: { code: "invalid_input", detail: null } };
  if (provider === "shopify") {
    if (kind === "return") {
      const r = await simulateReturnWebhook(slug);
      return r.ok ? done({ key: "integrations.simulated_return", values: { status: r.data!.status, order: r.data!.orderName } }) : failed(r);
    }
    const r = await simulateWebhook(slug, kind as "order" | "cancel" | "bad_signature");
    if (!r.ok) return failed(r);
    return done(kind === "bad_signature" ? { key: "integrations.simulated_rejected", values: { status: r.data!.status } } : { key: "integrations.simulated", values: { status: r.data!.status, order: r.data!.orderName ?? "" } });
  }
  if (provider === "subscriptions") {
    const r = await simulateRenewalAction(slug, kind === "renewal" ? "success" : "card_expired");
    return r.ok ? done({ key: "subscriptions.provider.simulated", values: { summary: r.data!.summary } }) : failed(r);
  }
  const r = await simulateAccountingFailureAction(slug);
  return r.ok ? done({ key: "accounting.connection.simulated" }) : failed(r);
}

/** Test connection, Resync, Disconnect or `simulate:<kind>` on a provider's card. */
export async function runIntegrationCardOp(slug: string, provider: string, op: string): Promise<CardOutcome> {
  if (op === "test") return test(slug, provider);
  if (op === "resync") return resync(slug, provider);
  if (op === "disconnect") return disconnect(slug, provider);
  if (op.startsWith("simulate:")) return simulate(slug, provider, op.slice("simulate:".length));
  return { ok: false, messages: [], error: { code: "invalid_input", detail: null } };
}

/** TikTok's simulated account (mock mode), from the setup sheet: connected and imported inline. */
export async function connectTiktokDemo(slug: string): Promise<CardOutcome> {
  const r = await connectTiktokMock(slug);
  if (!r.ok) return failed(r as Extract<ActionResult, { ok: false }>);
  return { ok: true, messages: [{ key: r.data!.finished ? "integrations.tiktok_mock_connected" : "integrations.tiktok_mock_partial", values: { summary: r.data!.summary } }], verified: { guide: "tiktok", facts: r.data!.verification } };
}
