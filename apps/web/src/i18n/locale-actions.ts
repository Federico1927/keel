"use server";
import { cookies } from "next/headers";
import { adminDb, eq, schema } from "@hullwise/db";
import { isLocale } from "@hullwise/config";
import { getCurrentUser } from "@/server/session";
import { LOCALE_COOKIE } from "./request";

/** The picker's choice applies now (cookie) and is remembered on the user's profile for the next sign-in. */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  const user = await getCurrentUser();
  if (user) await adminDb().update(schema.users).set({ locale }).where(eq(schema.users.id, user.id));
}
