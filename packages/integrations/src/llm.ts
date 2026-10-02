import Anthropic from "@anthropic-ai/sdk";
import type { ConnectionTest } from "./types";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * Language model behind the AI assistant. Each store connects its own Anthropic API key in
 * Integrations (provider `anthropic`), so the store pays the model provider directly. The
 * assistant loop in the services package talks to this provider-neutral interface; the Anthropic
 * adapter maps it to the Messages API through the official SDK, the mock answers deterministically
 * from the tool results so tests, the demo and every development process run without a network call.
 */
export const LLM_PROVIDERS = ["anthropic", "mock"] as const;
export type LlmProviderKey = (typeof LLM_PROVIDERS)[number];

export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmBlock[];
  /**
   * The provider's own content for an assistant turn, sent back verbatim on the next request.
   * It keeps what the neutral blocks drop (thinking blocks and their signatures), which the API
   * needs to continue a tool loop. Null for turns written by another provider.
   */
  providerContent?: unknown[] | null;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool input (type "object"). */
  inputSchema: Record<string, unknown>;
}

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "other";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmTurn {
  content: LlmBlock[];
  providerContent: unknown[] | null;
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** The model that actually answered (a server-side fallback can serve a declined request on another model). */
  model: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTokens?: number;
}

export interface LlmProvider {
  readonly provider: LlmProviderKey;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmTurn>;
  /** Checks the key without spending tokens (reads the configured model's details). */
  testConnection(): Promise<ConnectionTest>;
}

/** Credentials stored (encrypted) on the tenant's `anthropic` integration row. */
export interface AnthropicCredentials {
  apiKey: string;
}

/** A readable, stable error code for the UI; the message keeps the provider's detail for the logs. */
export class LlmError extends Error {
  constructor(
    readonly code: "auth" | "rate_limited" | "overloaded" | "bad_request" | "network" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/* ---------- Anthropic ---------- */

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests to replay recorded responses; the global fetch otherwise. */
  fetch?: typeof fetch;
  baseURL?: string;
  maxRetries?: number;
}

function toAnthropicContent(m: LlmMessage): BetaContentBlockParam[] {
  return m.content.map((b): BetaContentBlockParam => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> };
    return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
  });
}

export function toAnthropicMessages(messages: readonly LlmMessage[]): BetaMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    // the assistant's own blocks go back exactly as received, thinking included
    content: m.role === "assistant" && m.providerContent?.length ? (m.providerContent as BetaContentBlockParam[]) : toAnthropicContent(m),
  }));
}

function stopReasonOf(r: BetaMessage["stop_reason"]): LlmStopReason {
  if (r === "end_turn" || r === "stop_sequence") return "end_turn";
  if (r === "tool_use" || r === "max_tokens" || r === "refusal" || r === "pause_turn") return r;
  return "other";
}

export function fromAnthropicMessage(msg: BetaMessage): LlmTurn {
  const stopReason = stopReasonOf(msg.stop_reason);
  const content: LlmBlock[] = [];
  for (const b of msg.content) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    // a refusal can cut a tool call off mid-input: never hand it to the loop
    else if (b.type === "tool_use" && stopReason !== "refusal") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
  }
  return {
    content,
    providerContent: msg.content as unknown[],
    stopReason,
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
    model: msg.model,
  };
}

function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 401 || status === 403) return new LlmError("auth", err.message);
    if (status === 429) return new LlmError("rate_limited", err.message);
    if (status === 529 || status >= 500) return new LlmError("overloaded", err.message);
    if (status === 400 || status === 404 || status === 413) return new LlmError("bad_request", err.message);
    if (err instanceof Anthropic.APIConnectionError) return new LlmError("network", err.message);
    return new LlmError("unknown", err.message);
  }
  return new LlmError("unknown", err instanceof Error ? err.message : String(err));
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicLlmOptions) {
    this.model = opts.model ?? DEFAULT_LLM_MODEL;
    this.client = new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, baseURL: opts.baseURL, maxRetries: opts.maxRetries ?? 2 });
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const m = await this.client.models.retrieve(this.model);
      return { ok: true, accountName: m.display_name, accountId: m.id };
    } catch (err) {
      const e = mapAnthropicError(err);
      return { ok: false, error: `${e.code}: ${e.message}` };
    }
  }

  async complete(req: LlmRequest): Promise<LlmTurn> {
    const tools: BetaToolUnion[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as { type: "object"; properties?: Record<string, unknown>; required?: string[] } }));
    try {
      const msg = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 8000,
        // the system prompt and the tool list are identical across the turns of a thread: cache them
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: toAnthropicMessages(req.messages),
        tools,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        // a declined request is retried server-side on the recommended fallback model
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      return fromAnthropicMessage(msg);
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }
}

/* ---------- Mock ---------- */

type Lang = "en" | "it" | "es";

const MOCK_TEXT: Record<Lang, { intro: (n: number) => string; none: string }> = {
  en: { intro: (n) => `I checked ${n} source${n === 1 ? "" : "s"} in your store data. The figures are below, each with the period and a link to the page it comes from.`, none: "I can answer questions on sales, profit, products, campaigns, returns, customers at risk and stock. Try: \"How did revenue go in the last 30 days?\"" },
  it: { intro: (n) => `Ho consultato ${n} ${n === 1 ? "fonte" : "fonti"} nei dati del negozio. I numeri sono qui sotto, ciascuno con il periodo e il link alla pagina da cui viene.`, none: "Posso rispondere su vendite, profitto, prodotti, campagne, resi, clienti a rischio e magazzino. Prova: \"Come sono andati i ricavi negli ultimi 30 giorni?\"" },
  es: { intro: (n) => `He consultado ${n} ${n === 1 ? "fuente" : "fuentes"} en los datos de la tienda. Las cifras están abajo, cada una con el periodo y el enlace a la página de origen.`, none: "Puedo responder sobre ventas, beneficio, productos, campañas, devoluciones, clientes en riesgo y stock. Prueba: \"¿Cómo fueron los ingresos en los últimos 30 días?\"" },
};

/** Keywords (en, it, es) that make the mock call a tool; the real model chooses on its own. */
const MOCK_ROUTES: { tool: string; words: RegExp }[] = [
  { tool: "get_kpis", words: /revenue|sales|\borders\b|aov|ricav|vendite|\bordini\b|fatturat|ingres|ventas|pedidos|kpi|andat|went|fueron/i },
  { tool: "get_profit_and_loss", words: /profit|margin|p\/?l|contribution|profitt|margin|utile|beneficio|ganancia|guadagn/i },
  { tool: "get_top_products", words: /product|best.?sell|prodott|più vendut|producto|más vendid/i },
  { tool: "get_campaigns", words: /campaign|ads?\b|roas|spend|campagn|spesa|campaña|gasto|meta|google|tiktok/i },
  { tool: "get_returns_summary", words: /return|refund|\bres[oi]\b|rimbors|\brend(ono|ere|e)\b|devoluci|devuelv|reembols/i },
  { tool: "get_customer_predictions", words: /churn|at risk|customer|abbandon|a rischio|client|riesgo/i },
  { tool: "get_stock_risk", words: /stock|inventory|out of stock|reorder|magazzin|esaur|riordin|inventario|agotad|reabastec/i },
];

const MOCK_PERIODS: { days: number; words: RegExp }[] = [
  { days: 7, words: /\b7 (days|giorni|días)\b|\blast week\b|\bsettiman[ae]\b|\bsemana\b/i },
  { days: 90, words: /\b90 (days|giorni|días)\b|\bquarter\b|\btrimestr[eio]\b|\b3 (months|mesi|meses)\b/i },
  { days: 365, words: /\b(year|anno|año)\b|\b12 (months|mesi|meses)\b/i },
];

export function detectLanguage(text: string): Lang {
  if (/\b(come|sono|quali|quanto|ultimi|negli|del|della|perché|ricavi|giorni)\b/i.test(text)) return "it";
  if (/\b(cómo|cuál|cuánto|últimos|los|las|qué|ingresos|días)\b/i.test(text)) return "es";
  return "en";
}

/**
 * Deterministic stand-in for the model: on a question it calls the tools whose keywords match
 * (KPIs when none do), with a period read from the question; on tool results it answers with one
 * sentence in the question's language. The figures themselves reach the user through citations.
 */
export class MockLlmProvider implements LlmProvider {
  readonly provider = "mock" as const;
  readonly model = "mock-assistant";
  readonly requests: LlmRequest[] = [];
  private seq = 0;

  constructor(private readonly opts: { refuseWhen?: RegExp; today?: Date } = {}) {}

  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, accountName: "Mock model", accountId: this.model };
  }

  async complete(req: LlmRequest): Promise<LlmTurn> {
    this.requests.push(req);
    const last = req.messages.at(-1);
    const question = [...req.messages].reverse().find((m) => m.role === "user" && m.content.some((b) => b.type === "text"));
    const text = question?.content.map((b) => (b.type === "text" ? b.text : "")).join(" ") ?? "";
    const lang = detectLanguage(text);
    const usage: LlmUsage = { inputTokens: Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4), outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const turn = (content: LlmBlock[], stopReason: LlmStopReason): LlmTurn => {
      usage.outputTokens = Math.ceil(JSON.stringify(content).length / 4);
      return { content, providerContent: null, stopReason, usage, model: this.model };
    };
    if (this.opts.refuseWhen?.test(text)) return turn([], "refusal");
    const answered = last?.content.filter((b) => b.type === "tool_result") ?? [];
    if (answered.length) return turn([{ type: "text", text: MOCK_TEXT[lang].intro(answered.filter((b) => b.type === "tool_result" && !b.isError).length) }], "end_turn");
    const available = new Set(req.tools.map((t) => t.name));
    let tools = MOCK_ROUTES.filter((r) => available.has(r.tool) && r.words.test(text)).map((r) => r.tool);
    if (!tools.length && /\?|how|what|come|quant|cómo|cuánt/i.test(text) && available.has("get_kpis")) tools = ["get_kpis"];
    if (!tools.length) return turn([{ type: "text", text: MOCK_TEXT[lang].none }], "end_turn");
    const days = MOCK_PERIODS.find((p) => p.words.test(text))?.days ?? 30;
    const today = this.opts.today ?? new Date();
    const to = today.toISOString().slice(0, 10);
    const from = new Date(today.getTime() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const input = (tool: string): Record<string, unknown> => {
      if (tool === "get_customer_predictions" || tool === "get_stock_risk") return { limit: 5 };
      if (tool === "get_top_products") return { from, to, limit: 5 };
      return { from, to };
    };
    return turn(tools.slice(0, 3).map((name) => ({ type: "tool_use" as const, id: `mock_tool_${++this.seq}`, name, input: input(name) })), "tool_use");
  }
}

