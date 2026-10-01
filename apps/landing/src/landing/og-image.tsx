import { ImageResponse } from "next/og";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { getTranslator } from "@/i18n/messages";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

/** Open Graph card generated at build time: name, tagline and the three differentiators. */
export function ogImage(locale: LandingLocale) {
  const t = getTranslator(locale);
  const points = ["contract", "setup", "users"] as const;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "linear-gradient(135deg, #1b1f27 0%, #243b55 100%)",
        color: "#f3efe6",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          fontSize: 40,
          letterSpacing: 6,
          textTransform: "uppercase",
        }}
      >
        <svg
          width="52"
          height="52"
          viewBox="0 0 32 32"
          fill="none"
          stroke="#f3efe6"
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
        <div style={{ display: "flex", gap: 36, fontSize: 28, color: "#c9d3e0" }}>
          {points.map((p) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  display: "flex",
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: "#7fb0a0",
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
