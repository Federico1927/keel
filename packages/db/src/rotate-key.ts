import { emailAddressHashes, encryptionKeyOf, hasPreviousEncryptionKey, reencryptSecret } from "@hullwise/integrations";
import { sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import type { DbExecutor } from "./client";

/**
 * APP_ENCRYPTION_KEY rotation (`pnpm db:rotate-key`, docs/DEPLOY.md "Rotating secrets"). Run once
 * with the new key in APP_ENCRYPTION_KEY and the old one in APP_ENCRYPTION_KEY_PREVIOUS: every stored
 * AES-GCM payload that only the previous key opens is re-encrypted with the new one. Idempotent (a
 * payload the current key opens is left alone), row by row with a compare-and-swap on the old value
 * (a concurrent write, e.g. a renewed Shopify token, wins), and `dryRun` only counts.
 *
 * Keyed hashes cannot be re-encrypted (the address is not stored): the platform suppression list gets
 * a row under the new key for every address the database still knows (users, invitations, customers,
 * tenant suppression lists); the rest match only while APP_ENCRYPTION_KEY_PREVIOUS is set.
 */

/** Every place an `encryptSecret` / `encryptJson` payload is stored. Keep in sync when adding one. */
export const ENCRYPTED_COLUMNS = [
  { label: "integrations.credentials_encrypted", table: "integrations", column: "credentials_encrypted" },
  { label: "integrations.config.app.secretEncrypted", table: "integrations", column: "config", path: ["app", "secretEncrypted"] },
  { label: "integrations.config.pendingSignIn.tokenEncrypted", table: "integrations", column: "config", path: ["pendingSignIn", "tokenEncrypted"] },
  { label: "ad_accounts.credentials_encrypted", table: "ad_accounts", column: "credentials_encrypted" },
  { label: "return_requests.bank_details_enc", table: "return_requests", column: "bank_details_enc" },
  { label: "webhook_endpoints.secret_enc", table: "webhook_endpoints", column: "secret_enc" },
  { label: "webhook_endpoints.previous_secret_enc", table: "webhook_endpoints", column: "previous_secret_enc" },
] as const satisfies readonly { label: string; table: string; column: string; path?: readonly string[] }[];

/** Queued emails (pg-boss `email.send` jobs not finished yet) carry the rendered message encrypted. */
const EMAIL_JOB = { label: "pgboss.job[email.send].data.payload", name: "email.send" } as const;

export interface RotationTargetReport {
  label: string;
  /** Payloads found (non-null). */
  total: number;
  /** Already opened by the current key. */
  current: number;
  /** Opened by the previous key: re-encrypted (or, in a dry run, would be). */
  reencrypted: number;
  /** Changed by someone else between read and write: left to them (they wrote with the current key). */
  skipped: number;
  /** Opened by neither key: lost unless the right key is found. */
  unreadable: number;
}

export interface RotationReport {
  dryRun: boolean;
  previousKeySet: boolean;
  targets: RotationTargetReport[];
  /** Platform suppression rows added under the new key for known addresses. */
  suppressionsRehashed: number;
  /** Suppression rows whose address the database does not know: they match only while the previous key is set. */
  suppressionsUnmatched: number;
  unreadable: number;
}

type Row = { id: string; v: string };

const ident = (s: string) => sql.raw(`"${s.replace(/"/g, '""')}"`);
const pathLit = (path: readonly string[]) => sql.raw(`'{${path.join(",")}}'`);

async function rotateColumn(db: DbExecutor, t: (typeof ENCRYPTED_COLUMNS)[number], dryRun: boolean): Promise<RotationTargetReport> {
  const out: RotationTargetReport = { label: t.label, total: 0, current: 0, reencrypted: 0, skipped: 0, unreadable: 0 };
  const path = "path" in t ? t.path : null;
  const value = path ? sql`${ident(t.column)} #>> ${pathLit(path)}` : ident(t.column);
  const rows = (await db.execute<Row>(sql`select id::text as id, ${value} as v from ${ident(t.table)} where ${value} is not null`)).rows;
  for (const r of rows) {
    out.total += 1;
    const which = encryptionKeyOf(r.v);
    if (which === "current") out.current += 1;
    else if (which === null) out.unreadable += 1;
    else if (dryRun) out.reencrypted += 1;
    else {
      const next = reencryptSecret(r.v).payload;
      const set = path ? sql`${ident(t.column)} = jsonb_set(${ident(t.column)}, ${pathLit(path)}, to_jsonb(${next}::text))` : sql`${ident(t.column)} = ${next}`;
      const res = await db.execute(sql`update ${ident(t.table)} set ${set} where id = ${r.id}::uuid and ${value} = ${r.v}`);
      if (res.rowCount) out.reencrypted += 1;
      else out.skipped += 1;
    }
  }
  return out;
}

async function rotateEmailJobs(db: DbExecutor, dryRun: boolean): Promise<RotationTargetReport | null> {
  const exists = (await db.execute<{ t: string | null }>(sql`select to_regclass('pgboss.job')::text as t`)).rows[0]?.t;
  if (!exists) return null;
  const out: RotationTargetReport = { label: EMAIL_JOB.label, total: 0, current: 0, reencrypted: 0, skipped: 0, unreadable: 0 };
  const rows = (await db.execute<Row>(sql`select id::text as id, data->>'payload' as v from pgboss.job where name = ${EMAIL_JOB.name} and state in ('created', 'retry', 'active') and data ? 'payload'`)).rows;
  for (const r of rows) {
    out.total += 1;
    const which = encryptionKeyOf(r.v);
    if (which === "current") out.current += 1;
    else if (which === null) out.unreadable += 1;
    else if (dryRun) out.reencrypted += 1;
    else {
      const next = reencryptSecret(r.v).payload;
      const res = await db.execute(sql`update pgboss.job set data = jsonb_set(data, '{payload}', to_jsonb(${next}::text)) where name = ${EMAIL_JOB.name} and id = ${r.id}::uuid and data->>'payload' = ${r.v}`);
      if (res.rowCount) out.reencrypted += 1;
      else out.skipped += 1;
    }
  }
  return out;
}

/**
 * The platform suppression list is keyed by `emailAddressHash`: for every address the database knows,
 * a row hashed with the previous key gets a twin under the current key (same reason, masked address and source).
 */
async function rehashSuppressions(db: DbExecutor, dryRun: boolean): Promise<{ rehashed: number; unmatched: number }> {
  if (!hasPreviousEncryptionKey()) return { rehashed: 0, unmatched: 0 };
  const rows = (await db.execute<{ email_hash: string; reason: string; email_masked: string; source: string; note: string | null }>(sql`select email_hash, reason, email_masked, source, note from email_address_suppressions`)).rows;
  if (!rows.length) return { rehashed: 0, unmatched: 0 };
  const present = new Set(rows.map((r) => `${r.email_hash}|${r.reason}`));
  const byOldHash = new Map<string, typeof rows>();
  for (const r of rows) byOldHash.set(r.email_hash, [...(byOldHash.get(r.email_hash) ?? []), r]);
  const addresses = (
    await db.execute<{ e: string }>(sql`
      select lower(trim(email)) as e from users
      union select lower(trim(email)) from invitations
      union select email_normalized from customers where email_normalized is not null
      union select lower(trim(email)) from email_suppressions where identity_type = 'email'`)
  ).rows;
  const matched = new Set<string>();
  let rehashed = 0;
  for (const { e } of addresses) {
    if (!e) continue;
    const [current, previous] = emailAddressHashes(e);
    const old = previous ? byOldHash.get(previous) : undefined;
    if (!old || !current) continue;
    matched.add(previous!);
    for (const r of old) {
      if (present.has(`${current}|${r.reason}`)) continue;
      present.add(`${current}|${r.reason}`);
      rehashed += 1;
      if (!dryRun) await db.execute(sql`insert into email_address_suppressions (email_hash, email_masked, reason, source, note) values (${current}, ${r.email_masked}, ${r.reason}, ${r.source}, ${r.note}) on conflict do nothing`);
    }
  }
  // rows already under the current key (added after the switch, or by an earlier run) are not "unmatched"
  const currentHashes = new Set(addresses.flatMap(({ e }) => (e ? [emailAddressHashes(e)[0]!] : [])));
  const unmatched = [...byOldHash.keys()].filter((h) => !matched.has(h) && !currentHashes.has(h)).length;
  return { rehashed, unmatched };
}

export async function rotateEncryptionKey(db: DbExecutor, opts: { dryRun?: boolean } = {}): Promise<RotationReport> {
  const dryRun = opts.dryRun ?? false;
  const previousKeySet = hasPreviousEncryptionKey();
  if (previousKeySet && process.env.APP_ENCRYPTION_KEY_PREVIOUS?.trim() === process.env.APP_ENCRYPTION_KEY?.trim()) throw new Error("APP_ENCRYPTION_KEY_PREVIOUS equals APP_ENCRYPTION_KEY: set the new key in APP_ENCRYPTION_KEY");
  const targets: RotationTargetReport[] = [];
  for (const t of ENCRYPTED_COLUMNS) targets.push(await rotateColumn(db, t, dryRun));
  const jobs = await rotateEmailJobs(db, dryRun);
  if (jobs) targets.push(jobs);
  const s = await rehashSuppressions(db, dryRun);
  const report: RotationReport = { dryRun, previousKeySet, targets, suppressionsRehashed: s.rehashed, suppressionsUnmatched: s.unmatched, unreadable: targets.reduce((n, t) => n + t.unreadable, 0) };
  if (!dryRun && previousKeySet) {
    const reencrypted = targets.reduce((n, t) => n + t.reencrypted, 0);
    await recordAudit(db, { tenantId: null, actorType: "system", action: "platform.encryption_key_rotated", entityType: "platform", entityId: "app_encryption_key", diff: { reencrypted: { from: 0, to: reencrypted } }, metadata: { targets: targets.map((t) => ({ label: t.label, reencrypted: t.reencrypted, unreadable: t.unreadable })), suppressionsRehashed: s.rehashed, suppressionsUnmatched: s.unmatched } });
  }
  return report;
}

/** Plain-text report for the console. */
export function formatRotationReport(r: RotationReport): string {
  const lines = [`${r.dryRun ? "DRY RUN: nothing written" : "Rotation applied"}${r.previousKeySet ? "" : " (APP_ENCRYPTION_KEY_PREVIOUS not set: verification only)"}`];
  for (const t of r.targets) lines.push(`  ${t.label}: ${t.total} found, ${t.current} current, ${t.reencrypted} ${r.dryRun ? "to re-encrypt" : "re-encrypted"}${t.skipped ? `, ${t.skipped} changed meanwhile` : ""}${t.unreadable ? `, ${t.unreadable} UNREADABLE` : ""}`);
  lines.push(`  email_address_suppressions: ${r.suppressionsRehashed} ${r.dryRun ? "to re-hash" : "re-hashed"} under the new key, ${r.suppressionsUnmatched} with an unknown address (matched only while APP_ENCRYPTION_KEY_PREVIOUS is set)`);
  lines.push(r.unreadable ? `${r.unreadable} payload(s) open with neither key: do NOT remove the old key until they are explained (docs/DEPLOY.md, "Rotating secrets").` : "Every stored payload opens with the current key.");
  return lines.join("\n");
}
