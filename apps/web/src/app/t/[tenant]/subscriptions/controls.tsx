"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, Textarea } from "@hullwise/ui";
import type { SubscriptionAction, SubscriptionCapabilities } from "@hullwise/core";
import type { ActionResult } from "@/server/action-result";
import { addSubscriptionNoteAction, assignSubscriptionAction, connectSubscriptionProviderAction, resyncSubscriptionsAction, saveCancellationReasonAction, simulateRenewalAction, subscriptionActionAction, testSubscriptionProviderAction } from "@/server/actions/subscriptions";

/* Client controls of the addon.subscriptions pages (#67): every write asks for confirmation first. */

function useMessage() {
  const t = useTranslations("subscriptions");
  const tc = useTranslations("common");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const say = (r: ActionResult<unknown>, okText: string) => setMsg(r.ok ? { tone: "ok", text: okText } : { tone: "err", text: (t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : r.error) + (r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : "") });
  const view = msg ? <Alert variant={msg.tone === "err" ? "destructive" : "default"}><AlertDescription data-testid="subscription-message">{msg.text}</AlertDescription></Alert> : null;
  return { say, view, clear: () => setMsg(null) };
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/* ---------- the subscription app ---------- */

export function ProviderControls({ slug, connected, mock, provider, canManage }: { slug: string; connected: boolean; mock: boolean; provider: string | null; canManage: boolean }) {
  const t = useTranslations("subscriptions.provider");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view } = useMessage();
  const [connect, setConnect] = useState(false);
  const [form, setForm] = useState({ provider: provider ?? "shopify_subscriptions", apiToken: "", webhookSecret: "" });
  if (!canManage) return null;
  const run = (fn: () => Promise<void>) => start(async () => { await fn(); router.refresh(); });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {connected && <Button size="sm" variant="outline" disabled={pending} data-testid="subs-test" onClick={() => run(async () => { const r = await testSubscriptionProviderAction(slug); say(r, r.ok && r.data ? (r.data.ok ? t("test_ok", { account: r.data.accountName ?? "" }) : t("test_failed", { error: r.data.error ?? "" })) : ""); })}>{t("test")}</Button>}
        {connected && <Button size="sm" variant="outline" disabled={pending} data-testid="subs-resync" onClick={() => run(async () => { const r = await resyncSubscriptionsAction(slug); say(r, r.ok && r.data ? t("resync_done", { summary: r.data.summary }) : ""); })}>{t("resync")}</Button>}
        {connected && mock && (
          <>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(async () => { const r = await simulateRenewalAction(slug, "success"); say(r, r.ok && r.data ? t("simulated", { summary: r.data.summary }) : ""); })}>{t("simulate_success")}</Button>
            <Button size="sm" variant="secondary" disabled={pending} data-testid="subs-simulate-failure" onClick={() => run(async () => { const r = await simulateRenewalAction(slug, "card_expired"); say(r, r.ok && r.data ? t("simulated", { summary: r.data.summary }) : ""); })}>{t("simulate_failure")}</Button>
          </>
        )}
        <Button size="sm" variant={connected ? "ghost" : "default"} onClick={() => setConnect((v) => !v)}>{connected ? t("reconnect") : t("connect")}</Button>
      </div>
      {connect && (
        <form className="space-y-2 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await connectSubscriptionProviderAction(slug, { ...form, provider: form.provider as "shopify_subscriptions" }); say(r, t("connected")); if (r.ok) setConnect(false); }); }}>
          <Label htmlFor="subs-provider">{t("app")}</Label>
          <Select id="subs-provider" size="sm" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            {["shopify_subscriptions", "recharge", "loop"].map((p) => <option key={p} value={p}>{t(`apps.${p}`)}</option>)}
          </Select>
          {!mock && form.provider !== "shopify_subscriptions" && (
            <>
              <Label htmlFor="subs-token">{t("api_token")}</Label>
              <Input id="subs-token" type="password" autoComplete="off" value={form.apiToken} onChange={(e) => setForm({ ...form, apiToken: e.target.value })} />
              <Label htmlFor="subs-secret">{t("webhook_secret")}</Label>
              <Input id="subs-secret" type="password" autoComplete="off" value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} />
            </>
          )}
          <p className="text-xs text-muted-foreground">{form.provider === "shopify_subscriptions" ? t("shopify_hint") : mock ? t("mock_hint") : t("token_hint")}</p>
          <Button size="sm" type="submit" disabled={pending}>{t("save")}</Button>
        </form>
      )}
      {view}
    </div>
  );
}

/* ---------- customer-care actions on a contract ---------- */

const ACTION_CAP: Record<SubscriptionAction, keyof SubscriptionCapabilities> = { pause: "canPause", resume: "canResume", skip: "canSkip", swap: "canSwap", frequency: "canChangeFrequency", reschedule: "canReschedule", cancel: "canCancel", payment_link: "canSendPaymentLink" };

export function ContractActions({ slug, contractId, status, capabilities, lines, swapOptions, reasons, nextBillingAt }: { slug: string; contractId: string; status: string; capabilities: SubscriptionCapabilities; lines: { id: string; label: string; productId: string | null; variantId: string | null }[]; swapOptions: { id: string; productId: string; title: string }[]; reasons: { code: string; label: string }[]; nextBillingAt: string | null }) {
  const t = useTranslations("subscriptions.actions");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view, clear } = useMessage();
  const [open, setOpen] = useState<SubscriptionAction | null>(null);
  const [key, setKey] = useState("");
  const [form, setForm] = useState({ lineId: lines[0]?.id ?? "", variantId: "", unit: "month", count: 1, nextBillingAt: nextBillingAt ?? "", reason: reasons[0]?.code ?? "other", note: "" });
  const live = status === "active" || status === "paused";
  const allowed = (a: SubscriptionAction) => capabilities[ACTION_CAP[a]] && (a === "resume" ? status === "paused" : a === "pause" ? status === "active" : a === "payment_link" ? live || status === "failed" : live);
  const actions: SubscriptionAction[] = ["pause", "resume", "skip", "swap", "frequency", "reschedule", "payment_link", "cancel"];
  const visible = actions.filter(allowed);
  const unavailable = actions.filter((a) => !capabilities[ACTION_CAP[a]]);
  const openDialog = (a: SubscriptionAction) => { clear(); setKey(newKey()); setOpen(a); };
  const line = lines.find((l) => l.id === form.lineId) ?? lines[0];
  const options = swapOptions.filter((v) => v.productId === line?.productId && v.id !== line?.variantId);
  const confirm = () => start(async () => {
    if (!open) return;
    const r = await subscriptionActionAction(slug, { contractId, action: open, requestKey: key, lineId: open === "swap" ? form.lineId : undefined, variantId: open === "swap" ? form.variantId : undefined, unit: open === "frequency" ? (form.unit as "month") : undefined, count: open === "frequency" ? form.count : undefined, nextBillingAt: open === "reschedule" ? form.nextBillingAt : undefined, reason: open === "cancel" ? form.reason : undefined, note: open === "cancel" ? form.note || null : undefined });
    say(r, r.ok && r.data?.replayed ? t("already_done") : t(`done.${open}`));
    if (r.ok) setOpen(null);
    router.refresh();
  });
  return (
    <div className="space-y-2" data-testid="contract-actions">
      {visible.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : (
        <div className="flex flex-wrap gap-2">
          {visible.map((a) => <Button key={a} size="sm" variant={a === "cancel" ? "destructive" : "outline"} onClick={() => openDialog(a)} data-testid={`action-${a}`}>{t(a)}</Button>)}
        </div>
      )}
      {unavailable.length > 0 && <p className="text-xs text-muted-foreground">{t("unsupported", { actions: unavailable.map((a) => t(a)).join(", ") })}</p>}
      {view}
      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open ? t(`confirm_title.${open}`) : ""}</DialogTitle>
            <DialogDescription>{t("confirm_description")}</DialogDescription>
          </DialogHeader>
          {open === "swap" && (
            <div className="space-y-2">
              {lines.length > 1 && (<><Label htmlFor="swap-line">{t("line")}</Label><Select id="swap-line" value={form.lineId} onChange={(e) => setForm({ ...form, lineId: e.target.value, variantId: "" })}>{lines.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></>)}
              <Label htmlFor="swap-variant">{t("new_variant")}</Label>
              <Select id="swap-variant" value={form.variantId} onChange={(e) => setForm({ ...form, variantId: e.target.value })} data-testid="swap-variant">
                <option value="">—</option>
                {options.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </Select>
            </div>
          )}
          {open === "frequency" && (
            <div className="flex items-end gap-2">
              <div className="space-y-1"><Label htmlFor="freq-count">{t("every")}</Label><Input id="freq-count" type="number" min={1} max={52} className="w-20" value={form.count} onChange={(e) => setForm({ ...form, count: Number(e.target.value) || 1 })} /></div>
              <Select aria-label={t("unit")} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>{["day", "week", "month"].map((u) => <option key={u} value={u}>{t(`units.${u}`)}</option>)}</Select>
            </div>
          )}
          {open === "reschedule" && (<div className="space-y-1"><Label htmlFor="resched">{t("next_billing")}</Label><Input id="resched" type="date" value={form.nextBillingAt} onChange={(e) => setForm({ ...form, nextBillingAt: e.target.value })} /></div>)}
          {open === "cancel" && (
            <div className="space-y-2">
              <Label htmlFor="cancel-reason">{t("reason")}</Label>
              <Select id="cancel-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} data-testid="cancel-reason">{reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</Select>
              <Label htmlFor="cancel-note">{t("note_optional")}</Label>
              <Textarea id="cancel-note" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)}>{t("back")}</Button>
            <Button disabled={pending || (open === "swap" && !form.variantId)} variant={open === "cancel" ? "destructive" : "default"} onClick={confirm} data-testid="action-confirm">{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- recovery: note, assign, payment link ---------- */

export function RecoveryActions({ slug, contractId, canWrite, members, assignedTo, canSendLink }: { slug: string; contractId: string; canWrite: boolean; members: { id: string; name: string }[]; assignedTo: string | null; canSendLink: boolean }) {
  const t = useTranslations("subscriptions.recovery");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view } = useMessage();
  const [noteOpen, setNoteOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [contacted, setContacted] = useState(true);
  if (!canWrite) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSendLink && <Button size="sm" variant="outline" disabled={pending} data-testid="recovery-link" onClick={() => { setKey(newKey()); setLinkOpen(true); }}>{t("send_link")}</Button>}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setNoteOpen(true)} data-testid="recovery-note">{t("add_note")}</Button>
      <Select size="sm" className="w-40" aria-label={t("assignee")} value={assignedTo ?? ""} disabled={pending} onChange={(e) => start(async () => { const r = await assignSubscriptionAction(slug, contractId, e.target.value || null); say(r, t("assigned")); router.refresh(); })}>
        <option value="">{t("unassigned")}</option>
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </Select>
      {view}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("send_link_title")}</DialogTitle><DialogDescription>{t("send_link_description")}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLinkOpen(false)}>{t("back")}</Button>
            <Button disabled={pending} data-testid="recovery-link-confirm" onClick={() => start(async () => { const r = await subscriptionActionAction(slug, { contractId, action: "payment_link", requestKey: key }); say(r, t("link_sent")); if (r.ok) setLinkOpen(false); router.refresh(); })}>{t("send_link")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("add_note")}</DialogTitle><DialogDescription>{t("note_description")}</DialogDescription></DialogHeader>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("add_note")} data-testid="recovery-note-body" />
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={contacted} onCheckedChange={(v) => setContacted(v === true)} />{t("contacted")}</label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>{t("back")}</Button>
            <Button disabled={pending || !note.trim()} data-testid="recovery-note-save" onClick={() => start(async () => { const r = await addSubscriptionNoteAction(slug, contractId, note, contacted); say(r, t("note_saved")); if (r.ok) { setNoteOpen(false); setNote(""); } router.refresh(); })}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- the tenant's cancellation reasons ---------- */

export function ReasonEditor({ slug, reasons }: { slug: string; reasons: { code: string; label: string; kind: string; keywords: string[]; isActive: boolean }[] }) {
  const t = useTranslations("subscriptions.cancellations");
  const router = useRouter();
  const [pending, start] = useTransition();
  const { say, view } = useMessage();
  const [draft, setDraft] = useState({ code: "", label: "", kind: "voluntary" as "voluntary" | "involuntary", keywords: "" });
  const save = (r: { code: string; label: string; kind: "voluntary" | "involuntary"; keywords: string; isActive: boolean }) => start(async () => { const res = await saveCancellationReasonAction(slug, r); say(res, t("saved")); router.refresh(); });
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border text-sm">
        {reasons.map((r) => (
          <li key={r.code} className="flex flex-wrap items-center justify-between gap-2 p-2" data-testid="reason-row">
            <span className="min-w-0"><span className="font-medium">{r.label}</span> <span className="font-mono text-xs text-muted-foreground">{r.code}</span>{r.keywords.length > 0 && <span className="block truncate text-xs text-muted-foreground">{r.keywords.join(", ")}</span>}</span>
            <span className="flex items-center gap-2 text-xs"><span className="text-muted-foreground">{t(`kind.${r.kind}`)}</span><Button size="sm" variant="ghost" disabled={pending} onClick={() => save({ code: r.code, label: r.label, kind: r.kind as "voluntary", keywords: r.keywords.join(","), isActive: !r.isActive })}>{r.isActive ? t("deactivate") : t("activate")}</Button></span>
          </li>
        ))}
      </ul>
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); save({ ...draft, code: draft.code || draft.label, isActive: true }); setDraft({ code: "", label: "", kind: "voluntary", keywords: "" }); }}>
        <Input placeholder={t("label")} aria-label={t("label")} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <Input placeholder={t("keywords")} aria-label={t("keywords")} value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
        <Button type="submit" size="sm" disabled={pending || !draft.label.trim()}>{t("add")}</Button>
      </form>
      {view}
    </div>
  );
}
