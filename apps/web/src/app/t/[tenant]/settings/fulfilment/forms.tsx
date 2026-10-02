"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { SHIPMENT_STATUSES } from "@keel/core";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@keel/ui";
import { deleteMappingAction, saveFulfilmentSettingsAction, saveMappingAction } from "@/server/actions/fulfilment";
import type { ActionResult } from "@/server/action-result";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export function ClockForm({ slug, canEdit, timezone, values }: { slug: string; canEdit: boolean; timezone: string; values: { lateToShipBusinessDays: number; workdays: number[]; carrierInstructionEmail: string | null } }) {
  const t = useTranslations("settings_fulfilment");
  const router = useRouter();
  const [days, setDays] = useState(String(values.lateToShipBusinessDays));
  const [workdays, setWorkdays] = useState<number[]>(values.workdays);
  const [email, setEmail] = useState(values.carrierInstructionEmail ?? "");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("clock_title")}</CardTitle>
        <CardDescription>{t("clock_description", { tz: timezone })}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await saveFulfilmentSettingsAction(slug, { lateToShipBusinessDays: Number(days), workdays, carrierInstructionEmail: email.trim() || null });
              setResult(r);
              if (r.ok) router.refresh();
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="late-days">{t("threshold")}</Label>
              <Input id="late-days" type="number" min={0} max={30} value={days} disabled={!canEdit} onChange={(e) => setDays(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="carrier-email">{t("carrier_email")}</Label>
              <Input id="carrier-email" type="email" value={email} disabled={!canEdit} maxLength={200} onChange={(e) => setEmail(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("carrier_email_hint")}</p>
            </div>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t("workdays")}</legend>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={workdays.includes(d)} disabled={!canEdit} onCheckedChange={(v) => setWorkdays(v === true ? [...workdays, d].sort() : workdays.filter((x) => x !== d))} aria-label={t(`weekdays.${d}`)} />
                  {t(`weekdays.${d}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {result && (result.ok ? <p className="text-sm text-success">{t("saved")}</p> : <Alert variant="destructive"><AlertDescription>{t(`errors.${result.error}`)}</AlertDescription></Alert>)}
          {canEdit && <Button type="submit" disabled={pending || workdays.length === 0}>{t("save")}</Button>}
        </form>
      </CardContent>
    </Card>
  );
}

interface MappingRow {
  id: string;
  source: string;
  externalStatus: string;
  canonicalStatus: string;
  isException: boolean;
  isFinal: boolean;
}

export function MappingEditor({ slug, canEdit, rows, unmapped }: { slug: string; canEdit: boolean; rows: MappingRow[]; unmapped: { source: string; externalStatus: string; count: number }[] }) {
  const t = useTranslations("settings_fulfilment");
  const ts = useTranslations("shipment_status");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Omit<MappingRow, "id">>({ source: "shopify", externalStatus: "", canonicalStatus: "in_transit", isException: false, isFinal: false });
  const save = (row: Omit<MappingRow, "id"> & { id?: string }) =>
    start(async () => {
      const r = await saveMappingAction(slug, row);
      setError(r.ok ? null : r.error);
      if (r.ok && !row.id) setDraft({ ...draft, externalStatus: "" });
      router.refresh();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("mappings_title")}</CardTitle>
        <CardDescription>{t("mappings_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <Table data-testid="mapping-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t("source")}</TableHead>
                <TableHead>{t("external_status")}</TableHead>
                <TableHead>{t("canonical")}</TableHead>
                <TableHead>{t("exception")}</TableHead>
                <TableHead>{t("final")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} data-testid="mapping-row" data-external={r.externalStatus}>
                  <TableCell className="text-sm">{r.source}</TableCell>
                  <TableCell className="font-mono text-xs">{r.externalStatus}</TableCell>
                  <TableCell>
                    <Select aria-label={t("canonical")} value={r.canonicalStatus} disabled={!canEdit || pending} onChange={(e) => save({ ...r, canonicalStatus: e.target.value })} size="sm">
                      {SHIPMENT_STATUSES.map((s) => <option key={s} value={s}>{ts(s)}</option>)}
                    </Select>
                  </TableCell>
                  <TableCell><Checkbox checked={r.isException} disabled={!canEdit || pending} onCheckedChange={(v) => save({ ...r, isException: v === true })} aria-label={t("exception")} /></TableCell>
                  <TableCell><Checkbox checked={r.isFinal} disabled={!canEdit || pending} onCheckedChange={(v) => save({ ...r, isFinal: v === true })} aria-label={t("final")} /></TableCell>
                  <TableCell className="text-right">
                    {canEdit && (
                      <Button variant="ghost" size="icon" aria-label={t("delete")} disabled={pending} onClick={() => start(async () => { const r2 = await deleteMappingAction(slug, r.id); setError(r2.ok ? null : r2.error); router.refresh(); })}>
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {canEdit && (
          <form className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_10rem_auto_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); save(draft); }} data-testid="mapping-new">
            <div className="space-y-1"><Label htmlFor="m-source">{t("source")}</Label><Input id="m-source" value={draft.source} maxLength={40} onChange={(e) => setDraft({ ...draft, source: e.target.value })} /></div>
            <div className="space-y-1"><Label htmlFor="m-ext">{t("external_status")}</Label><Input id="m-ext" value={draft.externalStatus} maxLength={80} onChange={(e) => setDraft({ ...draft, externalStatus: e.target.value })} /></div>
            <div className="space-y-1">
              <Label htmlFor="m-canonical">{t("canonical")}</Label>
              <Select id="m-canonical" value={draft.canonicalStatus} onChange={(e) => setDraft({ ...draft, canonicalStatus: e.target.value })}>
                {SHIPMENT_STATUSES.map((s) => <option key={s} value={s}>{ts(s)}</option>)}
              </Select>
            </div>
            <label className="flex items-center gap-1.5 pb-2 text-sm"><Checkbox checked={draft.isException} onCheckedChange={(v) => setDraft({ ...draft, isException: v === true })} aria-label={t("exception")} />{t("exception")}</label>
            <label className="flex items-center gap-1.5 pb-2 text-sm"><Checkbox checked={draft.isFinal} onCheckedChange={(v) => setDraft({ ...draft, isFinal: v === true })} aria-label={t("final")} />{t("final")}</label>
            <Button type="submit" disabled={pending || !draft.externalStatus.trim()} data-testid="mapping-add"><Plus /> {t("add")}</Button>
          </form>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{t(`errors.${error}`)}</AlertDescription></Alert>}
        {unmapped.length > 0 && (
          <div className="text-sm">
            <p className="font-medium">{t("unmapped_title")}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {unmapped.map((u) => (
                <button key={`${u.source}:${u.externalStatus}`} type="button" disabled={!canEdit} className="rounded-full border bg-card px-2 py-0.5 font-mono text-xs hover:bg-muted" onClick={() => setDraft({ ...draft, source: u.source, externalStatus: u.externalStatus })}>
                  {u.source}:{u.externalStatus} ({u.count})
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
