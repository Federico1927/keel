"use client";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, Input, Textarea } from "@keel/ui";
import { closeTicketAction, replyTicketAction } from "@/server/actions/support";

export function TenantReplyForm({ slug, ticketId }: { slug: string; ticketId: string }) {
  const t = useTranslations("support");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState(replyTicketAction.bind(null, slug, ticketId), null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <Card>
      <CardContent className="pt-6">
        <form ref={form} action={action} className="space-y-3">
          <Textarea name="body" required rows={4} maxLength={8000} placeholder={t("reply_placeholder")} aria-label={t("reply")} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Input name="attachment" type="file" className="sm:max-w-xs" aria-label={t("attachment")} accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv" />
            <Button type="submit" disabled={pending}>{t("reply")}</Button>
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

export function CloseTicketButton({ slug, ticketId, label }: { slug: string; ticketId: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => void (await closeTicketAction(slug, ticketId)))}>
      {label}
    </Button>
  );
}
