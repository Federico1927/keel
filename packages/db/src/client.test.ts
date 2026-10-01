import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { adminDb, appDb } from "./client";

describe("database handles without a URL", () => {
  const saved = { app: process.env.DATABASE_URL, admin: process.env.DATABASE_ADMIN_URL };
  afterEach(() => {
    process.env.DATABASE_URL = saved.app;
    process.env.DATABASE_ADMIN_URL = saved.admin;
  });

  it("can be created (as next build does) and fail only when queried", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_ADMIN_URL;
    const app = appDb();
    const admin = adminDb();
    // Drizzle wraps driver errors in "Failed query"; the reason is the cause.
    await expect(app.execute(sql`select 1`)).rejects.toMatchObject({ cause: { message: "DATABASE_URL is not set" } });
    await expect(admin.transaction(async () => undefined)).rejects.toThrow("DATABASE_ADMIN_URL is not set");
  });
});
