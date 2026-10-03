"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input } from "@hullwise/ui";
import { simulateSpokiWebhookAction } from "@/server/actions/spoki";

/**
 * Mock mode: what Spoki would post for one logged message (receipt, reply, opt-out), through the real
 * webhook route. `replies` are the customer answers offered: for a COD confirmation the store's own
 * confirm and cancel keywords (so the reply really moves the COD queue), a question otherwise.
 */
export function WhatsappSimulate({ slug, messageId, replies }: { slug: string; messageId: string; replies: readonly string[] }) {
  const t = useTranslations("whatsapp.log");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (kind: "delivered" | "read" | "failed" | "reply" | "stop", text?: string) =>
    start(async () => {
      const r = await simulateSpokiWebhookAction(slug, { messageId, kind, text });
      setMsg(r.ok ? t("simulated") : t("simulate_failed"));
      router.refresh();
    });
  return (
    <span className="inline-flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" disabled={pending} data-testid="whatsapp-simulate">{t("simulate")}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => run("delivered")} data-testid="simulate-delivered">{t("simulate_delivered")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run("read")} data-testid="simulate-read">{t("simulate_read")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run("failed")} data-testid="simulate-failed">{t("simulate_failed_receipt")}</DropdownMenuItem>
          {replies.map((text, i) => <DropdownMenuItem key={text} onSelect={() => run("reply", text)} data-testid={i === 0 ? "simulate-reply" : `simulate-reply-${i}`}>{t("simulate_reply", { text })}</DropdownMenuItem>)}
          <DropdownMenuItem onSelect={() => run("stop")} data-testid="simulate-stop">{t("simulate_stop")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {msg && <span className="text-xs text-muted-foreground" data-testid="whatsapp-simulate-result">{msg}</span>}
    </span>
  );
}

/** Mock mode, in a conversation: the customer writes a message of their own (it also reopens the 24-hour window). */
export function WhatsappSimulateInbound({ slug, messageId, placeholder }: { slug: string; messageId: string; placeholder: string }) {
  const t = useTranslations("whatsapp.conversations");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await simulateSpokiWebhookAction(slug, { messageId, kind: "reply", text: text.trim() || placeholder }); setMsg(r.ok ? null : t("simulate_failed")); if (r.ok) setText(""); router.refresh(); }); }} data-testid="simulate-inbound">
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} maxLength={300} aria-label={t("simulate_inbound")} className="sm:flex-1" data-testid="simulate-inbound-text" />
      <Button type="submit" size="sm" variant="outline" disabled={pending} data-testid="simulate-inbound-send">{t("simulate_inbound")}</Button>
      {msg && <span className="text-xs text-destructive">{msg}</span>}
    </form>
  );
}
