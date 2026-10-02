import bcrypt from "bcryptjs";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Demo super-admins: they sign in with the public demo password, so they never keep the console next to a real owner. */
export const DEMO_SUPER_ADMINS = ["superadmin@hullwise.demo", "superadmin@keel.demo"] as const;
export const OWNER_PASSWORD_MIN_LENGTH = 12;

export interface PlatformOwnerReport {
  owner: "created" | "promoted" | "unchanged" | "not_configured" | "missing_password";
  /** Demo super-admins that lost the console in this run. */
  demoted: string[];
}

/**
 * The platform owner's own super-admin (`HULLWISE_OWNER_EMAIL`, `HULLWISE_OWNER_PASSWORD`), run by `db:deploy`.
 * The password is used only to create the account: afterwards it is changed from the profile, and the
 * variable can be removed. As soon as any non-demo super-admin exists, the demo super-admins stop being
 * super-admins (the reseed never re-promotes them), so the public demo password never opens real tenants.
 */
export async function ensurePlatformOwner(db: Db, env: Record<string, string | undefined> = process.env): Promise<PlatformOwnerReport> {
  const email = env.HULLWISE_OWNER_EMAIL?.trim().toLowerCase() || null;
  const password = env.HULLWISE_OWNER_PASSWORD ?? "";
  let owner: PlatformOwnerReport["owner"] = "not_configured";
  if (email) {
    if (email.endsWith(".demo")) throw new Error("HULLWISE_OWNER_EMAIL must be a real address, not a demo one.");
    const [existing] = await db.select({ id: schema.users.id, isSuperAdmin: schema.users.isSuperAdmin }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (existing) {
      if (!existing.isSuperAdmin) await db.update(schema.users).set({ isSuperAdmin: true, updatedAt: new Date() }).where(eq(schema.users.id, existing.id));
      owner = existing.isSuperAdmin ? "unchanged" : "promoted";
    } else if (password.length >= OWNER_PASSWORD_MIN_LENGTH) {
      await db.insert(schema.users).values({ email, name: "Platform owner", passwordHash: await bcrypt.hash(password, 10), isSuperAdmin: true, emailVerified: new Date() });
      owner = "created";
    } else owner = "missing_password";
  }
  const demoted: string[] = [];
  const [real] = await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.isSuperAdmin, true), notInArray(schema.users.email, [...DEMO_SUPER_ADMINS]), sql`${schema.users.disabledAt} is null`)).limit(1);
  if (real) {
    const rows = await db.update(schema.users).set({ isSuperAdmin: false, updatedAt: new Date() }).where(and(inArray(schema.users.email, [...DEMO_SUPER_ADMINS]), eq(schema.users.isSuperAdmin, true))).returning({ email: schema.users.email });
    demoted.push(...rows.map((r) => r.email));
  }
  return { owner, demoted };
}
