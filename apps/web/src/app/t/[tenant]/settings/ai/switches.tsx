"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Label, Switch } from "@keel/ui";
import { updateMcpSettings } from "@/server/actions/mcp";

/** Tenant switches of the MCP server: on/off and full PII exposure. */
export function McpSwitches({ slug, mcpEnabled, mcpFullPii, disabled }: { slug: string; mcpEnabled: boolean; mcpFullPii: boolean; disabled: boolean }) {
  const t = useTranslations("mcp.settings");
  const te = useTranslations("mcp.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const save = (next: { mcpEnabled: boolean; mcpFullPii: boolean }) =>
    start(async () => {
      const r = await updateMcpSettings(slug, next);
      setError(r.ok ? null : te.has(r.error) ? te(r.error) : te("generic"));
      router.refresh();
    });
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="mcp-enabled">{t("enabled")}</Label>
          <p className="text-xs text-muted-foreground">{t("enabled_hint")}</p>
        </div>
        <Switch id="mcp-enabled" checked={mcpEnabled} disabled={disabled || pending} onCheckedChange={(v) => save({ mcpEnabled: v, mcpFullPii })} data-testid="mcp-enabled-switch" />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="mcp-pii">{t("full_pii")}</Label>
          <p className="text-xs text-muted-foreground">{t("full_pii_hint")}</p>
        </div>
        <Switch id="mcp-pii" checked={mcpFullPii} disabled={disabled || pending} onCheckedChange={(v) => save({ mcpEnabled, mcpFullPii: v })} data-testid="mcp-pii-switch" />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
