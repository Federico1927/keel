"use client";
import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bookmark, ChevronDown, Download, Trash2, Users } from "lucide-react";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, Label, cn } from "@hullwise/ui";
import { canonicalQuery } from "@hullwise/core";
import type { SavedView } from "@hullwise/services";
import { deleteViewAction, saveViewAction } from "@/server/actions/lists";

export function ListToolbarClient({ slug, list, basePath, views, canExport, exportHref, canManageShared }: { slug: string; list: string; basePath: string; views: SavedView[]; canExport: boolean; exportHref: string; canManageShared: boolean }) {
  const t = useTranslations("lists");
  const tc = useTranslations("common");
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const current = canonicalQuery(Object.fromEntries(sp.entries()));
  // several views can hold the same filters: the one just saved wins, then the user's own
  const matching = views.filter((v) => v.query === current);
  const active = matching.find((v) => v.id === savedId) ?? matching.find((v) => v.mine) ?? matching[0] ?? null;

  const save = () =>
    start(async () => {
      const r = await saveViewAction(slug, { list, name, query: current, isShared: shared });
      if (!r.ok) return setError(tc.has(`errors.${r.error}`) ? tc(`errors.${r.error}`) : r.error);
      setSavedId(r.data?.id ?? null);
      setOpen(false);
      setName("");
      setError(null);
      router.refresh();
    });
  const remove = (id: string) =>
    start(async () => {
      const r = await deleteViewAction(slug, id);
      if (r.ok) router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="list-toolbar">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-[16rem]" data-testid="views-menu">
            <Bookmark /> <span className="truncate">{active ? active.name : t("views.label")}</span> <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem onSelect={() => router.push(basePath)}>{t("views.all")}</DropdownMenuItem>
          {views.length > 0 && <DropdownMenuSeparator />}
          {views.length === 0 && <DropdownMenuLabel className="font-normal">{t("views.empty")}</DropdownMenuLabel>}
          {views.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => router.push(v.query ? `${basePath}?${v.query}` : basePath)} className={cn("justify-between", active?.id === v.id && "font-medium")} data-testid="view-item">
              <span className="flex min-w-0 items-center gap-2">
                {v.isShared && <Users className="text-muted-foreground" aria-label={t("views.shared")} />}
                <span className="truncate">{v.name}</span>
              </span>
              {(v.mine || (v.isShared && canManageShared)) && (
                <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" aria-label={t("views.delete", { name: v.name })} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); e.preventDefault(); remove(v.id); }} disabled={pending}>
                  <Trash2 />
                </button>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { setName(active?.mine ? active.name : ""); setShared(active?.isShared ?? false); setError(null); setOpen(true); }} data-testid="save-view">
            {t("views.save")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canExport && (
        <Button asChild variant="outline" size="sm">
          <a href={current ? `${exportHref}?${current}` : exportHref} data-testid="export-csv"><Download /> {t("export_csv")}</a>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("views.save_title")}</DialogTitle>
            <DialogDescription>{t("views.save_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="view-name">{t("views.name")}</Label>
              <Input id="view-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={shared} onCheckedChange={(v) => setShared(Boolean(v))} data-testid="view-shared" /> {t("views.share")}</label>
            <p className="break-all rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{current || t("views.no_filters")}</p>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
            <Button disabled={pending || !name.trim()} onClick={save} data-testid="save-view-confirm">{tc("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
