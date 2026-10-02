import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { API_SCOPES, WEBHOOK_EVENT_TYPES } from "@hullwise/config";
import { API_ERRORS, formatWebhookSignature } from "@hullwise/core";
import { apiRouteCatalog } from "@hullwise/services/api/routes";
import { verificationSnippet } from "@/components/developers/snippets";
import en from "../../messages/en.json";

/**
 * API docs coverage (#81): the docs page renders the route registry, and every route, parameter,
 * scope, error code and event type must have its text, so a route cannot ship undocumented. The
 * verification snippet shown to integrators must actually verify a signature.
 */

const get = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);

describe("API documentation", () => {
  it("documents every route, query parameter and body field of the registry", () => {
    const catalog = apiRouteCatalog();
    expect(catalog.length).toBeGreaterThan(20);
    for (const r of catalog) {
      expect(get(`api_docs.routes.items.${r.id}`), `route ${r.id}`).toBeTypeOf("string");
      for (const q of [...r.query, ...r.body]) expect(get(`api_docs.params.${q}`), `${r.id}: ${q}`).toBeTypeOf("string");
    }
    // no stale entries either
    expect(Object.keys((en as { api_docs: { routes: { items: Record<string, string> } } }).api_docs.routes.items).sort()).toEqual(catalog.map((r) => r.id).sort());
  });

  it("documents every scope, error code and event type", () => {
    for (const s of API_SCOPES) expect(get(`developers.scopes.${s.replace(":", "_")}`), s).toBeTypeOf("string");
    for (const c of Object.keys(API_ERRORS)) expect(get(`api_docs.errors.items.${c}`), c).toBeTypeOf("string");
    for (const e of WEBHOOK_EVENT_TYPES) expect(get(`developers.events.${e.replace(".", "_")}`), e).toBeTypeOf("string");
  });

  it("the verification snippet accepts a real signature and rejects a tampered body", () => {
    const source = verificationSnippet().replace(/^import .*$/m, "").replace("export function", "function");
    const verify = new Function("createHmac", "timingSafeEqual", "Buffer", `${source}\nreturn verifyWebhook;`)(createHmac, timingSafeEqual, Buffer) as (body: string, header: string, secret: string) => boolean;
    const secret = "whsec_test0123456789";
    const body = JSON.stringify({ id: "evt_1", type: "order.created" });
    const t = Math.floor(Date.now() / 1000);
    const header = formatWebhookSignature(t, [createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")]);
    expect(verify(body, header, secret)).toBe(true);
    expect(verify(`${body} `, header, secret)).toBe(false);
    expect(verify(body, header, "whsec_other")).toBe(false);
    const old = t - 3600;
    expect(verify(body, formatWebhookSignature(old, [createHmac("sha256", secret).update(`${old}.${body}`).digest("hex")]), secret)).toBe(false);
  });
});
