/**
 * Time-of-day greeting and the name to greet people by. Pure: the caller passes the instant and
 * the time zone (the user's, else the tenant's), so the server renders the same text the person
 * would expect in their own day, whatever the server or browser clock zone.
 */

export const GREETING_KEYS = ["morning", "afternoon", "evening"] as const;
export type GreetingKey = (typeof GREETING_KEYS)[number];

/** Hour of the day (0–23) of `date` in `timeZone`; falls back to UTC for an unknown zone. */
export function hourIn(date: Date, timeZone: string): number {
  let tz = timeZone;
  if (!isTimeZone(tz)) tz = "UTC";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).formatToParts(date).find((p) => p.type === "hour");
  return Number(part?.value ?? 0) % 24;
}

/** morning 05:00–11:59, afternoon 12:00–17:59, evening 18:00–04:59, local to `timeZone`. */
export function greetingKey(date: Date, timeZone: string): GreetingKey {
  const h = hourIn(date, timeZone);
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  return "evening";
}

/** True for an IANA zone the runtime knows (e.g. "Europe/Rome"). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface PersonName {
  preferredName?: string | null;
  name?: string | null;
  email?: string | null;
}

/** Preferred name → full name → the part of the email before "@". Never the full email. */
export function displayName(user: PersonName | null | undefined): string {
  const pick = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const local = pick(user?.email?.split("@")[0]);
  return pick(user?.preferredName) ?? pick(user?.name) ?? local ?? "—";
}

/** One or two initials for the avatar placeholder. */
export function initials(user: PersonName | null | undefined): string {
  const source = (user?.name && user.name.trim()) || (user?.preferredName && user.preferredName.trim()) || user?.email?.split("@")[0] || "?";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0]![0], words[words.length - 1]![0]] : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}
