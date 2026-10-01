import type { AttemptOutcome } from "./queue";

/**
 * Tag vocabulary of the add-on. Nothing here is hard-coded: every list comes from the tenant's
 * COD settings. Matching is case-insensitive and trims whitespace; an entry ending with `*`
 * matches by prefix (`vendita*` matches "Vendita Marco"), the way the reference platform
 * recognised its confirmation tags.
 */
export type TagClass = "cancelled" | "confirmed" | "queue";
export type TagWriteEvent = "entered" | AttemptOutcome | "unreachable" | "replaced";
export const TAG_WRITE_EVENTS: readonly TagWriteEvent[] = ["entered", "confirmed", "no_answer", "call_back", "modified", "cancelled", "unreachable", "replaced"];

export interface TagOps {
  add: string[];
  remove: string[];
}
export interface TagSettings {
  queue: string[];
  confirmed: string[];
  cancelled: string[];
  clearQueueTagsOnClose: boolean;
  write: Record<TagWriteEvent, TagOps>;
}

export const normTag = (t: string): string => t.trim().toLowerCase();

/** True when `tag` matches `pattern` (exact, or prefix when the pattern ends with `*`). */
export function tagMatches(pattern: string, tag: string): boolean {
  const p = normTag(pattern);
  const t = normTag(tag);
  if (!p) return false;
  return p.endsWith("*") ? t.startsWith(p.slice(0, -1)) : t === p;
}

export function firstMatching(patterns: readonly string[], tags: readonly string[]): string | null {
  for (const tag of tags) if (patterns.some((p) => tagMatches(p, tag))) return normTag(tag);
  return null;
}

/**
 * What the order's platform tags say about the COD flow, with the reference precedence:
 * cancelled > confirmed > queue. `null` when no configured tag is present.
 */
export function classifyTags(settings: Pick<TagSettings, "queue" | "confirmed" | "cancelled">, tags: readonly string[]): { kind: TagClass; tag: string } | null {
  const cancelled = firstMatching(settings.cancelled, tags);
  if (cancelled) return { kind: "cancelled", tag: cancelled };
  const confirmed = firstMatching(settings.confirmed, tags);
  if (confirmed) return { kind: "confirmed", tag: confirmed };
  const queue = firstMatching(settings.queue, tags);
  if (queue) return { kind: "queue", tag: queue };
  return null;
}

/** Parses a comma- or newline-separated list typed by an admin into clean unique tags. */
export function parseTagList(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[,\n]/)) {
    const t = part.trim().replace(/\s+/g, " ");
    if (t && !out.some((x) => normTag(x) === normTag(t))) out.push(t);
  }
  return out;
}

/**
 * Effective tag changes for an event given the order's current tags: adds only what is missing,
 * removes only what is present, and on a closing event also drops every queue tag when the
 * tenant asked for it (the reference "replace all operational tags" behaviour, made explicit).
 * Returns the exact lists to send to the platform and the resulting local tag set (lower-cased).
 */
export function planTagWrites(settings: TagSettings, event: TagWriteEvent, currentTags: readonly string[]): { add: string[]; remove: string[]; next: string[] } {
  const ops = settings.write[event] ?? { add: [], remove: [] };
  const current = currentTags.map(normTag);
  const closing = event === "confirmed" || event === "cancelled" || event === "replaced";
  const removePatterns = [...ops.remove, ...(closing && settings.clearQueueTagsOnClose ? settings.queue : [])];
  const addNorm = new Set(ops.add.map(normTag));
  const remove = current.filter((t) => !addNorm.has(t) && removePatterns.some((p) => tagMatches(p, t)));
  const add = ops.add.filter((a) => !current.includes(normTag(a)));
  const removed = new Set(remove);
  const next = [...current.filter((t) => !removed.has(t)), ...add.map(normTag)];
  return { add, remove: [...new Set(remove)], next: [...new Set(next)] };
}

/** Operator skill routing: no allowed tags means any order; otherwise the item's entry tag must match. */
export function operatorAllowed(allowedTags: readonly string[] | null | undefined, entryTag: string | null): boolean {
  if (!allowedTags || allowedTags.length === 0) return true;
  if (!entryTag) return true;
  return allowedTags.some((p) => tagMatches(p, entryTag));
}
