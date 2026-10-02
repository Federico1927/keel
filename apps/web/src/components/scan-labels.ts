import type { ScanLabels } from "@hullwise/ui";

/** Labels of the camera scanner from the `mobile.scan` messages (pass `useTranslations("mobile.scan")`). */
export function scanLabels(t: (key: "open" | "title" | "hint" | "unavailable" | "close" | "scanned", values?: Record<string, string>) => string): ScanLabels {
  return { open: t("open"), title: t("title"), hint: t("hint"), unavailable: t("unavailable"), close: t("close"), scanned: t("scanned", { code: "{code}" }) };
}
