"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { adminDb } from "@hullwise/db";
import { safeNextPath } from "@hullwise/core";
import { AccountError, acceptInvitationAsNewUser, acceptInvitationAsUser, completePasswordReset, requestPasswordReset } from "@hullwise/services";
import { signIn, signOut } from "@/auth";
import { fail, ok, type ActionResult } from "@/server/action-result";
import { requireUser } from "@/server/session";
import { createSignInGrant } from "@/server/sign-in-grant";
import "@/server/email";

/**
 * Signed-out account flows (#52): forgotten password, reset, invitation acceptance. Users are
 * platform rows, so these run on the admin connection like the rest of the auth layer; links come
 * from NEXT_PUBLIC_APP_URL in the services, never from the request's Host header.
 */
async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

const text = (fd: FormData, k: string) => (typeof fd.get(k) === "string" ? String(fd.get(k)) : "");

function failFrom(e: unknown): ActionResult<never> {
  if (e instanceof AccountError) return fail(e.code, e.issues.length ? Object.fromEntries(e.issues.map((i) => [i, i])) : undefined);
  throw e;
}

/** Signs the person in with a one-time grant and goes to `to` (throws the redirect). */
async function signInAndGo(userId: string, sessionVersion: number, to: string): Promise<never> {
  await signIn("one-time", { grant: createSignInGrant(userId, sessionVersion), redirectTo: to });
  redirect(to);
}

/** Always the same answer for a well-formed address (no enumeration); only the rate limit is told apart. */
export async function requestPasswordResetAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const email = z.string().trim().email().max(254).safeParse(text(fd, "email"));
  if (!email.success) return fail("invalid_input");
  try {
    await requestPasswordReset(adminDb(), { email: email.data, ip: await clientIp() });
  } catch (e) {
    if (e instanceof AccountError && e.code === "rate_limited") return fail("rate_limited");
    if (e instanceof AccountError) return ok();
    throw e;
  }
  return ok();
}

export async function resetPasswordAction(token: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const password = text(fd, "password");
  if (!password || password.length > 200) return fail("invalid_input");
  if (password !== text(fd, "confirm")) return fail("password_mismatch");
  let done: { userId: string; sessionVersion: number };
  try {
    done = await completePasswordReset(adminDb(), token, password, { ip: await clientIp() });
  } catch (e) {
    return failFrom(e);
  }
  // every other session ended with the session version; this browser signs in with the new one
  return signInAndGo(done.userId, done.sessionVersion, "/");
}

export async function acceptInvitationAction(token: string, _prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const usePassword = text(fd, "method") !== "email_link";
  const password = text(fd, "password");
  if (usePassword) {
    if (!password || password.length > 200) return fail("invalid_input");
    if (password !== text(fd, "confirm")) return fail("password_mismatch");
  }
  let done: { userId: string; tenantSlug: string; sessionVersion: number };
  try {
    done = await acceptInvitationAsNewUser(adminDb(), token, { name: text(fd, "name"), preferredName: text(fd, "preferredName"), password: usePassword ? password : null, privacyAccepted: fd.get("privacy") === "on", ip: await clientIp() });
  } catch (e) {
    return failFrom(e);
  }
  return signInAndGo(done.userId, done.sessionVersion, `/t/${done.tenantSlug}`);
}

/** An existing account, signed in, joins the tenant of the invitation. */
export async function acceptInvitationAsUserAction(token: string): Promise<ActionResult> {
  const user = await requireUser();
  let slug: string;
  try {
    slug = (await acceptInvitationAsUser(adminDb(), token, user.id, { ip: await clientIp() })).tenantSlug;
  } catch (e) {
    return failFrom(e);
  }
  redirect(`/t/${slug}`);
}

/** "Not you?": signs out and comes back to the same page (an invitation for another address). */
export async function signOutAndReturnAction(next: string): Promise<void> {
  await signOut({ redirectTo: `/login?next=${encodeURIComponent(safeNextPath(next))}` });
}
