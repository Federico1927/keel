"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RefreshCw, Trash2 } from "lucide-react";
import { AUDIENCE_PROVIDERS } from "@hullwise/integrations/types";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DataList, Input, Label, Select } from "@hullwise/ui";
import { addDestinationAction, removeDestinationAction, setDestinationAutoSyncAction, setSegmentLiveAction, syncDestinationAction } from "@/server/actions/destinations";

export interface DestinationRow {
  id: string;
  provider: string;
  audienceName: string;
  autoSync: boolean;
  status: string;
  memberCount: number;
  lastSyncAt: string | null;
  lastAdded: number;
  lastRemoved: number;
  lastError: string | null;
}

/** Live updates and audience destinations of one segment. */
export function SegmentSyncCard({ slug, segmentId, segmentName, live, destinations, canWrite, canPush, holdoutExcluded }: { slug: string; segmentId: string; segmentName: string; live: boolean; destinations: DestinationRow[]; canWrite: boolean; canPush: boolean; holdoutExcluded: boolean }) {
  const t = useTranslations("destinations");
  const tc = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>(AUDIENCE_PROVIDERS[0]);
  const [name, setName] = useState(segmentName);
  const [autoSync, setAutoSync] = useState(true);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "error");
      else {
        setError(null);
        router.refresh();
      }
    });
  return (
    <Card className="mt-6" data-testid="segment-sync">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{holdoutExcluded ? t("description_holdout") : t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={live} disabled={!canWrite || pending} onChange={(e) => act(() => setSegmentLiveAction(slug, segmentId, e.target.checked))} data-testid="live-toggle" />
          <span>
            <span className="font-medium">{t("live")}</span>
            <span className="block text-xs text-muted-foreground">{t("live_help")}</span>
          </span>
        </label>
        {error && <p className="text-sm text-destructive">{tc.has(`errors.${error}`) ? tc(`errors.${error}`) : t(`errors.${error}`)}</p>}
        {destinations.length > 0 && (
          <DataList
            rows={destinations}
            rowKey={(d) => d.id}
            rowProps={() => ({ "data-testid": "destination-row" })}
            columns={[
              { key: "destination", header: t("columns.destination"), mobile: "title", cell: (d) => <><div className="font-medium">{d.audienceName}</div><div className="flex flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground">{t(`providers.${d.provider}`)} <Badge variant="muted">{t("mock")}</Badge><Badge variant={d.status === "ok" ? "success" : d.status === "error" ? "destructive" : "outline"}>{t(`status.${d.status}`)}</Badge></div>{d.lastError && <div className="text-xs font-normal text-destructive">{d.lastError}</div>}</> },
              { key: "members", header: t("columns.members"), mobile: "badge", align: "right", className: "tabular", cell: (d) => <span data-testid="destination-members">{d.memberCount}</span> },
              { key: "last", header: t("columns.last_sync"), label: "", className: "text-xs", cell: (d) => (d.lastSyncAt ? t("last_sync", { at: new Date(d.lastSyncAt).toLocaleString(), added: d.lastAdded, removed: d.lastRemoved }) : "—") },
              { key: "auto", header: t("columns.auto"), cell: (d) => <input type="checkbox" className="h-4 w-4 align-middle" aria-label={t("columns.auto")} checked={d.autoSync} disabled={!canPush || pending} onChange={(e) => act(() => setDestinationAutoSyncAction(slug, segmentId, d.id, e.target.checked))} /> },
              { key: "actions", header: <span className="sr-only">{t("sync")}</span>, mobile: "action", cell: (d) => canPush && <span className="flex justify-end gap-1"><Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => syncDestinationAction(slug, segmentId, d.id))}><RefreshCw /> {t("sync")}</Button><Button size="sm" variant="ghost" disabled={pending} aria-label={tc("delete")} onClick={() => act(() => removeDestinationAction(slug, segmentId, d.id))}><Trash2 /></Button></span> },
            ]}
          />
        )}
        {canPush && (
          <form className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[12rem_1fr_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); act(() => addDestinationAction(slug, segmentId, { provider, audienceName: name, autoSync })); }}>
            <div className="space-y-1">
              <Label htmlFor="dest-provider">{t("fields.provider")}</Label>
              <Select id="dest-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {AUDIENCE_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{t(`providers.${p}`)}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dest-name">{t("fields.audience_name")}</Label>
              <Input id="dest-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} /> {t("fields.auto_sync")}
            </label>
            <Button type="submit" disabled={pending || !name.trim()}>{t("add")}</Button>
          </form>
        )}
        <p className="text-xs text-muted-foreground">{t("privacy_note")}</p>
      </CardContent>
    </Card>
  );
}
