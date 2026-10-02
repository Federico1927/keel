import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, hullwiseApp, tenantIsolation, tenantPredicate, updatedAt } from "./_common";
import { tenantColumns } from "./_tenant";
import { users } from "./auth";
import { tenants } from "./tenants";

/**
 * Remote MCP server (#21). AI clients connect as one user in one tenant, with an OAuth 2.1 token
 * (authorization code + PKCE, dynamic client registration) or a personal access token. Secrets are
 * stored only as HMAC-SHA256 with a server-side pepper. Token rows are tenant data under RLS, read
 * by hash through the admin connection by the auth layer only (like invitations).
 */

/** OAuth clients registered dynamically (RFC 7591). Platform table: a client is not tied to a tenant until a person consents. */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: id(),
    /** Public identifier handed to the client (`kc_` + random). */
    clientId: text("client_id").notNull().unique(),
    clientName: text("client_name").notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    /** Only public clients with PKCE: `none`. */
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
    clientUri: text("client_uri"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    /** Keyed hash of the registering IP, for the registration rate limit. */
    registrationIpHash: text("registration_ip_hash"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_clients_ip_idx").on(t.registrationIpHash, t.createdAt)],
);

/** Authorization codes: single use, 5 minutes, bound to the user, the tenant picked on the consent screen, the PKCE challenge and the redirect URI. */
export const mcpAuthorizationCodes = pgTable(
  "mcp_authorization_codes",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scopes: text("scopes").array().notNull(),
    /** RFC 8707 resource indicator the client asked for (the MCP endpoint). */
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_authorization_codes_tenant_idx").on(t.tenantId, t.createdAt), tenantIsolation("mcp_authorization_codes")],
).enableRLS();

/**
 * One connection = one row: an OAuth grant (access + refresh token, rotated together on refresh) or
 * a personal access token. Always one user + one tenant. `display_prefix` is what the UI shows.
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    ...tenantColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** oauth | pat */
    kind: text("kind").notNull(),
    clientId: uuid("client_id").references(() => oauthClients.id, { onDelete: "cascade" }),
    /** PAT name given by the person, or the OAuth client's name. */
    name: text("name").notNull(),
    displayPrefix: text("display_prefix").notNull(),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").unique(),
    /** The refresh token replaced by the last rotation: presenting it again revokes the grant (reuse detection). */
    previousRefreshHash: text("previous_refresh_hash"),
    scopes: text("scopes").array().notNull(),
    resource: text("resource"),
    /** When the access token (PAT: the token) stops working. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    /** When the secret was last issued (creation, refresh or PAT rotation). */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("mcp_tokens_user_idx").on(t.tenantId, t.userId, t.createdAt), index("mcp_tokens_prev_refresh_idx").on(t.previousRefreshHash), tenantIsolation("mcp_tokens")],
).enableRLS();

/**
 * Request log: one row per MCP call (tool, user, client, duration, outcome), failed authentication
 * and rate-limited calls included. Never arguments or results (no PII). `tenant_id` is null when the
 * token was unknown. Append-only for the app role.
 */
export const mcpRequestLog = pgTable(
  "mcp_request_log",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    clientName: text("client_name"),
    /** initialize | tools/list | tools/call | auth | other */
    method: text("method").notNull(),
    tool: text("tool"),
    /** ok | error | denied | invalid_input | not_found | rate_limited | auth_failed | disabled */
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("mcp_request_log_tenant_idx").on(t.tenantId, t.createdAt),
    index("mcp_request_log_token_idx").on(t.tokenId, t.createdAt),
    pgPolicy("mcp_request_log_tenant_select", { for: "select", to: hullwiseApp, using: tenantPredicate }),
    pgPolicy("mcp_request_log_tenant_insert", { for: "insert", to: hullwiseApp, withCheck: tenantPredicate }),
  ],
).enableRLS();

/** Fixed one-minute windows for the per-token and per-tenant rate limits (`bucket` = `token:<id>` | `tenant`). */
export const mcpRateBuckets = pgTable(
  "mcp_rate_buckets",
  {
    ...tenantColumns(),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [uniqueIndex("mcp_rate_buckets_uq").on(t.tenantId, t.bucket, t.windowStart), tenantIsolation("mcp_rate_buckets")],
).enableRLS();

/**
 * Risky actions an AI client asked for (cancel an order, refund, pause a campaign, create a purchase
 * order): nothing happens until a person with the permission approves it in Hullwise.
 * `status` = pending | approved | rejected | failed | expired.
 */
export const mcpPendingActions = pgTable(
  "mcp_pending_actions",
  {
    ...tenantColumns(),
    /** order.cancel | order.refund | campaign.pause | purchase_order.create */
    kind: text("kind").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    /** What the inbox shows (order name, campaign name, amounts). */
    summary: jsonb("summary").notNull().default(sql`'{}'::jsonb`),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    /** Why the client proposed it, as written by the model (sanitised, capped). */
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    tokenId: uuid("token_id"),
    clientName: text("client_name"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    result: jsonb("result"),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("mcp_pending_actions_status_idx").on(t.tenantId, t.status, t.createdAt), tenantIsolation("mcp_pending_actions")],
).enableRLS();
