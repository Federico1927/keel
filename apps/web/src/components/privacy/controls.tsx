"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label } from "@hullwise/ui";
import { eraseCustomerAction, requestCustomerDataExportAction } from "@/server/actions/privacy";
import { eraseCustomerAsAdminAction, findCustomerForErasureAction, rebuildCustomerExportAction, type ErasureCandidate } from "@/server/actions/admin-privacy";

type Report = { orders: number; returns: number; messages: number; browserLinks: number; webhookPayloads: number; conversionPayloads: number; riskProfiles: number; surveyAnswers: number };

/** The customer's data package (GDPR access request), built in the background; the list below the button shows it. */
export function CustomerExportButton({ slug, customerId, disabled }: { slug: string; customerId: string; disabled?: boolean }) {
  const t = useTranslations("privacy");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" disabled={pending || disabled} data-testid="customer-export" onClick={() => start(async () => {
        setError(false);
        const r = await requestCustomerDataExportAction(slug, customerId);
        if (!r.ok) setError(true);
        router.refresh();
      })}>{pending ? t("export.requesting") : t("export.request")}</Button>
      {error && <p className="text-xs text-destructive" role="alert">{t("export.error")}</p>}
    </div>
  );
}

/**
 * Erasure of one customer's personal data after typing what identifies them (their email): the same erasure
 * as the store platform's own request. From the customer page (owner, admin) or the console (super-admin).
 */
export function EraseCustomerButton({ mode, target, customerId, expected, onDone }: { mode: "tenant" | "admin"; target: string; customerId: string; expected: string; onDone?: (r: Report) => void }) {
  const t = useTranslations("privacy");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, start] = useTransition();
  const matches = value.trim().toLowerCase() === expected.trim().toLowerCase();
  const run = () => start(async () => {
    setError(null);
    const r = mode === "tenant" ? await eraseCustomerAction(target, customerId, value) : await eraseCustomerAsAdminAction(target, customerId, value);
    if (!r.ok) return setError(r.error === "confirmation_mismatch" ? t("erase.mismatch") : r.error === "forbidden" ? t("erase.forbidden") : t("erase.error"));
    setReport(r.data!);
    onDone?.(r.data!);
    router.refresh();
  });
  if (report) return <p className="rounded-md bg-muted px-3 py-2 text-sm" role="status" data-testid="erase-result">{t("erase.done", { orders: report.orders, returns: report.returns, messages: report.messages, links: report.browserLinks + report.webhookPayloads + report.conversionPayloads })}</p>;
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(null); setValue(""); }}>
      <DialogTrigger asChild><Button variant="destructive" size="sm" data-testid="erase-customer">{t("erase.button")}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("erase.title")}</DialogTitle>
          <DialogDescription>{t("erase.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`erase-confirm-${customerId}`}>{t("erase.type", { value: expected })}</Label>
          <Input id={`erase-confirm-${customerId}`} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} data-testid="erase-confirm-input" />
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
          <Button variant="destructive" disabled={pending || !matches} onClick={run} data-testid="erase-confirm">{pending ? t("erase.running") : t("erase.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Console: find a tenant's customer by email, then erase them (typed confirmation of the email). */
export function AdminEraseCustomer({ tenantId }: { tenantId: string }) {
  const t = useTranslations("privacy");
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<ErasureCandidate[] | null>(null);
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); start(async () => { setError(false); const r = await findCustomerForErasureAction(tenantId, email); if (!r.ok) { setFound(null); setError(true); } else setFound(r.data ?? []); }); }}>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="admin-erase-email">{t("console.email")}</Label>
          <Input id="admin-erase-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" data-testid="admin-erase-email" />
        </div>
        <Button type="submit" variant="outline" disabled={pending || !email.includes("@")} data-testid="admin-erase-find">{t("console.find")}</Button>
      </form>
      {error && <p className="text-xs text-destructive" role="alert">{t("console.invalid")}</p>}
      {found && found.length === 0 && <p className="text-sm text-muted-foreground" data-testid="admin-erase-none">{t("console.none")}</p>}
      {found && found.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {found.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-2" data-testid="admin-erase-candidate">
              <span className="min-w-0"><span className="font-medium">{c.name ?? c.email}</span><span className="block text-xs text-muted-foreground">{t("console.candidate", { orders: c.ordersCount, id: c.externalId ?? c.id.slice(0, 8) })}</span></span>
              <EraseCustomerButton mode="admin" target={tenantId} customerId={c.id} expected={c.email ?? email} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Console task of a data request whose package expired or failed: builds a new one. */
export function RebuildCustomerExportButton({ alertId }: { alertId: string }) {
  const t = useTranslations("privacy");
  const router = useRouter();
  const [pending, start] = useTransition();
  return <Button variant="outline" size="sm" disabled={pending} data-testid="rebuild-customer-export" onClick={() => start(async () => { await rebuildCustomerExportAction(alertId); router.refresh(); })}>{t("task.rebuild")}</Button>;
}
