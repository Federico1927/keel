"use client";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, Checkbox, Input, Label, Textarea } from "@hullwise/ui";
import { adminReplyAction, adminSetTicketStatusAction } from "@/server/actions/support";

export function AdminReplyForm({ ticketId }: { ticketId: string }) {
  const t = useTranslations("admin.support");
  const ts = useTranslations("support");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(adminReplyAction.bind(null, ticketId), null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <Card>
      <CardContent className="pt-6">
        <form ref={form} action={action} className="space-y-3">
          <Textarea name="body" required rows={4} maxLength={8000} placeholder={ts("reply_placeholder")} aria-label={t("reply")} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Input name="attachment" type="file" className="sm:max-w-xs" aria-label={ts("attachment")} />
            <div className="flex items-center gap-3">
              <Label className="flex items-center gap-2 text-sm font-normal">
                <Checkbox name="close" /> {t("close_after")}
              </Label>
              <Button type="submit" disabled={pending}>{t("send")}</Button>
            </div>
          </div>
          {state && !state.ok && (
            <Alert variant="destructive">
              <AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function AdminStatusButton({ ticketId, status, label }: { ticketId: string; status: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => void (await adminSetTicketStatusAction(ticketId, status)))}>
      {label}
    </Button>
  );
}
