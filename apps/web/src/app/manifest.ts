import type { MetadataRoute } from "next";
import { PRODUCT_NAME } from "@hullwise/config";
import { TOKENS } from "@hullwise/ui/tokens";

/** Web app manifest (#49): installs the app to the home screen, standalone, opening on the workspace picker. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: "Operations platform for e-commerce teams",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: TOKENS.light.bg,
    theme_color: TOKENS.light.primary,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
