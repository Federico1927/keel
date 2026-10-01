import { createBoss } from "./boss";

async function main() {
  const boss = createBoss();
  boss.on("error", (err: unknown) => console.error("[jobs] boss error", err));
  await boss.start();
  console.info("[jobs] worker started");
  const shutdown = async () => {
    await boss.stop({ graceful: true, timeout: 10_000 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
