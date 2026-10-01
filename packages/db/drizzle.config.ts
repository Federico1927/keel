import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "postgres://keel_admin:keel_admin@127.0.0.1:5432/keel" },
  entities: { roles: { provider: "", include: ["keel_app", "keel_admin"] } },
  strict: true,
  verbose: true,
});
