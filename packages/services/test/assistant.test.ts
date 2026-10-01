import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { parseTenantSettings, type AssistantCitation } from "@keel/core";
import { AnthropicLlmProvider, LlmError, MockLlmProvider, type LlmProvider, type LlmRequest, type LlmTurn } from "@keel/integrations";
import type { TenantRole } from "@keel/config";
import { AssistantError, askAssistant, assistantThread, assistantToolsFor, assistantUsage, deleteAssistantThread, issueDueInvoices, kpisForPeriod, listAssistantThreads, MockBillingProvider, repairHistory, type AssistantScope, type ServiceContext, type TenantRunner } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
const now = new Date("2026-10-01T10:00:00Z");
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.05 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());

const runnerFor = (userId: string): TenantRunner => (fn) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "user", userId } } as ServiceContext), pools.app);
const userId = (email: string) => ctx.userIds[email]!;
function scopeFor(email: string, role: TenantRole): AssistantScope {
  return { tenant: { id: tenantId, name: "Northwind Apparel", slug: "northwind-apparel", country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) }, userId: userId(email), role, activeAddons: ["addon.cod", "addon.ai_studio"], locale: "it", now };
}

/** A provider that replays a fixed script of turns and records what it was sent. */
class ScriptedLlm implements LlmProvider {
  readonly provider = "mock" as const;
  readonly model = "scripted";
  readonly requests: LlmRequest[] = [];
  constructor(private readonly turns: (LlmTurn | Error)[]) {}
  async complete(req: LlmRequest): Promise<LlmTurn> {
    this.requests.push(structuredClone(req));
    const t = this.turns.shift();
    if (!t) throw new Error("script exhausted");
    if (t instanceof Error) throw t;
    return t;
  }
}
const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const text = (s: string): LlmTurn => ({ content: [{ type: "text", text: s }], providerContent: null, stopReason: "end_turn", usage, model: "scripted" });

describe("AI assistant", () => {
  it("answers from the tools, cites figures with period and link, and stores every turn with its tokens", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const run = runnerFor(owner.userId);
    const llm = new MockLlmProvider({ today: now });
    const r = await askAssistant(run, owner, llm, { question: "Come sono andati i ricavi e il profitto negli ultimi 7 giorni?" });
    expect(r.outcome).toBe("answered");
    expect(r.steps).toBe(2);
    // the second request carries the tool results in one user message, after the model's tool calls
    const second = llm.requests[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[2]!.content.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(second.system).toContain("2026-10-01");
    expect(second.tools.map((t) => t.name)).toContain("get_stock_risk");

    const thread = (await run((s) => assistantThread(s, owner.userId, r.threadId)))!;
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const answer = thread.messages[1]!;
    expect(answer.tools).toEqual(["get_kpis", "get_profit_and_loss"]);
    expect(answer.text).toContain("Ho consultato 2 fonti");
    const kpis = answer.citations.find((c) => c.tool === "get_kpis")!;
    expect(kpis.period).toEqual({ from: "2026-09-25", to: "2026-10-01" });
    expect(kpis.href).toBe("/t/northwind-apparel/analytics?tab=overview&from=2026-09-25&to=2026-10-01");
    // the cited figure is the analytics figure for the same period
    const direct = await run((s) => kpisForPeriod(s, owner.tenant, { from: new Date("2026-09-25T00:00:00Z"), to: new Date("2026-10-02T00:00:00Z") }));
    expect(kpis.figures.find((f) => f.key === "net_revenue")!.value).toBe(direct.current.netRevenueMinor);

    const threads = await run((s) => listAssistantThreads(s, owner.userId));
    expect(threads[0]).toMatchObject({ id: r.threadId, title: "Come sono andati i ricavi e il profitto negli ultimi 7 giorni?" });
    expect(threads[0]!.inputTokens).toBeGreaterThan(0);
    const u = await run((s) => assistantUsage(s, now));
    expect(u.questions).toBeGreaterThanOrEqual(1);
    expect(u.inputTokens + u.outputTokens).toBe(threads.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0));
  });

  it("every tool runs on the demo data and returns a citation with a link", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const run = runnerFor(owner.userId);
    const tools = assistantToolsFor("owner", owner.activeAddons);
    expect(tools).toHaveLength(7);
    const calls = tools.map((t, i) => ({ type: "tool_use" as const, id: `call_${i}`, name: t.name, input: {} }));
    const llm = new ScriptedLlm([{ content: calls, providerContent: null, stopReason: "tool_use", usage, model: "scripted" }, text("done")]);
    const r = await askAssistant(run, owner, llm, { question: "Everything, please" });
    expect(r.outcome).toBe("answered");
    const results = llm.requests[1]!.messages.at(-1)!.content;
    expect(results.filter((b) => b.type === "tool_result" && b.isError)).toEqual([]);
    const thread = (await run((s) => assistantThread(s, owner.userId, r.threadId)))!;
    const cites = thread.messages[1]!.citations as AssistantCitation[];
    expect(cites.map((c) => c.tool).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const c of cites) expect(c.href).toMatch(/^\/t\/northwind-apparel\//);
    // tool data for the model is in major units of the store currency
    const kpiData = JSON.parse((results[0] as { content: string }).content) as { currency: string; netRevenue: number };
    expect(kpiData.currency).toBe("EUR");
    expect(Math.abs(kpiData.netRevenue * 100 - Math.round(kpiData.netRevenue * 100))).toBeLessThan(1e-6);
  });

  it("only offers the tools the role can see", async () => {
    const care = assistantToolsFor("customer_care", ["addon.ai_studio"]).map((t) => t.name);
    expect(care).toEqual(["get_returns_summary", "get_customer_predictions", "get_stock_risk"]);
    const marketing = assistantToolsFor("marketing", ["addon.ai_studio"]).map((t) => t.name);
    expect(marketing).toContain("get_campaigns");
    const scope = scopeFor("care@northwind.demo", "customer_care");
    const llm = new MockLlmProvider({ today: now });
    const r = await askAssistant(runnerFor(scope.userId), scope, llm, { question: "Quanto abbiamo speso in campagne?" });
    expect(r.outcome).toBe("answered");
    expect(llm.requests[0]!.tools.map((t) => t.name)).toEqual(care);
    expect(llm.requests[0]!.system).toContain("This user's role gives access to: get_returns_summary");
    // a tool the role cannot use is refused even if the model asks for it
    const sneaky = new ScriptedLlm([{ content: [{ type: "tool_use", id: "x1", name: "get_profit_and_loss", input: {} }], providerContent: null, stopReason: "tool_use", usage, model: "scripted" }, text("ok")]);
    await askAssistant(runnerFor(scope.userId), scope, sneaky, { question: "P/L?" });
    expect(sneaky.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("returns invalid tool input to the model as an error it can correct", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const llm = new ScriptedLlm([
      { content: [{ type: "tool_use", id: "a", name: "get_kpis", input: { from: "2026-09-30", to: "2026-09-01" } }, { type: "tool_use", id: "b", name: "get_top_products", input: { limit: 500 } }], providerContent: null, stopReason: "tool_use", usage, model: "scripted" },
      { content: [{ type: "tool_use", id: "c", name: "get_kpis", input: { from: "2026-09-01", to: "2026-09-30" } }], providerContent: null, stopReason: "tool_use", usage, model: "scripted" },
      text("September was fine."),
    ]);
    const r = await askAssistant(runnerFor(owner.userId), owner, llm, { question: "How was September?" });
    expect(r.outcome).toBe("answered");
    const firstResults = llm.requests[1]!.messages.at(-1)!.content;
    expect(firstResults[0]).toMatchObject({ isError: true, content: expect.stringContaining("after") });
    expect(firstResults[1]).toMatchObject({ isError: true, content: expect.stringContaining("limit") });
    const thread = (await runnerFor(owner.userId)((s) => assistantThread(s, owner.userId, r.threadId)))!;
    expect(thread.messages[1]!.citations.map((c) => c.period)).toEqual([{ from: "2026-09-01", to: "2026-09-30" }]);
  });

  it("a follow-up keeps the conversation, the model's own blocks included; a failed question is left out", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const run = runnerFor(owner.userId);
    const thinking = [{ type: "thinking", thinking: "...", signature: "sig-1" }, { type: "text", text: "Revenue was up." }];
    const llm = new ScriptedLlm([{ content: [{ type: "text", text: "Revenue was up." }], providerContent: thinking, stopReason: "end_turn", usage, model: "scripted" }, new LlmError("rate_limited", "429"), text("Orders were up too.")]);
    const first = await askAssistant(run, owner, llm, { question: "Revenue?" });
    const failed = await askAssistant(run, owner, llm, { threadId: first.threadId, question: "And returns?" });
    expect(failed).toMatchObject({ outcome: "error", errorCode: "rate_limited" });
    const third = await askAssistant(run, owner, llm, { threadId: first.threadId, question: "And orders?" });
    expect(third.outcome).toBe("answered");
    const sent = llm.requests[2]!.messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[1]!.providerContent).toEqual(thinking);
    expect(sent[2]!.content).toEqual([{ type: "text", text: "And orders?" }]);
    const thread = (await run((s) => assistantThread(s, owner.userId, first.threadId)))!;
    expect(thread.messages.map((m) => [m.role, m.errorCode])).toEqual([["user", null], ["assistant", null], ["user", null], ["assistant", "rate_limited"], ["user", null], ["assistant", null]]);
  });

  it("repairs a history whose tool calls were never answered", () => {
    const repaired = repairHistory([
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_kpis", input: {} }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ]);
    expect(repaired.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repaired[2]!.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
  });

  it("works with the Anthropic adapter end to end on recorded responses", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const bodies: { messages: { role: string; content: { type: string }[] }[] }[] = [];
    const replies = [
      { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 90 }, content: [{ type: "thinking", thinking: "Need KPIs.", signature: "s1" }, { type: "tool_use", id: "toolu_1", name: "get_kpis", input: { from: "2026-09-01", to: "2026-09-30" } }] },
      { id: "m2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2400, output_tokens: 60 }, content: [{ type: "text", text: "In September net revenue was …" }] },
    ];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const r = await askAssistant(runnerFor(owner.userId), owner, new AnthropicLlmProvider({ apiKey: "test", fetch: fetchImpl, maxRetries: 0 }), { question: "September revenue?" });
    expect(r.outcome).toBe("answered");
    // the thinking block survived the database round trip and went back verbatim
    expect(bodies[1]!.messages[1]!.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(bodies[1]!.messages[2]!.content.map((b) => b.type)).toEqual(["tool_result"]);
    const [t] = await runnerFor(owner.userId)((s) => s.tx.select().from(schema.assistantThreads).where(eq(schema.assistantThreads.id, r.threadId)));
    expect(t).toMatchObject({ inputTokens: 4400, outputTokens: 150 });
  });

  it("threads are private to their user, and the monthly budget stops new questions", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const viewer = scopeFor("viewer@northwind.demo", "viewer");
    const mine = await askAssistant(runnerFor(owner.userId), owner, new MockLlmProvider({ today: now }), { question: "Stock?" });
    expect(await runnerFor(viewer.userId)((s) => assistantThread(s, viewer.userId, mine.threadId))).toBeNull();
    await expect(askAssistant(runnerFor(viewer.userId), viewer, new MockLlmProvider({ today: now }), { threadId: mine.threadId, question: "hi" })).rejects.toMatchObject({ code: "thread_not_found" });
    expect(await runnerFor(viewer.userId)((s) => deleteAssistantThread(s, viewer.userId, mine.threadId))).toBe(false);
    await expect(askAssistant(runnerFor(owner.userId), owner, new MockLlmProvider(), { question: "   " })).rejects.toBeInstanceOf(AssistantError);

    // a month far in the future with the budget already used
    const later = { ...owner, now: new Date("2031-05-10T10:00:00Z") };
    const t = await askAssistant(runnerFor(owner.userId), later, new ScriptedLlm([{ ...text("x"), usage: { inputTokens: 6_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }]), { question: "big" });
    await pools.admin.update(schema.assistantMessages).set({ createdAt: new Date("2031-05-10T09:00:00Z") }).where(eq(schema.assistantMessages.threadId, t.threadId));
    await expect(askAssistant(runnerFor(owner.userId), later, new MockLlmProvider(), { question: "more" })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(await runnerFor(owner.userId)((s) => deleteAssistantThread(s, owner.userId, t.threadId))).toBe(true);
  });

  it("bills the tokens of the period that ended as a usage line", async () => {
    const owner = scopeFor("owner@northwind.demo", "owner");
    const t = await askAssistant(runnerFor(owner.userId), owner, new ScriptedLlm([{ ...text("x"), usage: { inputTokens: 2_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }]), { question: "usage" });
    await pools.admin.update(schema.assistantMessages).set({ createdAt: new Date("2020-01-15T00:00:00Z") }).where(eq(schema.assistantMessages.threadId, t.threadId));
    await pools.admin.update(schema.subscriptions).set({ currentPeriodStart: new Date("2020-01-01T00:00:00Z"), currentPeriodEnd: new Date("2020-02-01T00:00:00Z") }).where(eq(schema.subscriptions.tenantId, tenantId));
    await issueDueInvoices(pools.admin, { now: new Date("2020-02-02T00:00:00Z"), provider: new MockBillingProvider() });
    const [inv] = await pools.admin.select().from(schema.invoices).where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.periodStart, new Date("2020-02-01T00:00:00Z"))));
    const line = (inv!.lines as { kind: string; key: string; amountMinor: number }[]).find((l) => l.kind === "usage");
    expect(line).toMatchObject({ key: "addon.ai_studio" });
    expect(line!.amountMinor).toBeGreaterThan(0);
  });
});
