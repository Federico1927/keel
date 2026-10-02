"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MOBILE_NAV_SLOTS } from "@hullwise/config";
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Select } from "@hullwise/ui";
import { updateMobileNavAction } from "@/server/actions/settings";
import type { ActionResult } from "@/server/action-result";

export function MobileNavForm({ slug, canEdit, destinations, roles }: { slug: string; canEdit: boolean; destinations: { key: string; label: string }[]; roles: { role: string; label: string; defaults: string; value: string[] }[] }) {
  const t = useTranslations("mobile.settings");
  const tc = useTranslations("common");
  const router = useRouter();
  const [choice, setChoice] = useState<Record<string, string[]>>(Object.fromEntries(roles.map((r) => [r.role, Array.from({ length: MOBILE_NAV_SLOTS }, (_, i) => r.value[i] ?? "")])));
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await updateMobileNavAction(slug, Object.fromEntries(Object.entries(choice).map(([k, v]) => [k, v.filter(Boolean)])));
          setResult(r);
          if (r.ok) router.refresh();
        });
      }}
      data-testid="mobile-nav-form"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {roles.map((r) => (
          <Card key={r.role}>
            <CardHeader>
              <CardTitle>{r.label}</CardTitle>
              <CardDescription>{t("role_hint", { list: r.defaults })}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              {choice[r.role]!.map((v, i) => (
                <div key={i} className="space-y-1">
                  <Label htmlFor={`nav-${r.role}-${i}`} className="text-xs">{t("slot", { n: i + 1 })}</Label>
                  <Select id={`nav-${r.role}-${i}`} value={v} disabled={!canEdit} onChange={(e) => setChoice({ ...choice, [r.role]: choice[r.role]!.map((x, j) => (j === i ? e.target.value : x)) })} data-testid={`nav-${r.role}-${i}`}>
                    <option value="">{t("use_default")}</option>
                    {destinations.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </Select>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      {result && !result.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${result.error}`)}</AlertDescription></Alert>}
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>{t("save")}</Button>
          {result?.ok && <span className="text-sm text-success" role="status">{t("saved")}</span>}
        </div>
      )}
    </form>
  );
}
