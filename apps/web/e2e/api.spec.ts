import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Public REST API and outgoing webhooks (#81) end to end on the production build: an API token
 * created in Settings → Developers, `GET /api/v1/orders` with cursor pages, a write with an
 * Idempotency-Key, a webhook endpoint pointing at a receiver started by this test on loopback, a
 * signed delivery (test event and a real status change) and the delivery log.
 *
 * The server must run with HULLWISE_WEBHOOKS_ALLOW_LOOPBACK=1 (playwright.config.ts sets it for the
 * server it starts; with E2E_NO_SERVER start yours with it): loopback receivers are refused otherwise.
 */

const SLUG = "northwind-apparel";

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}
let server: Server;
const received: Received[] = [];
let receiverUrl = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hullwise-e2e`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createToken(page: Page, scopes: string[]): Promise<string> {
  await page.goto(`/t/${SLUG}/settings/developers`);
  const form = page.getByTestId("api-create-token");
  await form.getByLabel(/name|nome|nombre/i).fill(`e2e api ${Date.now()}`);
  for (const s of scopes) await page.getByTestId(`api-scope-${s}`).check();
  await page.getByTestId("api-create-token-submit").click();
  const value = page.getByTestId("api-token-value");
  await expect(value).toBeVisible();
  const token = (await value.textContent())!.trim();
  expect(token).toMatch(/^kpat_[0-9A-Za-z]{32}$/);
  return token;
}

function verify(r: Received, secret: string): boolean {
  const header = String(r.headers["webhook-signature"] ?? "");
  const t = Number(/t=(\d+)/.exec(header)?.[1]);
  const expected = createHmac("sha256", secret).update(`${t}.${r.body}`).digest("hex");
  return header.split(",").some((p) => p.trim() === `v1=${expected}`);
}

test("API token → GET /api/v1/orders with cursors, an idempotent write, a signed webhook delivery in the log", async ({ page, request }) => {
  await login(page, "owner@northwind.demo");
  await page.goto(`/t/${SLUG}/settings`);
  await page.getByTestId("developers-settings-link").click();
  await expect(page).toHaveURL(/\/settings\/developers$/);
  const token = await createToken(page, ["orders:read", "orders:write", "webhooks:manage"]);
  const auth = { Authorization: `Bearer ${token}` };

  // reads: two pages of orders, no overlap
  const first = await request.get("/api/v1/orders?limit=5", { headers: auth });
  expect(first.status()).toBe(200);
  const p1 = await first.json();
  expect(p1).toMatchObject({ object: "list", hasMore: true });
  expect(p1.data).toHaveLength(5);
  expect(p1.data[0]).toMatchObject({ object: "order", id: expect.any(String), totalMinor: expect.any(Number) });
  // personal data is masked without pii:read
  for (const o of p1.data) if (o.email) expect(o.email).toMatch(/^.\*\*\*@/);
  const second = await (await request.get(`/api/v1/orders?limit=5&cursor=${p1.nextCursor}`, { headers: auth })).json();
  expect(second.data.map((o: { id: string }) => o.id).some((id: string) => p1.data.some((o: { id: string }) => o.id === id))).toBe(false);
  // errors: JSON with a stable code
  const denied = await request.get("/api/v1/customers", { headers: auth });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe("insufficient_scope");
  expect((await request.get("/api/v1/orders")).status()).toBe(401);

  // webhook endpoint at the local receiver, created in the UI: the secret is shown once
  await page.reload();
  const create = page.getByTestId("webhook-create");
  await create.getByLabel("URL").fill(receiverUrl);
  await page.getByTestId("webhook-event-order.status_changed").check();
  await page.getByTestId("webhook-create-submit").click();
  const secretField = page.getByTestId("webhook-secret-value");
  await expect(secretField).toBeVisible();
  const secret = (await secretField.textContent())!.trim();
  expect(secret).toMatch(/^whsec_/);
  await page.reload();
  const row = page.getByTestId("webhook-endpoint-row").filter({ hasText: receiverUrl });
  await expect(row).toBeVisible();

  // a test event, then a real status change through the API (idempotent)
  await row.getByTestId("webhook-test").click();
  await expect.poll(() => received.filter((r) => JSON.parse(r.body).type === "webhook.test").length, { timeout: 15_000 }).toBe(1);
  const open = (await (await request.get("/api/v1/orders?status=confirmed&limit=1", { headers: auth })).json()).data[0];
  const key = `e2e-${Date.now()}`;
  const hold = await request.post(`/api/v1/orders/${open.id}/status`, { headers: { ...auth, "Idempotency-Key": key }, data: { status: "on_hold", note: "e2e: waiting for the customer" } });
  expect(hold.status()).toBe(200);
  expect(await hold.json()).toMatchObject({ status: "on_hold", previousStatus: "confirmed" });
  const replay = await request.post(`/api/v1/orders/${open.id}/status`, { headers: { ...auth, "Idempotency-Key": key }, data: { status: "on_hold", note: "e2e: waiting for the customer" } });
  expect(replay.headers()["idempotency-replayed"]).toBe("true");
  await expect.poll(() => received.filter((r) => JSON.parse(r.body).type === "order.status_changed").length, { timeout: 15_000 }).toBe(1);
  const event = received.find((r) => JSON.parse(r.body).type === "order.status_changed")!;
  expect(verify(event, secret)).toBe(true);
  expect(JSON.parse(event.body).data).toMatchObject({ previousStatus: "confirmed", status: "on_hold", order: { id: open.id } });
  expect(JSON.parse(event.body).data.order).not.toHaveProperty("email");

  // the delivery log shows both deliveries as delivered, with the payload in the detail
  await page.goto(`/t/${SLUG}/settings/developers/deliveries`);
  const deliveries = page.getByTestId("webhook-delivery-row").filter({ hasText: receiverUrl });
  await expect(deliveries).toHaveCount(2);
  await expect(deliveries.first()).toHaveAttribute("data-status", "succeeded");
  await page.getByTestId("delivery-filters").getByLabel(/event|evento/i).selectOption("order.status_changed");
  await page.getByTestId("delivery-filters-apply").click();
  const statusRow = page.getByTestId("webhook-delivery-row").filter({ hasText: receiverUrl });
  await expect(statusRow).toHaveCount(1);
  await statusRow.getByRole("link", { name: "order.status_changed" }).click();
  await expect(page.getByTestId("delivery-payload")).toContainText(open.id);

  // the docs page lists every route
  await page.goto(`/t/${SLUG}/settings/developers/docs`);
  await expect(page.locator('[data-route="GET /v1/orders"]')).toBeVisible();
  await expect(page.getByTestId("api-docs-route")).toHaveCount(25);
});
