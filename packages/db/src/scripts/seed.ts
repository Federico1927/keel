import { seedAll } from "../seed";

const url = process.argv[2] ?? process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
const started = Date.now();
seedAll(url)
  .then(() => {
    console.info(`[db:seed] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
