import { getTranslations } from "next-intl/server";
import type { AdRow } from "@hullwise/services";
import { Badge } from "@hullwise/ui";

/** Format, status, fatigue (frequency up while CTR falls), missing UTM template and the pause suggestion of one ad. */
export async function AdBadges({ ad }: { ad: Pick<AdRow, "format" | "status" | "fatigue" | "utm" | "suggestion" | "hook" | "angle"> }) {
  const t = await getTranslations("ads");
  return (
    <>
      <Badge variant="outline">{ad.format}</Badge>
      {ad.hook && <span>{ad.hook}{ad.angle ? ` · ${ad.angle}` : ""}</span>}
      {ad.status !== "active" && <Badge variant="muted">{t(`status.${ad.status}`)}</Badge>}
      {ad.fatigue && ad.fatigue.level !== "no_data" && ad.fatigue.level !== "fresh" && <Badge variant={ad.fatigue.level === "fatigued" ? "destructive" : "warning"} data-testid="fatigue-badge">{t(`fatigue.${ad.fatigue.level}`)}</Badge>}
      {!ad.utm.ok && <Badge variant="warning" data-testid="utm-badge">{t("utm_badge")}</Badge>}
      {ad.suggestion && <Badge variant="destructive" data-testid="pause-suggestion">{t(`pause_reason.${ad.suggestion}`)}</Badge>}
    </>
  );
}
