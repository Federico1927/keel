"use client";

import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import type { LandingLocale } from "@/config/site";

/**
 * Client-side provider for the few interactive components (header, pricing toggle, contact form).
 * Wrapping it in a client component keeps next-intl from looking for a server request config,
 * which a static export does not have.
 */
export function IntlProvider({
  locale,
  messages,
  children,
}: {
  locale: LandingLocale;
  messages: AbstractIntlMessages;
  children: React.ReactNode;
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}
