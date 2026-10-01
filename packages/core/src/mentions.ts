/** Mentions are stored inline as `@[Display Name](uuid)` so the text stays readable after renames. */
const MENTION_RE = /@\[([^\]]{1,80})\]\(([0-9a-f-]{36})\)/gi;

export function extractMentions(body: string): { userId: string; label: string }[] {
  const out: { userId: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const userId = m[2]!.toLowerCase();
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, label: m[1]! });
  }
  return out;
}

/** Splits a note into text and mention tokens for rendering. */
export function tokenizeMentions(body: string): ({ type: "text"; value: string } | { type: "mention"; userId: string; label: string })[] {
  const tokens: ReturnType<typeof tokenizeMentions> = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    if (m.index! > last) tokens.push({ type: "text", value: body.slice(last, m.index) });
    tokens.push({ type: "mention", userId: m[2]!.toLowerCase(), label: m[1]! });
    last = m.index! + m[0].length;
  }
  if (last < body.length) tokens.push({ type: "text", value: body.slice(last) });
  return tokens;
}

/** Detects an `@query` being typed before the caret, for the autocomplete. */
export function mentionQueryAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[\s(])@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
  if (!m) return null;
  return { start: caret - m[1]!.length - 1, query: m[1]! };
}
