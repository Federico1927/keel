"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { MoreHorizontal } from "lucide-react";
import { INTEGRATION_SETUP } from "@hullwise/config";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, cn } from "@hullwise/ui";
import { runIntegrationCardOp, type CardOutcome } from "@/server/actions/integration-card";
import { IntegrationSetupError, IntegrationSetupVerified } from "@/components/integration-setup";

/** What every provider card shows (#90): one structure for all, built on the server from the integration row. */
export interface IntegrationCardData {
  provider: string;
  title: string;
  /** connected | error | syncing | not_connected | locked */
  status: string;
  statusLabel: string;
  /** "Mock" / "Live", shown as muted text; null on a locked card. */
  modeLabel: string | null;
  /** The linked account, or what the integration does when it is not connected. */
  subtitle: string;
  lastSync: string;
  lastSuccess: string;
  lastError: string | null;
  connected: boolean;
  canManage: boolean;
  /** The guide page ("How to connect"); null on a locked card. */
  guideHref: string | null;
  /** Mock-only simulations in the overflow menu (kinds of `CARD_SIMULATIONS`). */
  simulations: readonly string[];
  /** Test connection is offered (a connected provider the viewer manages). */
  testable: boolean;
  /** Open the sheet on load (an error back from an OAuth redirect, accounts to pick, `?setup=<provider>`). */
  openOnLoad?: boolean;
  locked?: boolean;
}

const VARIANT: Record<string, "success" | "destructive" | "warning" | "muted"> = { connected: "success", ok: "success", error: "destructive", syncing: "warning" };
/** Label keys of the simulations (root namespace). */
const SIMULATION_LABELS: Record<string, string> = {
  "shopify:order": "integrations.simulate_order",
  "shopify:cancel": "integrations.simulate_cancel",
  "shopify:return": "integrations.simulate_return",
  "shopify:bad_signature": "integrations.simulate_bad",
  "subscriptions:renewal": "subscriptions.provider.simulate_success",
  "subscriptions:renewal_declined": "subscriptions.provider.simulate_failure",
  "accounting:failure": "accounting.connection.simulate_failure",
};
/** Namespaces an action's error code is looked up in, in order. */
const ERROR_NAMESPACES = ["integrations.errors", "ga4.card.errors", "subscriptions.errors", "accounting.errors", "common.errors"];

interface CardState {
  slug: string;
  provider: string;
  pending: boolean;
  /** Runs a card operation and shows its outcome (in the card, or in the sheet while it is open). */
  run: (op: string) => void;
  /** Shows the outcome of an action run elsewhere (the setup sheet's demo connect). */
  show: (o: CardOutcome) => void;
  start: (fn: () => Promise<void>) => void;
}
const IntegrationCardContext = createContext<CardState | null>(null);
export function useIntegrationCard(): CardState {
  const c = useContext(IntegrationCardContext);
  if (!c) throw new Error("useIntegrationCard outside an IntegrationCard");
  return c;
}

/** The outcome of the last card operation: messages, or the guide's plain-words error, and what was verified. */
function Outcome({ provider, outcome }: { provider: string; outcome: CardOutcome }) {
  const t = useTranslations();
  const text = [
    ...outcome.messages.map((m) => (t.has(m.key) ? t(m.key, m.values ?? {}) : m.key)),
    ...(outcome.error ? [`${ERROR_NAMESPACES.map((ns) => `${ns}.${outcome.error!.code}`).filter((k) => t.has(k)).map((k) => t(k))[0] ?? outcome.error.code}${outcome.error.detail ? ` (${outcome.error.detail})` : ""}`] : []),
  ].join(" ");
  const setupGuide = outcome.setup ? INTEGRATION_SETUP[outcome.setup.guide] : null;
  const verifiedGuide = outcome.verified ? INTEGRATION_SETUP[outcome.verified.guide] : null;
  return (
    <div className="space-y-2">
      {text && <Alert variant={outcome.ok ? "default" : "destructive"}><AlertDescription data-testid={`msg-${provider}`} className="[overflow-wrap:anywhere]">{text}</AlertDescription></Alert>}
      {setupGuide && outcome.setup && <IntegrationSetupError guide={setupGuide} code={outcome.setup.code} values={{}} detail={outcome.setup.detail} />}
      {verifiedGuide && outcome.verified && <IntegrationSetupVerified guide={verifiedGuide} facts={outcome.verified.facts} />}
    </div>
  );
}

/**
 * The integration card (#90): every provider renders through this one component. Header on one line
 * (name, one status pill), the account or what it does, the same three meta rows, and a footer pinned
 * to the bottom: Connect (not connected) or Manage + Test connection (connected), the guide link, and —
 * in mock mode only — a "…" menu with the simulations. Connect and Manage open the provider's sheet
 * (`sheet`: setup checklist, status, health, Resync), a bottom sheet on phones and a drawer on desktop.
 */
export function IntegrationCard({ slug, data, sheet, sheetTitle }: { slug: string; data: IntegrationCardData; sheet?: ReactNode; sheetTitle?: string }) {
  const t = useTranslations("integrations");
  const tr = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(!!data.openOnLoad && !data.locked);
  const [outcome, setOutcome] = useState<CardOutcome | null>(null);
  const p = data.provider;
  const start = (fn: () => Promise<void>) => startTransition(async () => { await fn(); router.refresh(); });
  const state: CardState = { slug, provider: p, pending, run: (op) => start(async () => setOutcome(await runIntegrationCardOp(slug, p, op))), show: setOutcome, start };
  const variant = data.locked ? "muted" : (VARIANT[data.status] ?? "muted");
  return (
    <IntegrationCardContext.Provider value={state}>
      <Card data-testid={`provider-${p}`} data-status={data.status} data-locked={data.locked ? "true" : undefined} className={cn("flex h-full min-w-0 flex-col", data.locked && "border-dashed")}>
        <CardHeader className="space-y-1 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="min-w-0 flex-1 truncate text-base" title={data.title}>{data.title}</CardTitle>
            <Badge variant={variant} className="shrink-0" data-testid={`${p}-status`}>{data.statusLabel}</Badge>
          </div>
          <CardDescription className="flex min-w-0 items-center gap-1.5 text-xs">
            {data.modeLabel && <><span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", data.modeLabel === t("mode.live") ? "bg-success" : "bg-muted-foreground/50")} /><span className="shrink-0" data-testid={`${p}-mode`}>{data.modeLabel}</span><span aria-hidden>·</span></>}
            <span className="min-w-0 truncate" title={data.subtitle}>{data.subtitle}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3 text-sm">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs [&_dd]:truncate">
            <dt className="text-muted-foreground">{t("last_sync")}</dt><dd>{data.lastSync}</dd>
            <dt className="text-muted-foreground">{t("last_success")}</dt><dd>{data.lastSuccess}</dd>
            <dt className="text-muted-foreground">{t("last_error")}</dt><dd className={data.lastError ? "text-destructive" : ""} title={data.lastError ?? undefined} data-testid={`${p}-last-error`}>{data.lastError ?? "—"}</dd>
          </dl>
          {outcome && !open && <Outcome provider={p} outcome={outcome} />}
          {!data.locked && (
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              {data.canManage && sheet && (
                <Button size="sm" variant={data.connected ? "outline" : "default"} onClick={() => setOpen(true)} data-testid={`${p}-${data.connected ? "manage" : "connect-open"}`}>
                  {data.connected ? t("card.manage") : t("connect")}
                </Button>
              )}
              {data.testable && <Button size="sm" variant="ghost" disabled={pending} onClick={() => state.run("test")} data-testid={`${p}-test`}>{t("test_connection")}</Button>}
              <span className="ml-auto flex items-center gap-1">
                {data.guideHref && <Link href={data.guideHref} className="text-xs underline-offset-4 hover:underline">{t("open_guide")}</Link>}
                {data.canManage && data.simulations.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11" aria-label={t("card.more")} data-testid={`${p}-simulate-menu`} disabled={pending}><MoreHorizontal className="size-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>{t("card.simulate")}</DropdownMenuLabel>
                      {data.simulations.map((k) => (
                        <DropdownMenuItem key={k} onSelect={() => state.run(`simulate:${k}`)} data-testid={k === "return" ? "simulate-return" : `simulate-${p}-${k}`}>
                          {tr(SIMULATION_LABELS[`${p}:${k}`] ?? "integrations.card.simulate")}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
      {sheet && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent side="sheet" closeLabel={t("card.close")} data-testid="integration-sheet" data-provider={p}>
            <DialogHeader className="pr-8">
              <DialogTitle className="flex items-center gap-2">{sheetTitle ?? data.title}<Badge variant={variant}>{data.statusLabel}</Badge></DialogTitle>
              <DialogDescription>{data.modeLabel ? `${data.modeLabel} · ` : ""}{data.subtitle}</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-4 text-sm">
              {outcome && open && <Outcome provider={p} outcome={outcome} />}
              {sheet}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </IntegrationCardContext.Provider>
  );
}

/**
 * The status part of a provider's Manage sheet: the meta rows, the plain-words last error, health
 * sources and the sheet actions (Resync, Disconnect) through the shared card operations.
 */
export function IntegrationSheetStatus({ rows, health, actions, children }: { rows: { label: string; value: string; testId?: string; tone?: "error" }[]; health?: { source: string; status: string; statusLabel: string; detail?: string | null }[]; actions: ("resync" | "disconnect")[]; children?: ReactNode }) {
  const t = useTranslations("integrations");
  const card = useIntegrationCard();
  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="integration-sheet-status">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs [&_dd]:break-words">
        {rows.map((r) => <div key={r.label} className="contents"><dt className="text-muted-foreground">{r.label}</dt><dd className={r.tone === "error" ? "text-destructive" : ""} data-testid={r.testId}>{r.value}</dd></div>)}
      </dl>
      {children}
      {health && health.length > 0 && (
        <ul className="space-y-1 text-xs" data-testid="integration-health">
          {health.map((h) => <li key={h.source} className="flex min-w-0 items-center justify-between gap-2"><span className="shrink-0 font-mono">{h.source}</span><span className="flex min-w-0 items-center justify-end gap-2">{h.detail && <span className="min-w-0 truncate text-muted-foreground" title={h.detail}>{h.detail}</span>}<Badge variant={VARIANT[h.status] ?? (h.status === "stale" ? "destructive" : "warning")}>{h.statusLabel}</Badge></span></li>)}
        </ul>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.includes("resync") && <Button size="sm" variant="outline" disabled={card.pending} onClick={() => card.run("resync")} data-testid={`${card.provider}-resync`}>{t("resync")}</Button>}
          {actions.includes("disconnect") && <Button size="sm" variant="ghost" disabled={card.pending} onClick={() => card.run("disconnect")} data-testid={`${card.provider}-disconnect`}>{t("disconnect")}</Button>}
        </div>
      )}
    </section>
  );
}
