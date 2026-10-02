"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, ImagePlus, Pencil, PlayCircle, Box, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogTitle, Input, cn } from "@keel/ui";
import { productMediaAction } from "@/server/actions/product-edit";
import { SaveError } from "./product-edit";

export interface GalleryMedia {
  id: string;
  type: string;
  url: string;
  alt: string | null;
}

/**
 * Product gallery (issue #19): Shopify's layout (cover large, the rest as tiles), a lightbox with
 * arrows, and for editors add from URL, reorder, alt text and delete. Every change is written to
 * Shopify first; the page shows what Shopify answered.
 */
export function ProductGallery({ slug, productId, version, media, title, canEdit }: { slug: string; productId: string; version: string | null; media: GalleryMedia[]; title: string; canEdit: boolean }) {
  const t = useTranslations("product_mirror.gallery");
  const router = useRouter();
  const [open, setOpen] = useState<number | null>(null);
  const [managing, setManaging] = useState(false);
  const [url, setUrl] = useState("");
  const [altEdit, setAltEdit] = useState<{ id: string; alt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (op: Record<string, unknown>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await productMediaAction(slug, productId, version, op);
      if (r.ok) {
        after?.();
        router.refresh();
      } else setError(r.error === "platform_error" ? `platform_error:${r.fieldErrors?.platform ?? ""}` : r.error);
    });
  const move = (i: number, dir: -1 | 1) => {
    const ids = media.map((m) => m.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    run({ type: "reorder", mediaIds: ids });
  };
  const icon = (m: GalleryMedia) => (m.type === "video" ? <PlayCircle className="h-5 w-5" /> : m.type === "model" ? <Box className="h-5 w-5" /> : null);
  const current = open === null ? null : media[open];
  return (
    <Card data-testid="product-gallery">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{t("title")} <span className="text-sm font-normal text-muted-foreground">({media.length})</span></CardTitle>
        {canEdit && <Button type="button" size="sm" variant={managing ? "secondary" : "ghost"} onClick={() => setManaging(!managing)} data-testid="manage-media"><Pencil className="h-3.5 w-3.5" /> {managing ? t("done") : t("manage")}</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {media.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {media.map((m, i) => (
              <div key={m.id} className={cn("group relative overflow-hidden rounded-md border bg-muted", i === 0 && "col-span-2 row-span-2")} data-testid="gallery-item">
                <button type="button" className="block aspect-[4/5] w-full" onClick={() => setOpen(i)} aria-label={t("open", { n: i + 1 })}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url} alt={m.alt ?? title} loading={i < 4 ? "eager" : "lazy"} className="h-full w-full object-cover" />
                </button>
                {icon(m) && <span className="pointer-events-none absolute left-1 top-1 rounded bg-card/80 p-0.5">{icon(m)}</span>}
                {managing && (
                  <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-1 bg-card/90 p-1">
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5" disabled={pending || i === 0} onClick={() => move(i, -1)} aria-label={t("move_left")}><ArrowLeft className="h-3.5 w-3.5" /></Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5" disabled={pending || i === media.length - 1} onClick={() => move(i, 1)} aria-label={t("move_right")} data-testid="media-move-right"><ArrowRight className="h-3.5 w-3.5" /></Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5" disabled={pending} onClick={() => setAltEdit({ id: m.id, alt: m.alt ?? "" })} aria-label={t("alt")}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5 text-destructive" disabled={pending} onClick={() => { if (window.confirm(t("delete_confirm"))) run({ type: "delete", mediaIds: [m.id] }); }} aria-label={t("delete")}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {managing && (
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run({ type: "create", url: url.trim(), alt: null }, () => setUrl("")); }}>
            <Input size="sm" type="url" required placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("add_url")} />
            <Button type="submit" size="sm" disabled={pending || !url.trim()}><ImagePlus className="h-3.5 w-3.5" /> {t("add")}</Button>
          </form>
        )}
        {altEdit && (
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); run({ type: "alt", mediaId: altEdit.id, alt: altEdit.alt.trim() || null }, () => setAltEdit(null)); }}>
            <Input size="sm" value={altEdit.alt} maxLength={512} onChange={(e) => setAltEdit({ ...altEdit, alt: e.target.value })} aria-label={t("alt")} placeholder={t("alt")} autoFocus />
            <Button type="submit" size="sm" disabled={pending}>{t("save_alt")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAltEdit(null)}>{t("cancel")}</Button>
          </form>
        )}
        {managing && <p className="text-xs text-muted-foreground">{t("hint")}</p>}
        <SaveError error={error} />
      </CardContent>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-3xl" data-testid="gallery-lightbox">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{current?.alt ?? title}</DialogDescription>
          {current && (
            <div className="space-y-2">
              <div className="relative flex items-center justify-center bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={current.url} alt={current.alt ?? title} className="max-h-[70vh] w-auto object-contain" />
                {media.length > 1 && (
                  <>
                    <Button type="button" size="sm" variant="secondary" className="absolute left-2" onClick={() => setOpen(((open ?? 0) - 1 + media.length) % media.length)} aria-label={t("previous")}><ChevronLeft className="h-4 w-4" /></Button>
                    <Button type="button" size="sm" variant="secondary" className="absolute right-2" onClick={() => setOpen(((open ?? 0) + 1) % media.length)} aria-label={t("next")} data-testid="lightbox-next"><ChevronRight className="h-4 w-4" /></Button>
                  </>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{current.alt ?? t("no_alt")}</span>
                <span className="flex items-center gap-2">{current.type !== "image" && <Badge variant="outline">{t(`type.${current.type}`)}</Badge>}<span className="tabular text-muted-foreground">{(open ?? 0) + 1}/{media.length}</span></span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
