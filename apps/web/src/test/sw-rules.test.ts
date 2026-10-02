import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** Loads public/sw.js in a sandbox with a fake worker scope and returns its cache rule. */
function loadRule(): (r: { method: string; url: string; headers: { get(name: string): string | null } }) => boolean {
  const scope: Record<string, unknown> = { location: { origin: "https://app.example" }, addEventListener: () => undefined };
  vm.runInNewContext(readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8"), { self: scope, URL, Request: class {}, caches: {}, fetch: () => undefined, Response: {} });
  return scope.shouldCacheRequest as never;
}

const req = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => ({
  method: init.method ?? "GET",
  url: new URL(url, "https://app.example").toString(),
  headers: { get: (n: string) => Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? null },
});

describe("service worker cache rules (#49): app shell and static assets only, never tenant data", () => {
  const shouldCache = loadRule();

  it("caches build assets, icons, the manifest and the offline screen", () => {
    for (const u of ["/_next/static/chunks/app/layout-abc.js", "/_next/static/css/app.css", "/_next/static/media/geist.woff2", "/icons/icon-192.png", "/manifest.webmanifest", "/offline", "/icon.svg"]) expect(shouldCache(req(u)), u).toBe(true);
  });

  it("never caches tenant pages, the console, APIs or anything else", () => {
    for (const u of ["/t/northwind-apparel", "/t/northwind-apparel/orders", "/t/northwind-apparel/orders/123?tab=x", "/t/x/orders/export", "/admin", "/admin/tenants", "/api/health", "/api/mcp", "/api/auth/session", "/avatar/1", "/demo-media/a.jpg", "/r/shop", "/s/shop", "/u/token", "/supplier/po/tok", "/", "/login", "/welcome", "/offline?x=1"]) expect(shouldCache(req(u)), u).toBe(false);
  });

  it("never caches RSC payloads, server actions or other methods", () => {
    expect(shouldCache(req("/_next/static/chunks/a.js?_rsc=1x2"))).toBe(false);
    expect(shouldCache(req("/offline?_rsc=abc"))).toBe(false);
    expect(shouldCache(req("/offline", { headers: { RSC: "1" } }))).toBe(false);
    expect(shouldCache(req("/offline", { headers: { "Next-Router-State-Tree": "%5B%5D" } }))).toBe(false);
    expect(shouldCache(req("/offline", { headers: { "Next-Router-Prefetch": "1" } }))).toBe(false);
    expect(shouldCache(req("/t/x/orders", { method: "POST", headers: { "Next-Action": "abc" } }))).toBe(false);
    expect(shouldCache(req("/_next/static/chunks/a.js", { method: "POST" }))).toBe(false);
    expect(shouldCache(req("/_next/static/chunks/a.js", { headers: { "Next-Action": "abc" } }))).toBe(false);
  });

  it("never caches another origin", () => {
    expect(shouldCache(req("https://cdn.example/_next/static/a.js"))).toBe(false);
  });
});
