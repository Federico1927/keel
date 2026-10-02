"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Label, Textarea } from "@hullwise/ui";
import { revokeUserSessionsAction, setUserDisabledAction } from "@/server/actions/admin";

/** Disable (with a reason) or enable a person platform-wide (#48); the result shows inline. */
export function DisableUserButton({ userId, disabled, self }: { userId: string; disabled: boolean; self: boolean }) {
  const t = useTranslations("admin.user");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await setUserDisabledAction(userId, !disabled, reason);
      if (!r.ok) return setError(r.error === "self" ? t("errors.self") : t("errors.failed"));
      setOpen(false);
      setReason("");
      router.refresh();
    });
  if (self) return <p className="text-xs text-muted-foreground">{t("self_hint")}</p>;
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(null); }}>
      <DialogTrigger asChild>
        <Button variant={disabled ? "default" : "destructive"} data-testid={disabled ? "enable-user" : "disable-user"}>{disabled ? t("enable") : t("disable")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{disabled ? t("enable_title") : t("disable_title")}</DialogTitle>
          <DialogDescription>{disabled ? t("enable_description") : t("disable_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="disable-reason">{disabled ? t("note") : t("reason")}</Label>
          <Textarea id="disable-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
        </div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
          <Button variant={disabled ? "default" : "destructive"} disabled={pending} onClick={run} data-testid="confirm-disable">{disabled ? t("enable") : t("disable")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevokeSessionsButton({ userId }: { userId: string }) {
  const t = useTranslations("admin.user");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <span className="flex items-center gap-2">
      {done && <span className="text-xs text-muted-foreground" role="status">{t("sessions_revoked")}</span>}
      <Button variant="outline" disabled={pending} data-testid="revoke-sessions" onClick={() => start(async () => { const r = await revokeUserSessionsAction(userId); setDone(r.ok); router.refresh(); })}>{t("revoke_sessions")}</Button>
    </span>
  );
}
