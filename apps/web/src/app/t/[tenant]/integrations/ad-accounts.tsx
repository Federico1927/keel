"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@hullwise/ui";
import { addMetaAdAccount, addMetaAdAccountMock, removeMetaAdAccount, resyncMetaAdAccount, testMetaAdAccount } from "@/server/actions/ad-accounts";
import type { ActionResult } from "@/server/action-result";

export interface AdAccountView {
  id: string;
  externalId: string;
  name: string;
  primary: boolean;
  status: string;
  mock: boolean;
  lastSync: string;
  lastSuccess: string;
  lastError: string | null;
  campaigns: number;
}

const variant = (s: string) => (s === "connected" ? "success" : s === "error" ? "destructive" : s === "syncing" ? "warning" : "muted") as "success" | "destructive" | "warning" | "muted";

/** Meta ad accounts of the store (#82): each with its status, last sync and error, test and resync; admins add or remove accounts. */
export function MetaAdAccounts({ slug, accounts, mock, canManage, limit }: { slug: string; accounts: AdAccountView[]; mock: boolean; canManage: boolean; limit: number }) {
  const t = useTranslations("integrations");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState<AdAccountView | null>(null);
  const err = (r: ActionResult<unknown>) => (r.ok ? "" : (t.has(`errors.${r.error}`) ? t(`errors.${r.error}`) : tc(`errors.${r.error}`)) + (r.fieldErrors?.platform ? ` (${r.fieldErrors.platform})` : ""));
  const say = (r: ActionResult<unknown>, okText: string) => {
    setMsg(r.ok ? { tone: "ok", text: okText } : { tone: "err", text: err(r) });
    router.refresh();
  };
  const full = accounts.length >= limit;
  return (
    <Card className="mt-6" data-testid="meta-ad-accounts">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t("ad_accounts.title")}</CardTitle>
          <CardDescription>{t("ad_accounts.description", { n: limit })}</CardDescription>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {mock ? (
              <Button size="sm" disabled={pending || full} data-testid="ad-account-add-mock" onClick={() => start(async () => { const r = await addMetaAdAccountMock(slug); say(r, r.ok && r.data ? t("ad_accounts.added", { account: r.data.account, summary: r.data.summary }) : ""); })}>
                {t("ad_accounts.add_mock")}
              </Button>
            ) : (
              <Button size="sm" disabled={pending || full} onClick={() => setShowAdd((v) => !v)}>{t("ad_accounts.add")}</Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 p-0 pb-4">
        <DataList
          rows={accounts}
          rowKey={(a) => a.id}
          rowProps={(a) => ({ "data-testid": "ad-account-row", "data-account": a.externalId, "data-status": a.status })}
          columns={[
            { key: "name", header: t("ad_accounts.columns.account"), mobile: "title", cell: (a) => <><span className="font-medium">{a.name}</span>{a.primary && <Badge variant="outline" className="ml-2">{t("ad_accounts.primary")}</Badge>}<span className="block font-mono text-xs text-muted-foreground">{a.externalId}</span></> },
            { key: "status", header: t("ad_accounts.columns.status"), mobile: "badge", label: "", cell: (a) => <span className="flex gap-1"><Badge variant={variant(a.status)}>{t(`status.${a.status}`)}</Badge><Badge variant="outline">{a.mock ? t("mode.mock") : t("mode.live")}</Badge></span> },
            { key: "campaigns", header: t("ad_accounts.columns.campaigns"), align: "right", className: "tabular", cell: (a) => a.campaigns },
            { key: "sync", header: t("last_sync"), priority: 2, cell: (a) => <span className="text-xs">{a.lastSync}</span> },
            { key: "success", header: t("last_success"), priority: 3, cell: (a) => <span className="text-xs">{a.lastSuccess}</span> },
            { key: "error", header: t("last_error"), cell: (a) => <span className={a.lastError ? "text-xs text-destructive" : "text-xs"} data-testid="ad-account-error">{a.lastError ?? "—"}</span> },
            {
              key: "actions", header: "", mobile: "action", align: "right",
              cell: (a) => canManage ? (
                <span className="flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await testMetaAdAccount(slug, a.id); say(r, r.ok && r.data ? (r.data.ok ? t("test_ok", { account: r.data.accountName ?? a.name }) : t("test_failed", { error: r.data.error ?? "" })) : ""); })}>{t("test_connection")}</Button>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { const r = await resyncMetaAdAccount(slug, a.id); say(r, r.ok && r.data ? (r.data.queued ? t("resync_queued") : t("resync_done", { summary: r.data.summary })) : ""); })}>{t("resync")}</Button>
                  {!a.primary && <Button size="sm" variant="ghost" disabled={pending} data-testid="ad-account-remove" onClick={() => setRemoving(a)}>{t("ad_accounts.remove")}</Button>}
                </span>
              ) : null,
            },
          ]}
        />
        {msg && (
          <Alert variant={msg.tone === "err" ? "destructive" : "default"} className="mx-4 w-auto">
            <AlertDescription data-testid="ad-accounts-msg">{msg.text}</AlertDescription>
          </Alert>
        )}
        {showAdd && !mock && <AddAccountForm slug={slug} onDone={() => setShowAdd(false)} />}
      </CardContent>
      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ad_accounts.remove_title", { account: removing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("ad_accounts.remove_description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>{tc("cancel")}</Button>
            <Button variant="destructive" disabled={pending} data-testid="ad-account-remove-confirm" onClick={() => start(async () => { const id = removing!.id; setRemoving(null); say(await removeMetaAdAccount(slug, id), t("ad_accounts.removed")); })}>{t("ad_accounts.remove")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AddAccountForm({ slug, onDone }: { slug: string; onDone: () => void }) {
  const t = useTranslations("integrations");
  const tc = useTranslations("common");
  const [state, formAction, pending] = useActionState(addMetaAdAccount.bind(null, slug), null);
  return (
    <form action={formAction} className="mx-4 grid gap-3 rounded-md border p-3 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="ad-account-id">{t("fields.ad_account")}</Label>
        <Input id="ad-account-id" name="adAccountId" placeholder="act_123456789" autoComplete="off" required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ad-account-name">{t("ad_accounts.name")}</Label>
        <Input id="ad-account-name" name="name" autoComplete="off" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ad-account-token">{t("fields.access_token")}</Label>
        <Input id="ad-account-token" name="accessToken" type="password" autoComplete="off" />
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-3">{t("ad_accounts.token_hint")}</p>
      {state && !state.ok && (
        <Alert variant="destructive" className="sm:col-span-3">
          <AlertDescription>{t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : tc(`errors.${state.error}`)}{state.fieldErrors?.platform ? ` (${state.fieldErrors.platform})` : ""}</AlertDescription>
        </Alert>
      )}
      {state?.ok && <p className="text-sm text-success sm:col-span-3">{t("connected_ok")}</p>}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm" disabled={pending}>{t("ad_accounts.add")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>{tc("cancel")}</Button>
      </div>
    </form>
  );
}
