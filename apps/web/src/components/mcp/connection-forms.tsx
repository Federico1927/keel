"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label, Select } from "@hullwise/ui";
import { MCP_PAT_DAYS, MCP_SCOPES } from "@hullwise/config";
import type { ActionResult } from "@/server/action-result";
import { createMcpTokenAction, revokeMcpTokenAction, rotateMcpTokenAction } from "@/server/actions/mcp";
import { CopyField } from "./copy-field";
import { ConfirmButton } from "../confirm-button";

/** The secret, once: it is never shown again (only its HMAC is stored). */
function ShownOnce({ token }: { token: string }) {
  const t = useTranslations("mcp.connections");
  return (
    <Alert variant="warning" data-testid="mcp-token-once">
      <AlertDescription className="space-y-2">
        <p className="font-medium">{t("shown_once")}</p>
        <CopyField value={token} testId="mcp-token-value" />
      </AlertDescription>
    </Alert>
  );
}

export function CreateTokenForm({ slug }: { slug: string }) {
  const t = useTranslations("mcp.connections");
  const ts = useTranslations("mcp.scopes");
  const te = useTranslations("mcp.errors");
  const [state, action, pending] = useActionState<ActionResult<{ token: string; expiresAt: string }> | null, FormData>(createMcpTokenAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="mcp-create-token">
      <h4 className="text-sm font-semibold">{t("create_title")}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-token-name">{t("token_name")}</Label>
          <Input id="mcp-token-name" name="name" required maxLength={60} placeholder={t("token_name_placeholder")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mcp-token-days">{t("expires_in")}</Label>
          <Select id="mcp-token-days" name="days" defaultValue="90">
            {MCP_PAT_DAYS.map((d) => (
              <option key={d} value={d}>{t("days", { days: d })}</option>
            ))}
          </Select>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("scopes")}</legend>
        {MCP_SCOPES.map((s) => (
          <label key={s} className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="scopes" value={s} defaultChecked={s === "read"} disabled={s === "read"} className="mt-1" data-testid={`mcp-pat-scope-${s}`} />
            {s === "read" && <input type="hidden" name="scopes" value="read" />}
            <span><span className="font-mono text-xs">{s}</span> <span className="text-muted-foreground">— {ts(s.replace(":", "_"))}</span></span>
          </label>
        ))}
      </fieldset>
      {state && !state.ok && (
        <Alert variant="destructive">
          <AlertDescription>{te.has(state.error) ? te(state.error) : te("generic")}</AlertDescription>
        </Alert>
      )}
      {state?.ok && state.data && <ShownOnce token={state.data.token} />}
      <Button type="submit" disabled={pending} data-testid="mcp-create-token-submit">{t("create")}</Button>
    </form>
  );
}

export function TokenActions({ slug, tokenId, canRotate }: { slug: string; tokenId: string; canRotate: boolean }) {
  const t = useTranslations("mcp.connections");
  const te = useTranslations("mcp.errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<{ token: string; expiresAt: string }> | ActionResult>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(te.has(r.error) ? te(r.error) : te("generic"));
      else {
        setError(null);
        if (r.data && "token" in r.data) setToken(r.data.token);
        router.refresh();
      }
    });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {canRotate && (
          <ConfirmButton size="sm" variant="outline" disabled={pending} title={t("rotate_confirm")} confirmLabel={t("rotate")} onConfirm={() => run(() => rotateMcpTokenAction(slug, tokenId))}>{t("rotate")}</ConfirmButton>
        )}
        <ConfirmButton size="sm" variant="outline" disabled={pending} data-testid="mcp-revoke" title={t("revoke_confirm")} confirmLabel={t("revoke")} destructive onConfirm={() => run(() => revokeMcpTokenAction(slug, tokenId))}>{t("revoke")}</ConfirmButton>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {token && <ShownOnce token={token} />}
    </div>
  );
}
