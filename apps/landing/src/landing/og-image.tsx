import { ImageResponse } from "next/og";
import { TOKENS } from "@keel/ui/tokens";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

/** Open Graph card generated at build time, per locale, in the direction A light palette of packages/ui. */
export function ogImage(locale: LandingLocale) {
  const t = getTranslator(locale);
  const points = ["contract", "setup", "users"] as const;
  const c = TOKENS.light;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: `linear-gradient(160deg, ${c.surface} 55%, ${c.bg} 100%)`,
        borderTop: `12px solid ${c.primary}`,
        color: c.fg,
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          fontSize: 40,
          fontWeight: 600,
        }}
      >
        <svg
          width="52"
          height="52"
          viewBox="0 0 32 32"
          fill="none"
          stroke={c.primary}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 11c0 9 5 15 10 15s10-6 10-15" />
          <path d="M16 7v19" />
          <path d="M6 11h20" />
        </svg>
        {PRODUCT_NAME}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.1, maxWidth: 1000 }}>
          {t("meta.og_tagline")}
        </div>
        <div style={{ display: "flex", gap: 36, fontSize: 28, color: c.muted }}>
          {points.map((p) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  display: "flex",
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: c.success,
                }}
              />
              {t(`hero.points.${p}`)}
            </div>
          ))}
        </div>
      </div>
    </div>,
    OG_SIZE,
  );
}
