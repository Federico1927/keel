import { describe, expect, it } from "vitest";
import { AnthropicLlmProvider, LlmError, MockLlmProvider, detectLanguage, type LlmMessage } from "./llm";

/** A Messages API response as recorded: adaptive thinking, a sentence, then a tool call. */
const TOOL_TURN = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "thinking", thinking: "The user asks about revenue; call get_kpis.", signature: "sig-abc" },
    { type: "text", text: "Let me look at your KPIs." },
    { type: "tool_use", id: "toolu_01", name: "get_kpis", input: { from: "2026-09-01", to: "2026-09-30" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
};

const FINAL_TURN = {
  ...TOOL_TURN,
  id: "msg_02",
  content: [{ type: "text", text: "Net revenue was €120,000, up 8% on August." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1500, output_tokens: 40, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0 },
};

function recorder(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const tools = [{ name: "get_kpis", description: "KPIs for a period", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } }];

describe("Anthropic LLM provider (recorded responses)", () => {
  it("sends the request the assistant needs and maps the reply", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: TOOL_TURN }, { status: 200, body: FINAL_TURN }]);
    const llm = new AnthropicLlmProvider({ apiKey: "test-key", fetch: fetchImpl, maxRetries: 0 });
    const question: LlmMessage = { role: "user", content: [{ type: "text", text: "How did revenue go in September?" }] };
    const first = await llm.complete({ system: "You are Keel's analyst.", messages: [question], tools });
    const req = calls[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.headers.get("x-api-key")).toBe("test-key");
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    expect(req.body.system).toEqual([{ type: "text", text: "You are Keel's analyst.", cache_control: { type: "ephemeral" } }]);
    expect(req.body.tools).toEqual([{ name: "get_kpis", description: "KPIs for a period", input_schema: tools[0]!.inputSchema }]);
    expect(first.stopReason).toBe("tool_use");
    expect(first.content).toEqual([
      { type: "text", text: "Let me look at your KPIs." },
      { type: "tool_use", id: "toolu_01", name: "get_kpis", input: { from: "2026-09-01", to: "2026-09-30" } },
    ]);
    expect(first.usage).toEqual({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 0 });

    // the next request carries the assistant turn verbatim (thinking and signature) and every tool result in one user message
    const history: LlmMessage[] = [question, { role: "assistant", content: first.content, providerContent: first.providerContent }, { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_01", content: "{\"netRevenueMinor\":12000000}" }] }];
    const second = await llm.complete({ system: "You are Keel's analyst.", messages: history, tools });
    const sent = calls[1]!.body.messages as { role: string; content: { type: string; signature?: string; tool_use_id?: string; is_error?: boolean }[] }[];
    expect(sent[1]!.content[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
    expect(sent[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_01", content: "{\"netRevenueMinor\":12000000}", is_error: false }]);
    expect(second.stopReason).toBe("end_turn");
    expect(second.content).toEqual([{ type: "text", text: "Net revenue was €120,000, up 8% on August." }]);
  });

  it("a refusal never hands a half-written tool call to the loop", async () => {
    const refusal = { ...TOOL_TURN, stop_reason: "refusal", content: [{ type: "tool_use", id: "toolu_x", name: "get_kpis", input: {} }] };
    const { fetchImpl } = recorder([{ status: 200, body: refusal }]);
    const turn = await new AnthropicLlmProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 }).complete({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], tools });
    expect(turn.stopReason).toBe("refusal");
    expect(turn.content).toEqual([]);
  });

  it("maps API errors to stable codes", async () => {
    const err = (status: number, type: string) => ({ status, body: { type: "error", error: { type, message: `${type} detail` } } });
    for (const [status, type, code] of [[401, "authentication_error", "auth"], [429, "rate_limit_error", "rate_limited"], [529, "overloaded_error", "overloaded"], [400, "invalid_request_error", "bad_request"]] as const) {
      const { fetchImpl } = recorder([err(status, type)]);
      const llm = new AnthropicLlmProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
      const p = llm.complete({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], tools });
      await expect(p).rejects.toBeInstanceOf(LlmError);
      await expect(p).rejects.toMatchObject({ code });
    }
  });
});

describe("Anthropic connection test", () => {
  it("checks the key by reading the model, without spending tokens", async () => {
    const { calls, fetchImpl } = recorder([{ status: 200, body: { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-08-01T00:00:00Z" } }]);
    const r = await new AnthropicLlmProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 }).testConnection();
    expect(r).toEqual({ ok: true, accountName: "Claude Opus 5.5", accountId: "claude-opus-5-5" });
    expect(calls[0]!.url).toContain("/v1/models/claude-opus-5-5");
  });

  it("reports an invalid key readably", async () => {
    const { fetchImpl } = recorder([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
    const r = await new AnthropicLlmProvider({ apiKey: "bad", fetch: fetchImpl, maxRetries: 0 }).testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^auth: .*invalid x-api-key/);
  });
});

describe("mock LLM provider", () => {
  const today = new Date("2026-10-01T10:00:00Z");
  const allTools = ["get_kpis", "get_profit_and_loss", "get_top_products", "get_campaigns", "get_returns_summary", "get_customer_predictions", "get_stock_risk"].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));

  it("calls the matching tools with the period of the question, then answers in its language", async () => {
    const llm = new MockLlmProvider({ today });
    const q: LlmMessage = { role: "user", content: [{ type: "text", text: "Come sono andati i ricavi e il profitto negli ultimi 7 giorni?" }] };
    const first = await llm.complete({ system: "s", messages: [q], tools: allTools });
    expect(first.stopReason).toBe("tool_use");
    const calls = first.content.filter((b) => b.type === "tool_use");
    expect(calls.map((c) => c.name)).toEqual(["get_kpis", "get_profit_and_loss"]);
    expect(calls[0]!.input).toEqual({ from: "2026-09-25", to: "2026-10-01" });
    const results: LlmMessage = { role: "user", content: calls.map((c) => ({ type: "tool_result" as const, toolUseId: c.id, content: "{}" })) };
    const second = await llm.complete({ system: "s", messages: [q, { role: "assistant", content: first.content }, results], tools: allTools });
    expect(second.stopReason).toBe("end_turn");
    expect(second.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Ho consultato 2 fonti") });
  });

  it("only uses the tools it was given, and explains what it can do otherwise", async () => {
    const llm = new MockLlmProvider({ today });
    const q: LlmMessage = { role: "user", content: [{ type: "text", text: "Which campaigns should I pause?" }] };
    const r = await llm.complete({ system: "s", messages: [q], tools: allTools.filter((t) => t.name !== "get_campaigns" && t.name !== "get_kpis") });
    expect(r.stopReason).toBe("end_turn");
    expect(r.content[0]).toMatchObject({ type: "text" });
  });

  it("detects the question's language", () => {
    expect(detectLanguage("Quali prodotti sono a rischio?")).toBe("it");
    expect(detectLanguage("¿Cuáles son los productos más vendidos?")).toBe("es");
    expect(detectLanguage("What sold best last month?")).toBe("en");
  });
});
