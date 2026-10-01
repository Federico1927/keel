import { AI_STUDIO_PRICING } from "@keel/config";
import type { Period } from "./finance";

/**
 * Pure rules of the AI assistant (add-on `addon.ai_studio`): the period a tool reads, the
 * citations attached to an answer, the monthly token budget and the usage charge.
 */

export const ASSISTANT_DEFAULT_DAYS = 30;
export const ASSISTANT_MAX_DAYS = 400;
/** Model turns per question: enough for a couple of tool rounds, bounded so a loop cannot run away. */
export const ASSISTANT_MAX_STEPS = 6;
export const ASSISTANT_MAX_QUESTION_CHARS = 2000;

export type CitationFormat = "money" | "number" | "percent" | "ratio" | "days" | "text";

export interface CitationFigure {
  /** i18n key under `assistant.figures`. */
  key: string;
  value: number | string | null;
  format: CitationFormat;
  /** Change against the previous period of the same length, as a fraction (0.08 = +8%). */
  change?: number | null;
}

export interface CitationRow {
  label: string;
  href?: string | null;
  figures: CitationFigure[];
}

/** What a tool returned, as the user sees it under the answer: the figures, their period and filters, and where they come from. */
export interface AssistantCitation {
  tool: string;
  period: { from: string; to: string } | null;
  filters: Record<string, string>;
  figures: CitationFigure[];
  rows: CitationRow[];
  href: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AssistantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantInputError";
  }
}

/**
 * The half-open period a tool reads, from inclusive ISO days. Missing bounds default to the last
 * 30 days ending today; an inverted, malformed or too long range is an input error the model sees
 * and can correct.
 */
export function assistantPeriod(input: { from?: string | null; to?: string | null }, today: Date): Period & { fromDay: string; toDay: string } {
  const todayDay = today.toISOString().slice(0, 10);
  const toDay = input.to ?? todayDay;
  if (!ISO_DAY.test(toDay) || Number.isNaN(Date.parse(toDay))) throw new AssistantInputError(`"to" must be a date as YYYY-MM-DD, got ${String(input.to)}`);
  const to = new Date(`${toDay}T00:00:00Z`);
  const fromDay = input.from ?? new Date(to.getTime() - (ASSISTANT_DEFAULT_DAYS - 1) * 864e5).toISOString().slice(0, 10);
  if (!ISO_DAY.test(fromDay) || Number.isNaN(Date.parse(fromDay))) throw new AssistantInputError(`"from" must be a date as YYYY-MM-DD, got ${String(input.from)}`);
  const from = new Date(`${fromDay}T00:00:00Z`);
  if (from > to) throw new AssistantInputError(`"from" (${fromDay}) is after "to" (${toDay})`);
  const days = Math.round((to.getTime() - from.getTime()) / 864e5) + 1;
  if (days > ASSISTANT_MAX_DAYS) throw new AssistantInputError(`the period is ${days} days; the maximum is ${ASSISTANT_MAX_DAYS}`);
  return { from, to: new Date(to.getTime() + 864e5), fromDay, toDay };
}

/** Thread title from the first question: one line, at most 80 characters. */
export function threadTitle(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}

export interface TokenBudget {
  usedTokens: number;
  budgetTokens: number;
  remainingTokens: number;
  usedShare: number;
  exceeded: boolean;
}

export function tokenBudget(usedTokens: number, budgetTokens: number = AI_STUDIO_PRICING.defaultMonthlyTokenBudget): TokenBudget {
  const used = Math.max(0, usedTokens);
  return { usedTokens: used, budgetTokens, remainingTokens: Math.max(0, budgetTokens - used), usedShare: budgetTokens > 0 ? used / budgetTokens : 1, exceeded: used >= budgetTokens };
}

export interface UsageCharge {
  inputTokens: number;
  outputTokens: number;
  includedTokens: number;
  billableInputTokens: number;
  billableOutputTokens: number;
  amountMinor: number;
}

/**
 * Charge for a month of tokens. The included allowance is consumed in proportion across input and
 * output, so the split of what remains billable matches the split of what was used.
 */
export function aiUsageCharge(usage: { inputTokens: number; outputTokens: number }, pricing: { inputPerMillionMinor: number; outputPerMillionMinor: number; includedTokens: number } = AI_STUDIO_PRICING): UsageCharge {
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const total = input + output;
  const billableShare = total > 0 ? Math.max(0, total - pricing.includedTokens) / total : 0;
  const billableInputTokens = Math.round(input * billableShare);
  const billableOutputTokens = Math.round(output * billableShare);
  const amountMinor = Math.round((billableInputTokens * pricing.inputPerMillionMinor + billableOutputTokens * pricing.outputPerMillionMinor) / 1_000_000);
  return { inputTokens: input, outputTokens: output, includedTokens: Math.min(total, pricing.includedTokens), billableInputTokens, billableOutputTokens, amountMinor };
}
