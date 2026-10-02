"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Input } from "@hullwise/ui";
import { setMcpKillSwitchAction } from "@/server/actions/mcp";

/** Suspend or restore MCP access for one tenant (audited on the tenant). */
export function KillSwitch({ tenantId, killed }: { tenantId: string; killed: boolean }) {
  const t = useTranslations("admin.mcp");
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const act = (disabled: boolean) =>
    start(async () => {
      await setMcpKillSwitchAction(tenantId, disabled, note);
      setNote("");
      router.refresh();
    });
  if (killed) return <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(false)} data-testid="mcp-restore">{t("restore")}</Button>;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
      <Input size="sm" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={t("note_placeholder")} aria-label={t("note_placeholder")} />
      <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => { if (window.confirm(t("kill_confirm"))) act(true); }} data-testid="mcp-kill">{t("kill")}</Button>
    </div>
  );
}
