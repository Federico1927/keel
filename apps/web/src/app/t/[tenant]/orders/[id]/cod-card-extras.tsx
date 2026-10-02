"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Label, Textarea } from "@keel/ui";
import { escalateAction, releaseQueueItemAction, resolveEscalationAction, sendCodMessageAction, transferAction } from "@/server/actions/cod";
import { CopyButton } from "../../cod/queue-extras";

const errorText = (t: ReturnType<typeof useTranslations>, tc: ReturnType<typeof useTranslations>, code: string) => (tc.has(`errors.${code}`) ? tc(`errors.${code}`) : t("action_failed"));

/** Opens by itself (once per order and browser session) when the order is opened from the queue and the score flags something (C.7). */
export function PrecheckDialog({ orderId, orderName, flagged, previousAddresses, recomputed, autoOpen }: { orderId: string; orderName: string; flagged: { key: string; severity: string; summary: string }[]; previousAddresses: { orderId: string; orderName: string; date: string; address: string }[]; recomputed: boolean; autoOpen: boolean }) {
  const t = useTranslations("cod.precheck");
  const tf = useTranslations("cod.factors");
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const worth = flagged.length > 0 || previousAddresses.length > 0;
  // decided once, on arrival: a refresh that adds a flag later never pops the dialog over the work
  const decided = useRef(false);
  useEffect(() => {
    setReady(true);
    if (decided.current) return;
    decided.current = true;
    if (!worth || !autoOpen) return;
    const key = `cod-precheck:${orderId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // storage blocked: open every time
    }
    setOpen(true);
  }, [orderId, worth, autoOpen]);
  if (!worth) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="precheck-open" data-ready={ready ? "true" : "false"}>{t("open", { n: flagged.length })}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="precheck-dialog">
          <DialogHeader>
            <DialogTitle>{t("title", { order: orderName })}</DialogTitle>
            <DialogDescription>{recomputed ? t("recomputed") : t("description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {flagged.length > 0 && (
              <ul className="space-y-1">
                {flagged.map((f) => (
                  <li key={f.key} className="flex items-start gap-2"><Badge variant={f.severity === "critical" ? "destructive" : "warning"}>{t(`severity.${f.severity}`)}</Badge><span><span className="font-medium">{tf(`${f.key}.name`)}</span> <span className="text-muted-foreground">· {tf(`${f.key}.help`)}</span>{f.summary && <span className="block text-xs text-muted-foreground">{f.summary}</span>}</span></li>
                ))}
              </ul>
            )}
            {previousAddresses.length > 0 && (
              <div>
                <p className="mb-1 font-medium">{t("previous_addresses")}</p>
                <ul className="space-y-1 text-xs">
                  {previousAddresses.map((a) => <li key={a.orderId}><Link href={`./${a.orderId}`} className="text-primary hover:underline">{a.orderName}</Link> · {a.date} · {a.address}</li>)}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter><Button onClick={() => setOpen(false)} data-testid="precheck-close">{t("close")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Release, pass to a colleague, escalate to an admin (C.9); admins also resolve escalations. */
export function TransferMenu({ slug, orderId, operators, canRelease, canTransfer, isAdmin, escalated, transfersLeft }: { slug: string; orderId: string; operators: { id: string; label: string }[]; canRelease: boolean; canTransfer: boolean; isAdmin: boolean; escalated: boolean; transfersLeft: number | null }) {
  const t = useTranslations("cod.transfer");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [escalating, setEscalating] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = (r: { ok: boolean; error?: string }) => {
    if (r.ok) {
      setError(null);
      setEscalating(false);
      router.refresh();
    } else setError(errorText(t, tc, r.error ?? ""));
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={pending} data-testid="transfer-menu">{t("menu")}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canRelease && <DropdownMenuItem onSelect={() => start(async () => done(await releaseQueueItemAction(slug, orderId)))} data-testid="transfer-release">{t("release")}</DropdownMenuItem>}
          {canTransfer && (
            <>
              <DropdownMenuLabel>{t("pass_to")}{transfersLeft !== null ? ` · ${t("left_today", { n: transfersLeft })}` : ""}</DropdownMenuLabel>
              {operators.map((o) => <DropdownMenuItem key={o.id} disabled={transfersLeft === 0} onSelect={() => start(async () => done(await transferAction(slug, orderId, o.id)))} data-testid="transfer-to">{o.label}</DropdownMenuItem>)}
            </>
          )}
          {!canTransfer && <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">{t("no_transfer_after_call")}</DropdownMenuLabel>}
          <DropdownMenuSeparator />
          {!escalated && <DropdownMenuItem onSelect={() => setEscalating(true)} data-testid="escalate">{t("escalate")}</DropdownMenuItem>}
          {escalated && isAdmin && <DropdownMenuItem onSelect={() => start(async () => done(await resolveEscalationAction(slug, orderId)))} data-testid="resolve-escalation">{t("resolve")}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <Alert variant="destructive" className="w-full py-2"><AlertDescription data-testid="transfer-error">{error}</AlertDescription></Alert>}
      <Dialog open={escalating} onOpenChange={setEscalating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("escalate_title")}</DialogTitle>
            <DialogDescription>{t("escalate_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="esc-reason">{t("reason")}</Label>
            <Textarea id="esc-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="escalate-reason" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEscalating(false)}>{tc("cancel")}</Button>
            <Button disabled={pending || reason.trim().length < 3} onClick={() => start(async () => done(await escalateAction(slug, orderId, reason)))} data-testid="escalate-save">{t("escalate")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Confirmation templates: copy the filled text, or send it through the messaging channel (C.17). */
export function MessagesPanel({ slug, orderId, templates, canSend, hasPhone }: { slug: string; orderId: string; templates: { key: string; name: string; text: string }[]; canSend: boolean; hasPhone: boolean }) {
  const t = useTranslations("cod.messages");
  const tc = useTranslations("common");
  const router = useRouter();
  const [key, setKey] = useState(templates[0]?.key ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const current = templates.find((x) => x.key === key) ?? templates[0];
  if (!current) return null;
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid="messages-panel">
      <div className="flex flex-wrap items-center gap-1">
        {templates.map((x) => <button key={x.key} type="button" onClick={() => setKey(x.key)} className={`rounded-full border px-2 py-0.5 text-xs ${x.key === current.key ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground"}`} data-testid="template-option">{x.name}</button>)}
      </div>
      <p className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs" data-testid="template-preview">{current.text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={current.text} label={t("copy")} testId="template-copy" />
        {canSend && (
          <Button
            size="sm"
            disabled={pending || !hasPhone}
            title={hasPhone ? undefined : t("no_phone")}
            onClick={() =>
              start(async () => {
                const r = await sendCodMessageAction(slug, orderId, current.key);
                setMsg(r.ok ? { ok: true, text: t("sent", { n: r.data?.attemptNumber ?? 0 }) } : { ok: false, text: errorText(t, tc, r.error) });
                if (r.ok) router.refresh();
              })
            }
            data-testid="template-send"
          >
            {t("send")}
          </Button>
        )}
        {msg && <span className={`text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`} data-testid="message-result">{msg.text}</span>}
      </div>
    </div>
  );
}
