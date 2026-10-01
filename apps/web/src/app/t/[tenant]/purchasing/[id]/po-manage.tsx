"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@keel/ui";
import { deletePo, duplicatePo, revokeSupplierLinksAction } from "@/server/actions/purchasing";

/** Edit (draft and sent), duplicate (any) and delete (draft or cancelled) a purchase order. */
export function PoManageActions({ slug, poId, number, canEdit, canDelete }: { slug: string; poId: string; number: string; canEdit: boolean; canDelete: boolean }) {
  const t = useTranslations("po_detail.manage");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {canEdit && (
        <Button asChild variant="outline">
          <Link href={`/t/${slug}/purchasing/${poId}/edit`} data-testid="po-edit"><Pencil /> {tc("edit")}</Link>
        </Button>
      )}
      <Button variant="outline" disabled={pending} data-testid="po-duplicate" onClick={() => start(async () => {
        const r = await duplicatePo(slug, poId);
        if (r.ok && r.data) router.push(`/t/${slug}/purchasing/${r.data.id}`);
        else if (!r.ok) setError(r.error);
      })}>
        <Copy /> {t("duplicate")}
      </Button>
      {canDelete && (
        <Button variant="destructive" disabled={pending} onClick={() => setConfirm(true)} data-testid="po-delete">
          <Trash2 /> {tc("delete")}
        </Button>
      )}
      {error && <span className="self-center text-sm text-destructive">{tc(`errors.${error}`)}</span>}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("delete_title", { number })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("delete_hint")}</p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>{tc("cancel")}</Button>
            <Button type="button" variant="destructive" disabled={pending} data-testid="po-delete-confirm" onClick={() => start(async () => {
              const r = await deletePo(slug, poId);
              if (r.ok) router.push(`/t/${slug}/purchasing`);
              else {
                setConfirm(false);
                setError(r.error);
              }
            })}>{tc("delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface LinkView {
  id: string;
  hint: string | null;
  to: string | null;
  createdAt: string;
  expiresAt: string;
  lastViewedAt: string | null;
  viewCount: number;
  state: string;
}

/** The supplier links of a PO with their state; active links can be revoked. */
export function SupplierLinks({ slug, poId, links, canWrite }: { slug: string; poId: string; links: LinkView[]; canWrite: boolean }) {
  const t = useTranslations("po_detail.links");
  const tc = useTranslations("common");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  if (!links.length) return null;
  const active = links.some((l) => l.state === "active");
  return (
    <div className="space-y-2 border-t pt-3" data-testid="supplier-links">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("title")}</p>
      <ul className="space-y-1.5">
        {links.map((l) => (
          <li key={l.id} className="rounded border p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">…{l.hint ?? "????"}</span>
              <Badge variant={l.state === "active" ? "success" : l.state === "revoked" ? "muted" : "warning"} data-testid="supplier-link-state">{t(`state.${l.state}`)}</Badge>
            </div>
            <p className="text-muted-foreground">{t("issued", { at: l.createdAt, to: l.to ?? "—" })}</p>
            <p className="text-muted-foreground">{l.state === "active" ? t("expires", { at: l.expiresAt }) : l.state === "expired" ? t("expired_on", { at: l.expiresAt }) : t("revoked")}</p>
            <p className="text-muted-foreground">{l.viewCount > 0 ? t("views", { n: l.viewCount, at: l.lastViewedAt ?? "—" }) : t("no_views")}</p>
          </li>
        ))}
      </ul>
      {canWrite && active && (
        <Button type="button" size="sm" variant="outline" className="w-full" disabled={pending} data-testid="supplier-link-revoke" onClick={() => start(async () => {
          const r = await revokeSupplierLinksAction(slug, poId);
          setResult(r.ok ? t("revoked_ok") : tc(`errors.${r.error}`));
        })}>{t("revoke")}</Button>
      )}
      {result && <Alert variant="info"><AlertDescription>{result}</AlertDescription></Alert>}
    </div>
  );
}
