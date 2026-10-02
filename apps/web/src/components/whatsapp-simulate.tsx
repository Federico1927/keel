"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@hullwise/ui";
import { simulateSpokiWebhookAction } from "@/server/actions/spoki";

/** Mock mode: what Spoki would post for one logged message (receipt, reply, opt-out), through the real webhook route. */
export function WhatsappSimulate({ slug, messageId, replyText }: { slug: string; messageId: string; replyText: string }) {
  const t = useTranslations("whatsapp.log");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (kind: "delivered" | "read" | "failed" | "reply" | "stop") =>
    start(async () => {
      const r = await simulateSpokiWebhookAction(slug, { messageId, kind, text: kind === "reply" ? replyText : undefined });
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
          <DropdownMenuItem onSelect={() => run("reply")} data-testid="simulate-reply">{t("simulate_reply", { text: replyText })}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run("stop")} data-testid="simulate-stop">{t("simulate_stop")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {msg && <span className="text-xs text-muted-foreground" data-testid="whatsapp-simulate-result">{msg}</span>}
    </span>
  );
}
