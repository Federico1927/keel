import sharp from "sharp";

/** Below the 2 MB server-action body limit; the upload field downsizes larger pictures in the browser first. */
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type ProcessedImage = { ok: true; image: { data: Buffer; contentType: string } } | { ok: false; error: "invalid_image" | "image_too_large" };

/**
 * Re-encodes to WebP within the given box. Decoding with sharp also rejects files that only claim
 * to be images; SVG is not accepted (scriptable). Metadata is dropped by the re-encode.
 */
export async function processImage(file: File, box: { width: number; height: number; fit: "cover" | "inside" }): Promise<ProcessedImage> {
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, error: "image_too_large" };
  if (!ACCEPTED.has(file.type)) return { ok: false, error: "invalid_image" };
  try {
    const input = Buffer.from(await file.arrayBuffer());
    const data = await sharp(input, { animated: false, limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: box.width, height: box.height, fit: box.fit, withoutEnlargement: box.fit === "inside" })
      .webp({ quality: 85 })
      .toBuffer();
    return { ok: true, image: { data, contentType: "image/webp" } };
  } catch {
    return { ok: false, error: "invalid_image" };
  }
}
