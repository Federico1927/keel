"use client";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { NOTIFICATION_CHANNELS } from "@keel/config";
import { Button, Card, CardContent, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@keel/ui";
import type { PreferenceRow } from "@keel/services";
import { resetPreferencesAction, setPreferenceAction } from "@/server/actions/notifications";

const GROUPS = ["collaboration", "operations", "system"] as const;

export function PreferencesMatrix({ slug, rows }: { slug: string; rows: PreferenceRow[] }) {
  const t = useTranslations("notifications");
  const [pending, start] = useTransition();
  return (
    <div className={cn("space-y-4", pending && "opacity-70")}>
      {GROUPS.map((g) => {
        const items = rows.filter((r) => r.group === g);
        if (!items.length) return null;
        return (
          <Card key={g}>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(`groups.${g}`)}</TableHead>
                    {NOTIFICATION_CHANNELS.map((c) => (
                      <TableHead key={c} className="w-20 text-center">{t(`channels.${c}`)}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((r) => (
                    <TableRow key={r.type} data-testid={`pref-${r.type}`}>
                      <TableCell className="text-sm">{t(`types.${r.type}`)}</TableCell>
                      {NOTIFICATION_CHANNELS.map((c) => {
                        const cell = r.channels[c];
                        return (
                          <TableCell key={c} className="text-center">
                            {cell.allowed ? (
                              <Switch
                                checked={cell.enabled}
                                disabled={pending}
                                aria-label={`${t(`types.${r.type}`)} · ${t(`channels.${c}`)}`}
                                title={cell.isDefault ? t("preferences.default_hint") : t("preferences.custom_hint")}
                                data-testid={`pref-${r.type}-${c}`}
                                onCheckedChange={(v) => start(async () => void (await setPreferenceAction(slug, r.type, c, v)))}
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground" title={t("preferences.not_available")}>—</span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
        <p className="text-xs text-muted-foreground">{t("preferences.slack_hint")}</p>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => void (await resetPreferencesAction(slug)))}>{t("preferences.reset")}</Button>
      </div>
    </div>
  );
}
