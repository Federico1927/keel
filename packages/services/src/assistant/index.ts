import { and, asc, desc, eq, gte, schema, sql } from "@hullwise/db";
import type { TenantRole } from "@hullwise/config";
import { ASSISTANT_MAX_QUESTION_CHARS, ASSISTANT_MAX_STEPS, AssistantInputError, threadTitle, type AssistantCitation } from "@hullwise/core";
import { LlmError, type LlmBlock, type LlmMessage, type LlmProvider, type LlmStopReason } from "@hullwise/integrations";
import type { ServiceContext } from "../context";
import type { AnalyticsTenant } from "../analytics";
import { ToolError } from "../tools";
import { assistantToolsFor, toolDefinition, type AssistantTool } from "./tools";

export * from "./tools";

/**
 * The AI assistant loop. A question becomes a user turn; the model answers or calls read-only
 * tools; all tool results of a turn go back in one user message; the loop ends on a final answer,
 * a refusal, the output limit or the step cap. Every turn is stored with its token usage.
 *
 * The loop never holds a database transaction across a model call: each read and write runs in
 * its own short tenant transaction through `run`, so a slow model cannot pin a connection.
 */
export type TenantRunner = <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>;

export interface AssistantScope {
  tenant: AnalyticsTenant & { name: string; slug: string };
  userId: string;
  role: TenantRole;
  activeAddons: readonly string[];
  /** The user's interface language; the model answers in the question's language. */
  locale: string;
  now?: Date;
}

export type AssistantOutcome = "answered" | "refused" | "truncated" | "error";

export class AssistantError extends Error {
  constructor(readonly code: "empty_question" | "question_too_long" | "thread_not_found") {
    super(code);
    this.name = "AssistantError";
  }
}

const LANGUAGE_NAMES: Record<string, string> = { en: "English", it: "Italian", es: "Spanish" };

export function assistantSystemPrompt(scope: AssistantScope, tools: readonly AssistantTool[], today: Date): string {
  const t = scope.tenant;
  return [
    `You are the analyst inside Hullwise, the operations platform of the online store "${t.name}". You answer questions from the store's team about their own data.`,
    `Today is ${today.toISOString().slice(0, 10)}. The store's currency is ${t.currency}, its country ${t.country}, its timezone ${t.timezone}.`,
    `Answer in the language of the question; when unsure, in ${LANGUAGE_NAMES[scope.locale] ?? "English"}.`,
    "",
    "How to answer:",
    "- Get every figure from the tools. Never estimate or invent a number; if no tool covers the question, say what you can answer instead.",
    `- Tools take inclusive dates as YYYY-MM-DD. Turn relative periods ("last month", "this year") into dates from today. Without a period, use the last 30 days and say so.`,
    "- When the question needs several figures, call the tools you need in the same turn.",
    "- State the period and any filter behind each figure. Amounts from the tools are already in the store currency, in major units: write them as money.",
    "- Be brief: the answer first, in two to five sentences or a short list, then what it means for the business or what to look at next. The figures you used appear under your answer with links to their pages, so do not paste tables.",
    "- Profit and margin count only orders that were not cancelled or returned. Say so when it matters.",
    "- You can only read data. If asked to change something (pause a campaign, edit an order), explain where in Hullwise to do it.",
    tools.length < 7 ? `- This user's role gives access to: ${tools.map((x) => x.name).join(", ")}. For other topics, say their role does not include that data.` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ---------- usage ---------- */

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface AssistantUsage {
  month: string;
  questions: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Questions and tokens of the tenant this calendar month (UTC). The store pays its model provider
 * directly; the meter lets it see what the assistant costs it.
 */
export async function assistantUsage(ctx: ServiceContext, now = ctx.now ?? new Date()): Promise<AssistantUsage> {
  const from = monthStart(now);
  const [row] = await ctx.tx
    .select({
      input: sql<number>`coalesce(sum(${schema.assistantMessages.inputTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${schema.assistantMessages.outputTokens}), 0)::int`,
      questions: sql<number>`count(*) filter (where ${schema.assistantMessages.role} = 'user' and ${schema.assistantMessages.content} @> '[{"type":"text"}]'::jsonb)::int`,
    })
    .from(schema.assistantMessages)
    .where(and(eq(schema.assistantMessages.tenantId, ctx.tenantId), gte(schema.assistantMessages.createdAt, from)));
  return { month: from.toISOString().slice(0, 7), questions: row?.questions ?? 0, inputTokens: row?.input ?? 0, outputTokens: row?.output ?? 0 };
}

/* ---------- threads ---------- */

export async function listAssistantThreads(ctx: ServiceContext, userId: string, limit = 30) {
  return ctx.tx
    .select({ id: schema.assistantThreads.id, title: schema.assistantThreads.title, updatedAt: schema.assistantThreads.updatedAt, inputTokens: schema.assistantThreads.inputTokens, outputTokens: schema.assistantThreads.outputTokens })
    .from(schema.assistantThreads)
    .where(and(eq(schema.assistantThreads.tenantId, ctx.tenantId), eq(schema.assistantThreads.userId, userId)))
    .orderBy(desc(schema.assistantThreads.updatedAt))
    .limit(limit);
}

export interface AssistantDisplayMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations: AssistantCitation[];
  /** Tools the model called before this answer, in order. */
  tools: string[];
  stopReason: string | null;
  errorCode: string | null;
  createdAt: Date;
}

/**
 * A thread as the user reads it: their questions, and per question one answer that gathers the
 * text of the model's turns, the tools it called and the citations of their results.
 */
export async function assistantThread(ctx: ServiceContext, userId: string, threadId: string): Promise<{ id: string; title: string; messages: AssistantDisplayMessage[] } | null> {
  const [thread] = await ctx.tx.select().from(schema.assistantThreads).where(and(eq(schema.assistantThreads.tenantId, ctx.tenantId), eq(schema.assistantThreads.id, threadId), eq(schema.assistantThreads.userId, userId))).limit(1);
  if (!thread) return null;
  const rows = await ctx.tx.select().from(schema.assistantMessages).where(eq(schema.assistantMessages.threadId, threadId)).orderBy(asc(schema.assistantMessages.seq));
  const out: AssistantDisplayMessage[] = [];
  let answer: AssistantDisplayMessage | null = null;
  for (const r of rows) {
    const blocks = r.content as LlmBlock[];
    const text = blocks.filter((b): b is Extract<LlmBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n\n").trim();
    if (r.role === "user") {
      if (!blocks.some((b) => b.type === "text")) continue; // tool results
      answer = null;
      out.push({ id: r.id, role: "user", text, citations: [], tools: [], stopReason: null, errorCode: null, createdAt: r.createdAt });
      continue;
    }
    if (!answer) {
      answer = { id: r.id, role: "assistant", text: "", citations: [], tools: [], stopReason: null, errorCode: null, createdAt: r.createdAt };
      out.push(answer);
    }
    if (text) answer.text = answer.text ? `${answer.text}\n\n${text}` : text;
    answer.tools.push(...blocks.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name));
    answer.citations.push(...(r.citations as AssistantCitation[]));
    answer.stopReason = r.stopReason;
    answer.errorCode = r.errorCode;
  }
  return { id: thread.id, title: thread.title, messages: out };
}

export async function deleteAssistantThread(ctx: ServiceContext, userId: string, threadId: string): Promise<boolean> {
  const r = await ctx.tx.delete(schema.assistantThreads).where(and(eq(schema.assistantThreads.tenantId, ctx.tenantId), eq(schema.assistantThreads.id, threadId), eq(schema.assistantThreads.userId, userId))).returning({ id: schema.assistantThreads.id });
  return r.length > 0;
}

/* ---------- the loop ---------- */

interface StoredTurn {
  role: "user" | "assistant";
  content: LlmBlock[];
  providerContent?: unknown[] | null;
  citations?: AssistantCitation[];
  stopReason?: string | null;
  provider?: string | null;
  model?: string | null;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  errorCode?: string | null;
}

async function appendTurn(ctx: ServiceContext, threadId: string, turn: StoredTurn): Promise<string> {
  const [{ next }] = (await ctx.tx.select({ next: sql<number>`coalesce(max(${schema.assistantMessages.seq}), 0)::int + 1` }).from(schema.assistantMessages).where(eq(schema.assistantMessages.threadId, threadId))) as [{ next: number }];
  const [row] = await ctx.tx
    .insert(schema.assistantMessages)
    .values({
      tenantId: ctx.tenantId,
      threadId,
      seq: next,
      role: turn.role,
      content: turn.content,
      providerContent: turn.providerContent ?? null,
      citations: turn.citations ?? [],
      stopReason: turn.stopReason ?? null,
      provider: turn.provider ?? null,
      model: turn.model ?? null,
      inputTokens: turn.usage?.inputTokens ?? 0,
      outputTokens: turn.usage?.outputTokens ?? 0,
      cacheReadTokens: turn.usage?.cacheReadTokens ?? 0,
      errorCode: turn.errorCode ?? null,
    })
    .returning({ id: schema.assistantMessages.id });
  await ctx.tx
    .update(schema.assistantThreads)
    .set({ updatedAt: new Date(), inputTokens: sql`${schema.assistantThreads.inputTokens} + ${turn.usage?.inputTokens ?? 0}`, outputTokens: sql`${schema.assistantThreads.outputTokens} + ${turn.usage?.outputTokens ?? 0}` })
    .where(eq(schema.assistantThreads.id, threadId));
  return row!.id;
}

async function history(ctx: ServiceContext, threadId: string): Promise<LlmMessage[]> {
  const rows = await ctx.tx.select({ role: schema.assistantMessages.role, content: schema.assistantMessages.content, providerContent: schema.assistantMessages.providerContent, stopReason: schema.assistantMessages.stopReason }).from(schema.assistantMessages).where(eq(schema.assistantMessages.threadId, threadId)).orderBy(asc(schema.assistantMessages.seq));
  const out: LlmMessage[] = [];
  for (const r of rows) {
    // failed or refused turns are not part of the conversation the model sees
    if (r.role === "assistant" && (r.stopReason === "error" || r.stopReason === "refusal")) {
      if (out.at(-1)?.role === "user") out.pop();
      continue;
    }
    const m: LlmMessage = { role: r.role as "user" | "assistant", content: r.content as LlmBlock[], providerContent: (r.providerContent as unknown[] | null) ?? null };
    if (m.role === "assistant" && m.content.length === 0 && !m.providerContent?.length) continue;
    out.push(m);
  }
  return repairHistory(out);
}

/**
 * Keeps the history valid for the API: every tool call gets a result (a call left unanswered by
 * the step cap or an error gets an error result), and consecutive user turns are merged, tool
 * results first.
 */
export function repairHistory(messages: readonly LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  messages.forEach((m, i) => {
    out.push({ ...m, content: [...m.content] });
    if (m.role !== "assistant") return;
    const calls = m.content.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
    const next = messages[i + 1];
    const answered = new Set(next?.role === "user" ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : [])) : []);
    const missing = calls.filter((c) => !answered.has(c.id));
    if (missing.length) out.push({ role: "user", content: missing.map((c) => ({ type: "tool_result" as const, toolUseId: c.id, content: "Not run: the previous answer was interrupted.", isError: true })) });
  });
  const merged: LlmMessage[] = [];
  for (const m of out) {
    const last = merged.at(-1);
    if (last && last.role === "user" && m.role === "user") {
      const blocks = [...last.content, ...m.content];
      last.content = [...blocks.filter((b) => b.type === "tool_result"), ...blocks.filter((b) => b.type !== "tool_result")];
    } else merged.push(m);
  }
  return merged;
}

export interface AskResult {
  threadId: string;
  outcome: AssistantOutcome;
  errorCode?: string;
  steps: number;
}

/** Runs the tools of one model turn, all of them, and returns their results in one user message. */
async function runTools(run: TenantRunner, scope: AssistantScope, tools: readonly AssistantTool[], calls: Extract<LlmBlock, { type: "tool_use" }>[], today: Date): Promise<{ results: LlmBlock[]; citations: AssistantCitation[] }> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const settled = await Promise.all(
    calls.map(async (call): Promise<{ block: LlmBlock; citation?: AssistantCitation }> => {
      const tool = byName.get(call.name);
      if (!tool) return { block: { type: "tool_result", toolUseId: call.id, content: `Unknown tool ${call.name}, or not available to this user's role.`, isError: true } };
      const parsed = tool.input.safeParse(call.input ?? {});
      if (!parsed.success) return { block: { type: "tool_result", toolUseId: call.id, content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true } };
      try {
        const r = await run((ctx) => tool.run({ ctx, tenant: scope.tenant, slug: scope.tenant.slug, today, userId: scope.userId, role: scope.role, activeAddons: scope.activeAddons }, parsed.data));
        return { block: { type: "tool_result", toolUseId: call.id, content: JSON.stringify(r.data) }, citation: r.citation };
      } catch (err) {
        if (err instanceof AssistantInputError) return { block: { type: "tool_result", toolUseId: call.id, content: `Invalid input: ${err.message}`, isError: true } };
        if (err instanceof ToolError) return { block: { type: "tool_result", toolUseId: call.id, content: `${err.code === "not_found" ? "Not found" : "Invalid input"}: ${err.message}`, isError: true } };
        console.error(`[assistant] tool ${call.name} failed`, err);
        return { block: { type: "tool_result", toolUseId: call.id, content: "The tool failed on the server. Tell the user this figure is unavailable right now.", isError: true } };
      }
    }),
  );
  return { results: settled.map((s) => s.block), citations: settled.flatMap((s) => (s.citation ? [s.citation] : [])) };
}

export async function askAssistant(run: TenantRunner, scope: AssistantScope, llm: LlmProvider, input: { threadId?: string | null; question: string }): Promise<AskResult> {
  const question = input.question.trim();
  if (!question) throw new AssistantError("empty_question");
  if (question.length > ASSISTANT_MAX_QUESTION_CHARS) throw new AssistantError("question_too_long");
  const now = scope.now ?? new Date();

  const tools = assistantToolsFor(scope.role, scope.activeAddons);
  const definitions = tools.map(toolDefinition);
  const system = assistantSystemPrompt(scope, tools, now);

  const threadId = await run(async (ctx) => {
    if (input.threadId) {
      const [t] = await ctx.tx.select({ id: schema.assistantThreads.id }).from(schema.assistantThreads).where(and(eq(schema.assistantThreads.tenantId, ctx.tenantId), eq(schema.assistantThreads.id, input.threadId), eq(schema.assistantThreads.userId, scope.userId))).limit(1);
      if (!t) throw new AssistantError("thread_not_found");
      await appendTurn(ctx, t.id, { role: "user", content: [{ type: "text", text: question }] });
      return t.id;
    }
    const [t] = await ctx.tx.insert(schema.assistantThreads).values({ tenantId: ctx.tenantId, userId: scope.userId, title: threadTitle(question) }).returning({ id: schema.assistantThreads.id });
    await appendTurn(ctx, t!.id, { role: "user", content: [{ type: "text", text: question }] });
    return t!.id;
  });

  const messages = await run((ctx) => history(ctx, threadId));
  let citations: AssistantCitation[] = [];
  for (let step = 1; step <= ASSISTANT_MAX_STEPS; step++) {
    let turn;
    try {
      turn = await llm.complete({ system, messages: [...messages], tools: definitions });
    } catch (err) {
      const code = err instanceof LlmError ? err.code : "unknown";
      console.error("[assistant] model call failed", err);
      await run((ctx) => appendTurn(ctx, threadId, { role: "assistant", content: [], stopReason: "error", provider: llm.provider, model: llm.model, errorCode: code }));
      return { threadId, outcome: "error", errorCode: code, steps: step };
    }
    const stop: LlmStopReason = turn.stopReason;
    const calls = turn.content.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
    const final = stop !== "tool_use" || calls.length === 0 || step === ASSISTANT_MAX_STEPS;
    await run((ctx) => appendTurn(ctx, threadId, { role: "assistant", content: turn.content, providerContent: turn.providerContent, citations: final ? citations : [], stopReason: stop, provider: llm.provider, model: turn.model, usage: turn.usage }));
    messages.push({ role: "assistant", content: turn.content, providerContent: turn.providerContent });
    if (stop === "refusal") return { threadId, outcome: "refused", steps: step };
    if (stop === "max_tokens") return { threadId, outcome: "truncated", steps: step };
    if (stop === "pause_turn") continue;
    if (stop !== "tool_use" || calls.length === 0) return { threadId, outcome: "answered", steps: step };
    if (step === ASSISTANT_MAX_STEPS) break;
    const { results, citations: found } = await runTools(run, scope, tools, calls, now);
    citations = [...citations, ...found];
    await run((ctx) => appendTurn(ctx, threadId, { role: "user", content: results }));
    messages.push({ role: "user", content: results });
  }
  return { threadId, outcome: "truncated", steps: ASSISTANT_MAX_STEPS };
}

