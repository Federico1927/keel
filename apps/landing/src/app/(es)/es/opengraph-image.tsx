import { PRODUCT_NAME } from "@/config/site";
import { OG_CONTENT_TYPE, OG_SIZE, ogImage } from "@/landing/og-image";

export const dynamic = "force-static";
export const alt = PRODUCT_NAME;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogImage("es");
}
