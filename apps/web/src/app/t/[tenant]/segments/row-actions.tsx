"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@keel/ui";
import { deleteSegmentAction, evaluateSegmentAction } from "@/server/actions/segments";

export function SegmentRowActions({ slug, segmentId, canWrite, canExport, afterDelete }: { slug: string; segmentId: string; canWrite: boolean; canExport: boolean; afterDelete?: string }) {
  const t = useTranslations("segments");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center justify-end gap-1">
      {error && <span className="text-xs text-destructive">{tc(`errors.${error}`)}</span>}
      {canExport && (
        <Button asChild size="sm" variant="outline">
          <a href={`/t/${slug}/segments/${segmentId}/export`}>
            <Download /> {t("export_csv")}
          </a>
        </Button>
      )}
      {canWrite && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await evaluateSegmentAction(slug, segmentId); if (!r.ok) setError(r.error); else router.refresh(); })}>
          <RefreshCw /> {t("evaluate")}
        </Button>
      )}
      {canWrite && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(true)} aria-label={tc("delete")}>
          <Trash2 />
        </Button>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("delete_title")}</DialogTitle>
            <DialogDescription>{t("delete_description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{tc("cancel")}</Button>
            <Button variant="destructive" disabled={pending} onClick={() => start(async () => { const r = await deleteSegmentAction(slug, segmentId); if (!r.ok) return setError(r.error); setConfirm(false); if (afterDelete) router.push(afterDelete); router.refresh(); })}>{tc("delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}
