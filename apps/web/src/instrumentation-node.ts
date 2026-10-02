import { checkRuntimeConfig } from "@hullwise/config";

/** Node-only startup check, kept out of `instrumentation.ts` so the edge bundle never sees `process.exit`. */
export function assertRuntimeConfig() {
  const { errors, warnings } = checkRuntimeConfig(process.env, "web");
  for (const w of warnings) console.warn(`[web] config: ${w}`);
  if (errors.length === 0) return;
  for (const e of errors) console.error(`[web] config: ${e}`);
  console.error("[web] refusing to start, fix the variables above.");
  process.exit(1);
}
