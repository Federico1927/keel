/**
 * Names used before the product was renamed to Hullwise (2026-10-02, docs/DECISIONS.md).
 * This file and the cutover migration are the only code that still spells the old name: they exist so
 * a deployment configured with the old names fails loudly or is converted, instead of silently running
 * with defaults. Delete this file once every environment has been cut over.
 */
export const LEGACY_ENV_PREFIX = "KEEL_";
export const NEW_ENV_PREFIX = "HULLWISE_";
/** Database roles before the rename, converted by `pnpm db:bootstrap` (ALTER ROLE … RENAME keeps grants and RLS policies). */
export const LEGACY_DB_ROLES = { admin: "keel_admin", app: "keel_app" } as const;

/** Environment variables that still use the old prefix, with the name they must be renamed to. */
export function legacyEnvVars(env: Record<string, string | undefined>): { legacy: string; rename: string }[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(LEGACY_ENV_PREFIX) && env[k] !== undefined && env[k] !== "")
    .sort()
    .map((k) => ({ legacy: k, rename: NEW_ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length) }));
}
