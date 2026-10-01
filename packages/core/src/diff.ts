export type FieldDiff = { from: unknown; to: unknown };
export type Diff = Record<string, FieldDiff>;

const DEFAULT_IGNORED = new Set(["updatedAt", "updated_at", "syncedAt", "synced_at", "searchBlob", "search_blob"]);

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return [...v].map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return v;
}

/**
 * Shallow diff of two records. Arrays are compared order-insensitively; dates by ISO string.
 * Bookkeeping columns are ignored by default so sync noise never produces audit rows.
 */
export function diffRecords<T extends Record<string, unknown>>(prev: Partial<T> | null | undefined, next: Partial<T>, ignore: Iterable<string> = DEFAULT_IGNORED): Diff {
  const ignored = new Set(ignore);
  const out: Diff = {};
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const a = normalize(prev?.[key]);
    const b = normalize(next[key]);
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[key] = { from: prev?.[key] ?? null, to: next[key] ?? null };
  }
  return out;
}

export function hasChanges(diff: Diff): boolean {
  return Object.keys(diff).length > 0;
}
