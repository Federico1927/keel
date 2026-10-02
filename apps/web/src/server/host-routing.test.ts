import { describe, expect, it } from "vitest";
import { effectivePath, routeForHost } from "./host-routing";

const env = { APP_URL: "https://my.hullwise.app", ADMIN_URL: "https://admin.hullwise.app", API_URL: "https://api.hullwise.app" };

describe("routeForHost", () => {
  it("leaves every path alone without dedicated hosts", () => {
    expect(routeForHost("localhost:3000", "/admin/tenants", "", { APP_URL: "http://localhost:3000" })).toEqual({ kind: "next", path: "/admin/tenants" });
    expect(routeForHost("localhost:3000", "/mcp", "", {})).toEqual({ kind: "next", path: "/mcp" });
  });

  it("serves the console at the root of the admin host", () => {
    expect(routeForHost("admin.hullwise.app", "/", "", env)).toEqual({ kind: "rewrite", path: "/admin" });
    expect(routeForHost("admin.hullwise.app", "/tenants", "", env)).toEqual({ kind: "rewrite", path: "/admin/tenants" });
    expect(routeForHost("ADMIN.hullwise.app", "/billing", "", env)).toEqual({ kind: "rewrite", path: "/admin/billing" });
  });

  it("keeps /admin, sign-in pages and assets as they are on the admin host", () => {
    for (const p of ["/admin/tenants", "/login", "/forgot-password", "/reset-password/abc", "/api/auth/session", "/_next/static/x.js", "/brand/logo.svg"]) {
      expect(routeForHost("admin.hullwise.app", p, "", env)).toEqual({ kind: "next", path: p });
    }
  });

  it("sends tenant pages from the admin host to the app host", () => {
    expect(routeForHost("admin.hullwise.app", "/t/northwind-apparel/orders", "?status=new", env)).toEqual({ kind: "redirect", url: "https://my.hullwise.app/t/northwind-apparel/orders?status=new" });
  });

  it("maps API host paths onto /api routes", () => {
    expect(routeForHost("api.hullwise.app", "/mcp", "", env)).toEqual({ kind: "rewrite", path: "/api/mcp" });
    expect(routeForHost("api.hullwise.app", "/webhooks/shopify", "", env)).toEqual({ kind: "rewrite", path: "/api/webhooks/shopify" });
    expect(routeForHost("api.hullwise.app", "/px/abc/script.js", "", env)).toEqual({ kind: "rewrite", path: "/api/px/abc/script.js" });
    expect(routeForHost("api.hullwise.app", "/api/mcp", "", env)).toEqual({ kind: "next", path: "/api/mcp" });
    expect(routeForHost("api.hullwise.app", "/.well-known/oauth-protected-resource/mcp", "", env)).toEqual({ kind: "next", path: "/.well-known/oauth-protected-resource/mcp" });
  });

  it("does not touch the app host", () => {
    expect(routeForHost("my.hullwise.app", "/admin", "", env)).toEqual({ kind: "next", path: "/admin" });
    expect(routeForHost("my.hullwise.app", "/t/harbor-home", "", env)).toEqual({ kind: "next", path: "/t/harbor-home" });
  });
});

describe("effectivePath", () => {
  it("gives access rules the path that is really served", () => {
    expect(effectivePath("admin.hullwise.app", "/", env)).toBe("/admin");
    expect(effectivePath("admin.hullwise.app", "/tenants", env)).toBe("/admin/tenants");
    expect(effectivePath("api.hullwise.app", "/mcp", env)).toBe("/api/mcp");
  });
});
