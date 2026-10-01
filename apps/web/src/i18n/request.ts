import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@keel/config";
import { loadMessages } from "./messages";

export const LOCALE_COOKIE = "NEXT_LOCALE";

/**
 * Locale resolution: explicit cookie (set by the user picker or by the tenant
 * default on login) → default. The user/tenant preference is written to the
 * cookie at sign-in and whenever the user changes it, so this stays cheap.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return { locale, messages: await loadMessages(locale), timeZone: "UTC" };
});
