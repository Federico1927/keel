import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tenantIsolation, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";

/** A conversation with the AI assistant; private to the user who started it. */
export const assistantThreads = pgTable(
  "assistant_threads",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Running totals of the thread, for the usage meter and usage billing. */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("assistant_threads_user_idx").on(t.tenantId, t.userId, t.updatedAt), tenantIsolation("assistant_threads")],
).enableRLS();

/**
 * One turn of a thread. `content` holds provider-neutral blocks (text, tool_use, tool_result);
 * `provider_content` keeps the model's own blocks (thinking included) to send back verbatim.
 * Citations are the figures the tools returned, rendered under the answer with their links.
 */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    ...tenantColumns(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => assistantThreads.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** user | assistant */
    role: text("role").notNull(),
    content: jsonb("content").notNull().default(sql`'[]'::jsonb`),
    providerContent: jsonb("provider_content"),
    citations: jsonb("citations").notNull().default(sql`'[]'::jsonb`),
    /** end_turn | tool_use | max_tokens | refusal | pause_turn | other | error; null on user turns */
    stopReason: text("stop_reason"),
    /** mock | anthropic */
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("assistant_messages_seq_uq").on(t.threadId, t.seq), index("assistant_messages_usage_idx").on(t.tenantId, t.createdAt), tenantIsolation("assistant_messages")],
).enableRLS();

