"use server";
import { cookies } from "next/headers";
import { isLocale } from "@keel/config";
import { LOCALE_COOKIE } from "./request";

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}
