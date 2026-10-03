"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Textarea } from "@hullwise/ui";
import { sendWhatsappReplyAction } from "@/server/actions/spoki";

/** The team's free-text answer in a thread: only while the 24-hour window is open (WhatsApp's rule). */
export function ReplyForm({ slug, messageId, windowOpen }: { slug: string; messageId: string; windowOpen: boolean }) {
  const t = useTranslations("whatsapp.conversations");
  const tw = useTranslations("whatsapp.errors");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!windowOpen) return <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground" data-testid="reply-closed">{t("reply_closed")}</p>;
  return (
    <form
      className="space-y-2"
      data-testid="reply-form"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await sendWhatsappReplyAction(slug, messageId, text);
          if (!r.ok) return setError(tw.has(r.error) ? tw(r.error) : tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : r.error);
          setError(null);
          setText("");
          router.refresh();
        });
      }}
    >
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} aria-label={t("reply_label")} placeholder={t("reply_placeholder")} data-testid="reply-text" />
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("reply_hint")}</p>
        <Button type="submit" disabled={pending || !text.trim()} data-testid="reply-send">{t("reply_send")}</Button>
      </div>
    </form>
  );
}
