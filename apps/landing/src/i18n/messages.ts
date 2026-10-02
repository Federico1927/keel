import { createTranslator } from "next-intl";
import type { LandingLocale } from "@/config/site";
import en from "../../messages/en.json";
import it from "../../messages/it.json";
import es from "../../messages/es.json";

export type Messages = typeof en;

const MESSAGES: Record<LandingLocale, Messages> = { en, it: it as Messages, es: es as Messages };

export function getMessages(locale: LandingLocale): Messages {
  return MESSAGES[locale];
}

/** Server-side translator: a pure function, so static export needs no request context. */
export function getTranslator(locale: LandingLocale) {
  return createTranslator({ locale, messages: getMessages(locale) });
}
export type Translator = ReturnType<typeof getTranslator>;
