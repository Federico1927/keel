import { runMigrations } from "../migrate";

const url = process.argv[2] ?? process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
runMigrations(url)
  .then(() => {
    console.info("[db:migrate] done");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
