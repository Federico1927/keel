import type { DashboardPeriod } from "@keel/config";
import type { Period } from "./finance";

/** Midnight of the tenant's local day containing `at`, as an instant. */
function localMidnight(at: Date, timeZone: string, dayOffset = 0): Date {
  const local = new Date(at.toLocaleString("en-US", { timeZone }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = local.getTime() - utc.getTime();
  const m = new Date(local);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() + dayOffset);
  return new Date(m.getTime() - offsetMs);
}

/** Local calendar parts of `at` in the tenant time zone. */
function localParts(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const local = new Date(at.toLocaleString("en-US", { timeZone }));
  return { y: local.getFullYear(), m: local.getMonth(), d: local.getDate() };
}

/** Instant of local midnight on a given calendar date in the tenant time zone. */
function midnightOf(y: number, m: number, d: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m, d, 12));
  return localMidnight(guess, timeZone);
}

/**
 * Half-open period of a dashboard preset in the tenant time zone: `today` from local midnight,
 * rolling windows of whole local days ending now, month and year to date, the previous calendar month.
 */
export function dashboardPeriod(preset: DashboardPeriod, now: Date, timeZone: string): Period {
  const today = localMidnight(now, timeZone);
  const { y, m } = localParts(now, timeZone);
  switch (preset) {
    case "today":
      return { from: today, to: now };
    case "7d":
      return { from: localMidnight(now, timeZone, -6), to: now };
    case "90d":
      return { from: localMidnight(now, timeZone, -89), to: now };
    case "mtd":
      return { from: midnightOf(y, m, 1, timeZone), to: now };
    case "last_month":
      return { from: midnightOf(m === 0 ? y - 1 : y, (m + 11) % 12, 1, timeZone), to: midnightOf(y, m, 1, timeZone) };
    case "ytd":
      return { from: midnightOf(y, 0, 1, timeZone), to: now };
    case "30d":
    default:
      return { from: localMidnight(now, timeZone, -29), to: now };
  }
}

/** `YYYY-MM` of `at` in the tenant time zone. */
export function localMonthKey(at: Date, timeZone: string): string {
  const { y, m } = localParts(at, timeZone);
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The target of a month: that month's own row, else the latest earlier one (targets carry forward). */
export function targetForMonth(targets: readonly { month: string; target: number }[], month: string): { month: string; target: number } | null {
  let best: { month: string; target: number } | null = null;
  for (const t of targets) if (t.month <= month && (!best || t.month > best.month)) best = t;
  return best;
}

/**
 * Month-end projection of a metric from its month-to-date value: additive metrics (money, counts)
 * grow with the days left, rates and ratios stay where they are.
 */
export function projectMonthEnd(valueToDate: number | null, additive: boolean, elapsedDays: number, daysInMonth: number): number | null {
  if (valueToDate === null) return null;
  if (!additive || elapsedDays <= 0) return valueToDate;
  return (valueToDate / elapsedDays) * daysInMonth;
}

/* ---------- note widget: a small, safe markdown subset ---------- */

export type MdInline = { t: "text"; v: string } | { t: "strong"; v: string } | { t: "em"; v: string } | { t: "code"; v: string } | { t: "link"; v: string; href: string };
export type MdBlock = { t: "h"; level: 2 | 3; inl: MdInline[] } | { t: "p"; inl: MdInline[] } | { t: "ul"; items: MdInline[][] } | { t: "ol"; items: MdInline[][] };

/** Links allowed in a note: http(s), mailto and app-relative paths; anything else (javascript:, data:) renders as text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\/[^\s]+$/i.test(h) || /^mailto:[^\s]+$/i.test(h)) return h;
  if (/^\/(?!\/)[^\s]*$/.test(h)) return h;
  return null;
}

function inline(src: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let mm = re.exec(src); mm; mm = re.exec(src)) {
    if (mm.index > last) out.push({ t: "text", v: src.slice(last, mm.index) });
    if (mm[1] !== undefined) out.push({ t: "strong", v: mm[1] });
    else if (mm[2] !== undefined) out.push({ t: "em", v: mm[2] });
    else if (mm[3] !== undefined) out.push({ t: "code", v: mm[3] });
    else {
      const href = safeHref(mm[5]!);
      out.push(href ? { t: "link", v: mm[4]!, href } : { t: "text", v: mm[4]! });
    }
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

/**
 * Parses a note into blocks (headings, paragraphs, bullet and numbered lists, bold, italic, code,
 * links). The result is data rendered as React elements: no HTML is ever produced or injected, so
 * markup typed by a tenant shows as text.
 */
export function parseNoteMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: MdInline[][] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inl: inline(para.join(" ")) });
    para = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of src.slice(0, 4000).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length === 3 ? 3 : 2, inl: inline(h[2]!) });
    } else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (para.length) {
        blocks.push({ t: "p", inl: inline(para.join(" ")) });
        para = [];
      }
      if (!list || list.t !== kind) {
        if (list) blocks.push(list);
        list = { t: kind, items: [] };
      }
      list.items.push(inline((ul ?? ol)![1]!));
    } else {
      if (list) {
        blocks.push(list);
        list = null;
      }
      para.push(line);
    }
  }
  flush();
  return blocks;
}
