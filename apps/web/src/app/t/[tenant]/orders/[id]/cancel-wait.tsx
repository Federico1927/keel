"use client";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@hullwise/ui";
import { cancelBackorderWaitAction } from "@/server/actions/orders";

/** "Cancel wait": the order stops waiting for stock and is released (here and on the platform). */
export function CancelWaitButton({ slug, orderId }: { slug: string; orderId: string }) {
  const t = useTranslations("order_detail.backorders");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const confirm = () =>
    start(async () => {
      const r = await cancelBackorderWaitAction(slug, orderId, note || undefined);
      if (!r.ok) return setError(tc(`errors.${r.error}`));
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="backorder-cancel-wait">{t("cancel_wait")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cancel_wait_title")}</DialogTitle>
            <DialogDescription>{t("cancel_wait_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-wait-note">{t("note_optional")}</Label>
            <Input id="cancel-wait-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending} onClick={confirm} data-testid="backorder-cancel-wait-confirm">{t("cancel_wait_confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
