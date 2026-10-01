import type { Locale } from "@keel/config";

export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  switch (locale) {
    case "it":
      return (await import("../../messages/it.json")).default;
    case "es":
      return (await import("../../messages/es.json")).default;
    default:
      return (await import("../../messages/en.json")).default;
  }
}
