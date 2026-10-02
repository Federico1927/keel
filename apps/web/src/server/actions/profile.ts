"use server";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { adminDb, eq, schema } from "@keel/db";
import { DEFAULT_LOCALE, isLocale } from "@keel/config";
import { AccountError, cancelEmailChange, changePassword, confirmEmailChange, requestEmailChange, setAvatar, signOutOtherSessions, updatePreferences, updateProfile, type AccountContext } from "@keel/services";
import { THEME_COOKIE, isThemePreference } from "@keel/ui/tokens";
import { unstable_update } from "@/auth";
import { LOCALE_COOKIE } from "@/i18n/request";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { requireUser } from "@/server/session";
import { signSessionVersion } from "@/server/session-proof";
import { processImage } from "@/server/images";

const YEAR = { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" as const };

async function account(): Promise<AccountContext> {
  const user = await requireUser();
  const h = await headers();
  return { db: adminDb(), userId: user.id, ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null };
}

function failFrom(e: unknown): ActionResult<never> {
  if (e instanceof AccountError) return fail(e.code, e.issues.length ? Object.fromEntries(e.issues.map((i) => [i, i])) : undefined);
  throw e;
}

/** Keeps the caller's own session valid after the session version moved (the others end). */
async function keepThisSession(userId: string, sv: number) {
  await unstable_update({ sv, svProof: await signSessionVersion(userId, sv) } as never);
}

const text = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? String(fd.get(k)) : "");

export async function updateProfileAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    await updateProfile(await account(), { name: text(fd, "name"), preferredName: text(fd, "preferredName"), jobTitle: text(fd, "jobTitle") });
    revalidatePath("/", "layout");
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

/**
 * Language, theme, density and time zone. The language and theme cookies follow at once on this
 * device; an empty language means the tenant's (the one the profile was opened from).
 */
export async function updatePreferencesAction(tenantSlug: string | null, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const locale = text(fd, "locale");
    const timeZone = text(fd, "timeZone");
    const theme = text(fd, "theme");
    const density = text(fd, "density");
    await updatePreferences(await account(), { locale: isLocale(locale) ? locale : null, theme: isThemePreference(theme) ? theme : "system", density: density === "compact" ? "compact" : "comfortable", timeZone: timeZone || null });
    const jar = await cookies();
    let shown = isLocale(locale) ? locale : null;
    if (!shown && tenantSlug) {
      const [t] = await adminDb().select({ l: schema.tenants.defaultLocale }).from(schema.tenants).where(eq(schema.tenants.slug, tenantSlug)).limit(1);
      shown = isLocale(t?.l) ? t.l : null;
    }
    jar.set(LOCALE_COOKIE, shown ?? DEFAULT_LOCALE, YEAR);
    jar.set(THEME_COOKIE, isThemePreference(theme) ? theme : "system", YEAR);
    revalidatePath("/", "layout");
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

/** Quick theme switch from the user menu: same preference as on the profile page. */
export async function setThemeAction(theme: string): Promise<ActionResult> {
  if (!isThemePreference(theme)) return fail("invalid_input");
  const ac = await account();
  const [row] = await adminDb().select({ locale: schema.users.locale, density: schema.users.density, timeZone: schema.users.timeZone }).from(schema.users).where(eq(schema.users.id, ac.userId)).limit(1);
  try {
    await updatePreferences(ac, { locale: isLocale(row?.locale) ? row.locale : null, theme, density: row?.density === "compact" ? "compact" : "comfortable", timeZone: row?.timeZone ?? null });
  } catch (e) {
    return failFrom(e);
  }
  (await cookies()).set(THEME_COOKIE, theme, YEAR);
  revalidatePath("/", "layout");
  return ok();
}

export async function uploadAvatarAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const file = fd.get("avatar");
  if (!(file instanceof File) || file.size === 0) return fail("invalid_input");
  const image = await processImage(file, { width: 256, height: 256, fit: "cover" });
  if (!image.ok) return fail(image.error);
  try {
    await setAvatar(await account(), image.image);
  } catch (e) {
    return failFrom(e);
  }
  revalidatePath("/", "layout");
  return ok();
}

export async function removeAvatarAction(): Promise<ActionResult> {
  try {
    await setAvatar(await account(), null);
  } catch (e) {
    return failFrom(e);
  }
  revalidatePath("/", "layout");
  return ok();
}

const passwordSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200), confirm: z.string().max(200) });

export async function changePasswordAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const parsed = passwordSchema.safeParse({ current: text(fd, "current"), next: text(fd, "next"), confirm: text(fd, "confirm") });
  if (!parsed.success) return fail("invalid_input");
  if (parsed.data.next !== parsed.data.confirm) return fail("password_mismatch");
  try {
    const ac = await account();
    const { sessionVersion } = await changePassword(ac, parsed.data.current, parsed.data.next);
    await keepThisSession(ac.userId, sessionVersion);
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

export async function signOutOtherSessionsAction(): Promise<ActionResult> {
  try {
    const ac = await account();
    const { sessionVersion } = await signOutOtherSessions(ac);
    await keepThisSession(ac.userId, sessionVersion);
    revalidatePath("/", "layout");
    return ok();
  } catch (e) {
    return failFrom(e);
  }
}

function appUrl(h: Headers): string {
  const env = process.env.NEXT_PUBLIC_APP_URL ?? process.env.AUTH_URL;
  if (env) return env.replace(/\/$/, "");
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
}

export async function requestEmailChangeAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const email = z.string().trim().email().max(200).safeParse(text(fd, "email"));
  if (!email.success) return fail("invalid_input");
  const base = appUrl(await headers());
  try {
    await requestEmailChange(await account(), email.data, (token) => `${base}/account/confirm-email?token=${encodeURIComponent(token)}`);
  } catch (e) {
    return failFrom(e);
  }
  revalidatePath("/", "layout");
  return ok();
}

export async function cancelEmailChangeAction(): Promise<ActionResult> {
  try {
    await cancelEmailChange(await account());
  } catch (e) {
    return failFrom(e);
  }
  revalidatePath("/", "layout");
  return ok();
}

/** Confirmation from the link sent to the new address (a POST from the confirm page, never a GET side effect). */
export async function confirmEmailChangeAction(token: string): Promise<ActionResult<{ email: string }>> {
  try {
    const { email } = await confirmEmailChange(adminDb(), token);
    return ok({ email });
  } catch (e) {
    return failFrom(e);
  }
}

/** First sign-in of a person without a name: the app opens only after this step. */
export async function completeProfileAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await updateProfile(await account(), { name: text(fd, "name"), preferredName: text(fd, "preferredName"), jobTitle: user.jobTitle });
  } catch (e) {
    return failFrom(e);
  }
  revalidatePath("/", "layout");
  const next = text(fd, "next");
  redirect(next.startsWith("/t/") || next.startsWith("/admin") ? next : "/");
}
