/**
 * Account flows (#52): pure helpers shared by sign-in notices, the profile and the auth pages.
 */

/** Browser and OS family from a user agent (no parsing library): the "device" of sign-in notices and the profile. */
export function describeUserAgent(ua: string | null | undefined): { browser: string; os: string | null; label: string } | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /HeadlessChrome/.test(ua) ? "Chromium" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  return { browser, os, label: os ? `${browser} · ${os}` : browser };
}

/**
 * Whether a sign-in comes from a device not seen before: none of the earlier sign-ins has the same
 * browser and OS family. The very first sign-in is not "new" (nothing to compare with).
 */
export function isNewDevice(current: string | null | undefined, previous: (string | null)[]): boolean {
  if (previous.length === 0) return false;
  const key = describeUserAgent(current)?.label ?? "";
  return !previous.some((p) => (describeUserAgent(p)?.label ?? "") === key);
}

/** A same-origin path to go to after signing in: relative, no protocol-relative or backslash tricks; anything else → fallback. */
export function safeNextPath(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length > 500) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || [...next].some((c) => c.charCodeAt(0) < 32)) return fallback;
  return next;
}
