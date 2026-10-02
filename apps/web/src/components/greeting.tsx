import { getTranslations } from "next-intl/server";
import { displayName, formatDate, greetingKey, isTimeZone, type PersonName } from "@hullwise/core";

/**
 * "Good morning, Giulia" with today's date, computed on the server in the user's time zone (else
 * the tenant's). The text is final HTML: the browser never recomputes it, so a visitor whose clock
 * zone differs cannot get "morning" from the server and "evening" after hydration.
 */
export async function Greeting({ user, tenantTimeZone, locale, line, now = new Date() }: { user: PersonName & { timeZone: string | null }; tenantTimeZone: string; locale: string; line?: string; now?: Date }) {
  const t = await getTranslations("greeting");
  const zone = user.timeZone && isTimeZone(user.timeZone) ? user.timeZone : tenantTimeZone;
  const key = greetingKey(now, zone);
  return (
    <div className="mb-5" data-testid="greeting" data-greeting={key} data-time-zone={zone}>
      <p className="text-2xl font-semibold tracking-tight sm:text-3xl">{t(key, { name: displayName(user) })}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        <span className="inline-block first-letter:uppercase">{formatDate(now, locale, zone, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
        {line ? ` · ${line}` : null}
      </p>
    </div>
  );
}
