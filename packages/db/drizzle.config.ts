import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "postgres://hullwise_admin:hullwise_admin@127.0.0.1:5432/hullwise" },
  entities: { roles: { provider: "", include: ["hullwise_app", "hullwise_admin"] } },
  strict: true,
  verbose: true,
});
