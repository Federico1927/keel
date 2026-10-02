"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { DASHBOARD_PERIODS, TENANT_ROLES, type DashboardPeriod, type TenantRole } from "@keel/config";
import { Button, Input, Label, Select, Switch, cn } from "@keel/ui";
import { createDashboardAction, customiseHomeAction, deleteDashboardAction, resetHomeAction, setPersonalDashboardsAction } from "@/server/actions/dashboards";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string } & { data?: unknown }>, then?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "error");
      else if (then) then(r.data);
      else router.refresh();
    });
  return { pending, error, run, router };
}

function ErrorText({ code }: { code: string | null }) {
  const t = useTranslations("dashboards.errors");
  if (!code) return null;
  return <p className="text-xs text-destructive" role="alert">{t.has(code) ? t(code) : t("generic")}</p>;
}

/** Creates the tenant home from Keel's template and opens the editor. */
export function CustomiseHomeButton({ slug }: { slug: string }) {
  const t = useTranslations("dashboards");
  const { pending, error, run, router } = useRun();
  return (
    <>
      <Button size="sm" variant="outline" disabled={pending} data-testid="customise-home" onClick={() => run(() => customiseHomeAction(slug, t("home_name")), (d) => router.push(`/t/${slug}/dashboards/${(d as { id: string }).id}/edit`))}>{t("customise")}</Button>
      <ErrorText code={error} />
    </>
  );
}

export function PeriodLinks({ base, current, keep = {}, path = "" }: { base: string; current: DashboardPeriod; keep?: Record<string, string | undefined>; path?: string }) {
  const t = useTranslations("dashboards.periods");
  const href = (p: string) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, period: p })) if (v) u.set(k, v);
    return `${base}${path}?${u}`;
  };
  return (
    <div className="flex flex-wrap gap-1" data-testid="period-links">
      {DASHBOARD_PERIODS.map((p) => (
        <Link key={p} href={href(p)} className={cn("rounded-full border px-2.5 py-0.5 text-xs", p === current ? "bg-primary text-primary-foreground" : "bg-card")}>{t(p)}</Link>
      ))}
    </div>
  );
}

/** "Preview as role" for managers: the home exactly as that role sees it (role variant, hidden widgets). */
export function PreviewAsSelect({ base, current, draft, path = "" }: { base: string; current: TenantRole | null; draft: boolean; path?: string }) {
  const t = useTranslations("dashboards");
  const tr = useTranslations("roles");
  const router = useRouter();
  return (
    <Select size="sm" aria-label={t("preview_as")} value={current ?? ""} data-testid="preview-as" wrapperClassName="w-44" onChange={(e) => router.push(`${base}${path}?${new URLSearchParams({ ...(e.target.value ? { as: e.target.value } : {}), ...(draft ? { draft: "1" } : {}) })}`)}>
      <option value="">{t("preview_as")}</option>
      {TENANT_ROLES.map((r) => <option key={r} value={r}>{tr(r)}</option>)}
    </Select>
  );
}

export function PreviewBanner({ base, role, draft, name, path = "" }: { base: string; role: TenantRole | null; draft: boolean; name: string | null; path?: string }) {
  const t = useTranslations("dashboards");
  const tr = useTranslations("roles");
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm" data-testid="preview-banner">
      <span>{role ? t("preview_banner", { role: tr(role) }) : null}{role && draft ? " · " : null}{draft ? t("draft_banner") : null}{name ? ` · ${name}` : null}</span>
      <Link href={`${base}${path}`} className="text-xs underline-offset-4 hover:underline">{t("exit_preview")}</Link>
    </div>
  );
}

/** Reset the home to Keel's template (tenant home, or also every role variant). */
export function ResetHomeButton({ slug, scope }: { slug: string; scope: "tenant" | "all" }) {
  const t = useTranslations("dashboards");
  const { pending, error, run } = useRun();
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant="outline" disabled={pending} data-testid={`reset-home-${scope}`} onClick={() => { if (window.confirm(t(scope === "all" ? "reset_all_confirm" : "reset_home_confirm"))) run(() => resetHomeAction(slug, scope)); }}>{t(scope === "all" ? "reset_all" : "reset_home")}</Button>
      <ErrorText code={error} />
    </span>
  );
}

export function PersonalToggle({ slug, enabled }: { slug: string; enabled: boolean }) {
  const t = useTranslations("dashboards");
  const { pending, run } = useRun();
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={enabled} disabled={pending} onCheckedChange={(v: boolean) => run(() => setPersonalDashboardsAction(slug, v))} data-testid="personal-toggle" />
      {t("personal_toggle")}
    </label>
  );
}

/** New extra dashboard, home variant for roles, or (for anyone) a personal copy. */
export function CreateDashboardForm({ slug, scopes }: { slug: string; scopes: ("tenant" | "role" | "personal")[] }) {
  const t = useTranslations("dashboards");
  const tr = useTranslations("roles");
  const { pending, error, run, router } = useRun();
  const [scope, setScope] = useState(scopes[0]!);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<TenantRole[]>([]);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(() => createDashboardAction(slug, { name, scope, roles, fromId: null }), (d) => router.push(`/t/${slug}/dashboards/${(d as { id: string }).id}${scope === "personal" ? "" : "/edit"}`)); }} data-testid="create-dashboard">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="dash-name">{t("name")}</Label><Input id="dash-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></div>
        <div className="space-y-1"><Label htmlFor="dash-scope">{t("kind")}</Label><Select id="dash-scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>{scopes.map((s) => <option key={s} value={s}>{t(`scope_new.${s}`)}</option>)}</Select></div>
      </div>
      {scope !== "personal" && (
        <fieldset className="space-y-1"><legend className="text-sm font-medium">{scope === "role" ? t("roles_variant") : t("roles_visible")}</legend>
          <div className="flex flex-wrap gap-2">{TENANT_ROLES.map((r) => <label key={r} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{tr(r)}</label>)}</div>
          {scope === "tenant" && <p className="text-xs text-muted-foreground">{t("roles_all_hint")}</p>}
        </fieldset>
      )}
      <Button type="submit" size="sm" disabled={pending}>{t("create")}</Button>
      <ErrorText code={error} />
    </form>
  );
}

export function DuplicateButton({ slug, id, name }: { slug: string; id: string | null; name: string }) {
  const t = useTranslations("dashboards");
  const { pending, error, run, router } = useRun();
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant="ghost" disabled={pending} data-testid="duplicate-dashboard" onClick={() => run(() => createDashboardAction(slug, { name: t("copy_of", { name }), scope: "personal", fromId: id }), (d) => router.push(`/t/${slug}/dashboards/${(d as { id: string }).id}`))}>{t("duplicate")}</Button>
      <ErrorText code={error} />
    </span>
  );
}

export function DeleteDashboardButton({ slug, id, back }: { slug: string; id: string; back?: string }) {
  const t = useTranslations("dashboards");
  const { pending, error, run, router } = useRun();
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => { if (window.confirm(t("delete_confirm"))) run(() => deleteDashboardAction(slug, id), () => (back ? router.push(back) : router.refresh())); }}>{t("delete")}</Button>
      <ErrorText code={error} />
    </span>
  );
}
