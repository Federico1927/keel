import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { login } from "./helpers";

/**
 * MCP server (#21) end to end on the production build: a personal access token created in the
 * profile, the official SDK client over Streamable HTTP (list, read, proposal), the proposal in the
 * approval inbox; the OAuth flow (discovery, dynamic registration, consent in the browser, code +
 * PKCE); the settings page and the console.
 */

const SLUG = "northwind-apparel";
const base = () => (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

async function sdkClient(token: string): Promise<Client> {
  const client = new Client({ name: "hullwise-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function createToken(page: Page, name: string, scopes: string[]): Promise<string> {
  await page.goto(`/t/${SLUG}/profile`);
  const form = page.getByTestId("mcp-create-token");
  await form.getByLabel(/name|nome|nombre/i).fill(name);
  for (const s of scopes) await page.getByTestId(`mcp-pat-scope-${s}`).check();
  await page.getByTestId("mcp-create-token-submit").click();
  const value = page.getByTestId("mcp-token-value");
  await expect(value).toBeVisible();
  const token = (await value.textContent())!.trim();
  expect(token).toMatch(/^kpat_[0-9A-Za-z]{32}$/);
  return token;
}

test("a personal access token connects the SDK client: list, read, propose; the proposal waits in the inbox", async ({ page }) => {
  await login(page, "ops@northwind.demo");
  const token = await createToken(page, `e2e ${Date.now()}`, ["write:orders"]);
  // the token row shows in the connections table, the secret only once
  await page.reload();
  await expect(page.getByTestId("mcp-token-value")).toHaveCount(0);
  await expect(page.getByTestId("mcp-connection-row").first()).toBeVisible();

  const client = await sdkClient(token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["search_orders", "get_order", "get_kpis", "get_campaigns", "list_products", "propose_order_cancellation", "get_cod_queue"]));
  expect(names).not.toContain("add_order_note"); // write:notes was not granted

  const found = await callJson(client, "search_orders", { status: ["confirmed", "pending_review", "new"], pageSize: 5 });
  const orders = found.orders as { name: string; email: string | null; link: string }[];
  expect(orders.length).toBeGreaterThan(0);
  for (const o of orders) if (o.email) expect(o.email).toMatch(/^.\*\*\*@/);
  expect(orders[0]!.link).toContain(`/t/${SLUG}/orders/`);
  const kpis = await callJson(client, "get_kpis", {});
  expect(kpis).toHaveProperty("netRevenue");

  const reason = `End-to-end test ${Date.now()}: the customer asked to cancel`;
  // the newest open orders may already carry a demo proposal (one card per order and action): take the oldest of the page
  const target = orders.at(-1)!;
  const proposed = await callJson(client, "propose_order_cancellation", { order: target.name, reason });
  expect(proposed.status).toBe("pending_approval");
  await client.close();

  await page.goto(`/t/${SLUG}/approvals`);
  const card = page.getByTestId("proposal-card").filter({ hasText: target.name }).filter({ hasText: reason });
  await expect(card).toBeVisible();
  await card.getByTestId("proposal-approve").click();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("proposals-history")).toContainText(target.name);
  await expect(page.getByTestId("proposals-history").getByRole("row").filter({ hasText: target.name }).first()).toContainText(/approved|approvata|aprobada/i);
});

test("OAuth 2.1: discovery, dynamic registration, consent in the browser, code with PKCE, then tools", async ({ page, request }) => {
  const unauth = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { accept: "application/json, text/event-stream" } });
  expect(unauth.status()).toBe(401);
  expect(unauth.headers()["www-authenticate"]).toContain("resource_metadata=");
  const resource = await (await request.get("/.well-known/oauth-protected-resource/api/mcp")).json();
  expect(resource.resource).toBe(`${base()}/api/mcp`);
  const meta = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(meta.code_challenge_methods_supported).toEqual(["S256"]);

  const redirectUri = "http://127.0.0.1:47123/callback";
  const reg = await request.post(meta.registration_endpoint, { data: { client_name: "E2E Agent", redirect_uris: [redirectUri] } });
  expect(reg.status()).toBe(201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = `${meta.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "read write:notes", state: "xyz123", resource: resource.resource })}`;

  await page.route("http://127.0.0.1:47123/**", (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }));
  await page.goto(authorize);
  // not signed in: the login page keeps the authorize request as `next`
  await page.getByLabel("Email").fill("care@northwind.demo");
  await page.getByLabel("Password").fill("hullwise-demo-2026");
  await page.getByRole("button", { name: /sign in|accedi|entrar/i }).click();
  await expect(page.getByTestId("mcp-consent-client")).toContainText("E2E Agent");
  await expect(page.getByTestId("mcp-consent-scope-write:notes")).toBeChecked();
  const [callback] = await Promise.all([page.waitForRequest((r) => r.url().startsWith(redirectUri)), page.getByTestId("mcp-consent-approve").click()]);
  const back = new URL(callback.url());
  expect(back.searchParams.get("state")).toBe("xyz123");
  expect(back.searchParams.get("iss")).toBe(base());
  const code = back.searchParams.get("code")!;
  expect(code).toMatch(/^kac_/);

  const tokenRes = await request.post(meta.token_endpoint, { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: redirectUri, resource: resource.resource } });
  expect(tokenRes.status()).toBe(200);
  const tokens = await tokenRes.json();
  expect(tokens.scope).toBe("read write:notes");
  const replay = await request.post(meta.token_endpoint, { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id } });
  expect(replay.status()).toBe(400);

  const client = await sdkClient(tokens.access_token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("add_order_note");
  expect(names).not.toContain("get_campaigns"); // customer care cannot see campaigns
  const returns = await callJson(client, "list_returns", { status: "open", pageSize: 3 });
  expect(returns).toHaveProperty("total");
  await client.close();

  const refreshed = await request.post(meta.token_endpoint, { form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id } });
  expect(refreshed.status()).toBe(200);
  await request.post(meta.revocation_endpoint, { form: { token: (await refreshed.json()).refresh_token, client_id } });
});

test("settings show the server URL, guides and connections; the console shows usage per tenant", async ({ page, browser }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`/t/${SLUG}/settings/ai`);
  await expect(page.getByTestId("mcp-settings-server-url")).toContainText("/api/mcp");
  await expect(page.getByTestId("mcp-enabled-switch")).toBeChecked();
  await expect(page.getByTestId("mcp-guide-step").first()).toBeVisible();
  await expect(page.getByTestId("mcp-connections-table").getByTestId("mcp-connection-row").first()).toBeVisible();
  await expect(page.getByTestId("mcp-activity")).toBeVisible();

  const adminPage = await (await browser.newContext()).newPage();
  await login(adminPage, "superadmin@hullwise.demo");
  await adminPage.goto("/admin/mcp");
  await expect(adminPage.getByTestId("admin-mcp-row").filter({ hasText: "Northwind Apparel" })).toBeVisible();
  await expect(adminPage.getByTestId("admin-mcp-row").filter({ hasText: "Harbor Home" })).toBeVisible();
});
