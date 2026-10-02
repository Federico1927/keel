"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select } from "@keel/ui";
import { assignPoolCodesAction, releasePoolCodeAction, setDiscountPoolActiveAction, topUpDiscountPoolAction } from "@/server/actions/discounts";
import type { ActionResult } from "@/server/action-result";

function useError() {
  const t = useTranslations("discount_pool");
  const tc = useTranslations("common");
  return (r: { ok: boolean; error?: string } | null) => (r && !r.ok && r.error ? (t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : tc("errors.unknown")) : null);
}

/** Pool on/off with a confirmation: every code stops being accepted on the store. */
export function PoolActiveToggle({ slug, poolId, isActive }: { slug: string; poolId: string; isActive: boolean }) {
  const t = useTranslations("discount_pool");
  const tc = useTranslations("common");
  const router = useRouter();
  const err = useError();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult<{ codes: number }> | null>(null);
  return (
    <>
      <Button variant={isActive ? "destructive" : "default"} onClick={() => setOpen(true)} data-testid="pool-toggle">{isActive ? t("deactivate") : t("activate")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isActive ? t("deactivate_title") : t("activate_title")}</DialogTitle>
            <DialogDescription>{isActive ? t("deactivate_description") : t("activate_description")}</DialogDescription>
          </DialogHeader>
          {err(result) && <Alert variant="destructive"><AlertDescription>{err(result)}</AlertDescription></Alert>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button
              variant={isActive ? "destructive" : "default"}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await setDiscountPoolActiveAction(slug, poolId, !isActive);
                  setResult(r);
                  if (r.ok) {
                    setOpen(false);
                    router.refresh();
                  }
                })
              }
            >
              {isActive ? t("deactivate") : t("activate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TopUpForm({ slug, poolId, ready, target }: { slug: string; poolId: string; ready: number; target: number }) {
  const t = useTranslations("discount_pool");
  const router = useRouter();
  const err = useError();
  const [state, action, pending] = useActionState(topUpDiscountPoolAction.bind(null, slug, poolId), null);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={action} className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="pool-target">{t("top_up_target")}</Label>
          <Input id="pool-target" name="target" type="number" min={1} max={10000} defaultValue={Math.max(target, ready)} required />
        </div>
        <Button type="submit" disabled={pending} data-testid="pool-top-up">{t("top_up")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("top_up_hint", { ready })}</p>
      {state?.ok && state.data && <p className="text-sm text-success" data-testid="pool-top-up-result">{t("top_up_done", { added: state.data.added, imported: state.data.imported, failed: state.data.failed })}</p>}
      {err(state) && <p className="text-sm text-destructive">{err(state)}</p>}
    </form>
  );
}

export function AssignForm({ slug, poolId, campaigns }: { slug: string; poolId: string; campaigns: { id: string; name: string }[] }) {
  const t = useTranslations("discount_pool");
  const router = useRouter();
  const err = useError();
  const [targetKind, setTargetKind] = useState<"customer" | "campaign">("customer");
  const [state, action, pending] = useActionState(assignPoolCodesAction.bind(null, slug, poolId), null);
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={action} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="assign-target">{t("assign_to")}</Label>
          <Select id="assign-target" name="target" value={targetKind} onChange={(e) => setTargetKind(e.target.value as "customer" | "campaign")}>
            <option value="customer">{t("assign_customer")}</option>
            <option value="campaign">{t("assign_campaign")}</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="assign-count">{t("assign_count")}</Label>
          <Input id="assign-count" name="count" type="number" min={1} max={1000} defaultValue={1} required />
        </div>
      </div>
      {targetKind === "customer" ? (
        <div className="space-y-1">
          <Label htmlFor="assign-email">{t("customer_email")}</Label>
          <Input id="assign-email" name="customerEmail" type="email" required />
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="assign-campaign">{t("assign_campaign")}</Label>
          <Select id="assign-campaign" name="campaignId" required>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </div>
      )}
      <Button type="submit" variant="secondary" disabled={pending}>{t("assign")}</Button>
      {state?.ok && state.data && <p className="text-sm text-success">{t("assigned_codes", { codes: state.data.codes.join(", ") })}</p>}
      {err(state) && <p className="text-sm text-destructive">{err(state)}</p>}
    </form>
  );
}

export function ReleaseButton({ slug, poolId, discountId }: { slug: string; poolId: string; discountId: string }) {
  const t = useTranslations("discount_pool");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await releasePoolCodeAction(slug, poolId, discountId); router.refresh(); })}>
      {t("release")}
    </Button>
  );
}
