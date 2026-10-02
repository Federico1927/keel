import { boolean, customType, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_common";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Platform users: a user can belong to several tenants (see tenant_memberships). */
export const users = pgTable(
  "users",
  {
    id: id(),
    name: text("name"),
    email: text("email").notNull().unique(),
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    image: text("image"),
    passwordHash: text("password_hash"),
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    /** Preferred UI locale; null → tenant default. */
    locale: text("locale"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Profile (#45): the name to greet the person by, job title, own time zone (null → tenant's). */
    preferredName: text("preferred_name"),
    jobTitle: text("job_title"),
    timeZone: text("time_zone"),
    /** `light` | `dark` | `system`; null → system. */
    theme: text("theme"),
    /** `comfortable` | `compact`; null → comfortable. */
    density: text("density"),
    /** Profile photo, resized server side (WebP, ≤ 256px). Never selected by list queries. */
    avatarData: bytea("avatar_data"),
    avatarContentType: text("avatar_content_type"),
    avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
    /** Bumped by "sign out of other sessions" and password changes: older JWTs stop working. */
    sessionVersion: integer("session_version").notNull().default(0),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    /** #52: email the person when someone signs in from a device or browser not seen before (toggle on the profile). */
    notifyNewSignIn: boolean("notify_new_sign_in").notNull().default(true),
    /** #52: when the person accepted the privacy policy (first access from an invitation). */
    privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true }),
    /** #48: platform-wide disable by a super-admin (no sign-in at all while set). */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    disabledBy: uuid("disabled_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("users_email_idx").on(t.email)],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/** Recent sign-ins shown on the profile. Platform table (no tenant): read only for the signed-in user. */
export const userSignIns = pgTable(
  "user_sign_ins",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `credentials` | `email` (magic link) */
    method: text("method").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("user_sign_ins_user_idx").on(t.userId, t.createdAt)],
);

/**
 * Forgotten-password requests (#52). Platform table (no tenant). Every request is a row, also for
 * addresses without an active account (user null, no token), so the per-email and per-IP rate
 * limits count them alike. Email and IP are keyed hashes; the token is stored as its SHA-256, works
 * once, expires, and is invalidated by a newer request or a successful reset.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    ipHash: text("ip_hash"),
    tokenHash: text("token_hash").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    /** Set when a super-admin sent the reset from the console. */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("password_resets_email_idx").on(t.emailHash, t.createdAt), index("password_resets_ip_idx").on(t.ipHash, t.createdAt), index("password_resets_user_idx").on(t.userId)],
);
