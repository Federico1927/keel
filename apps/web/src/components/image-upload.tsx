"use client";
import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@hullwise/ui";
import type { ActionResult } from "@/server/action-result";

/** Downscales in the browser (alpha kept, WebP) so phone photos fit the server-action body limit. */
async function shrink(file: File, maxSide: number): Promise<Blob> {
  if (file.size < 900_000 || typeof createImageBitmap !== "function") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/webp", 0.9));
}

/**
 * File picker that uploads at once through a server action taking FormData with the file under
 * `field`. Errors come back as `profile.errors.<code>` keys.
 */
export function ImageUpload({ field, action, label, removeLabel, onRemove, hasImage, maxSide = 1024, testId }: { field: string; action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>; label: string; removeLabel?: string; onRemove?: () => Promise<ActionResult>; hasImage: boolean; maxSide?: number; testId?: string }) {
  const t = useTranslations("profile");
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const done = (r: ActionResult) => setError(r.ok ? null : r.error);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          data-testid={testId}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            start(async () => {
              try {
                const blob = await shrink(file, maxSide);
                const fd = new FormData();
                fd.set(field, blob instanceof File ? blob : new File([blob], "upload.webp", { type: blob.type }));
                done(await action(null, fd));
              } catch {
                setError("invalid_image");
              }
              if (input.current) input.current.value = "";
            });
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? t("uploading") : label}
        </Button>
        {hasImage && onRemove && (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => done(await onRemove()))}>
            {removeLabel}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("image_hint")}</p>
      {error && <p className="text-xs text-destructive" role="alert">{t(`errors.${error}`)}</p>}
    </div>
  );
}
