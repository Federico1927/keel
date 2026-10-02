import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@hullwise/config";
import { loadMessages } from "./messages";

export const LOCALE_COOKIE = "NEXT_LOCALE";

/**
 * Locale resolution: the cookie (written by the language picker, and at sign-in from the language
 * saved on the user's profile) → default. Pages format dates and numbers in this same locale.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return { locale, messages: await loadMessages(locale), timeZone: "UTC" };
});
