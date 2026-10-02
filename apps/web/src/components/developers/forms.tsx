"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Input, Label, Select } from "@hullwise/ui";
import { API_LIMITS, API_SCOPES, WEBHOOK_EVENT_TYPES } from "@hullwise/config";
import type { ActionResult } from "@/server/action-result";
import { createApiTokenAction, createWebhookEndpointAction, deleteWebhookEndpointAction, redeliverWebhookAction, revokeApiTokenAction, rotateApiTokenAction, rotateWebhookSecretAction, sendTestWebhookAction, setWebhookEndpointActiveAction } from "@/server/actions/developers";
import { CopyField } from "@/components/mcp/copy-field";

/** A secret, once: only its HMAC (tokens) or its ciphertext (webhook secrets) is stored. */
function ShownOnce({ value, testId, label }: { value: string; testId: string; label: string }) {
  return (
    <Alert variant="warning" data-testid={`${testId}-once`}>
      <AlertDescription className="space-y-2">
        <p className="font-medium">{label}</p>
        <CopyField value={value} testId={testId} />
      </AlertDescription>
    </Alert>
  );
}

function useErrorText() {
  const te = useTranslations("developers.errors");
  return (code: string) => (te.has(code) ? te(code) : te("generic"));
}

export function CreateApiTokenForm({ slug }: { slug: string }) {
  const t = useTranslations("developers.tokens");
  const ts = useTranslations("developers.scopes");
  const err = useErrorText();
  const [state, action, pending] = useActionState<ActionResult<{ token: string; expiresAt: string }> | null, FormData>(createApiTokenAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="api-create-token">
      <h4 className="text-sm font-semibold">{t("create_title")}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="api-token-name">{t("name")}</Label>
          <Input id="api-token-name" name="name" required maxLength={60} placeholder={t("name_placeholder")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="api-token-days">{t("expires_in")}</Label>
          <Select id="api-token-days" name="days" defaultValue="90">
            {API_LIMITS.tokenDays.map((d) => <option key={d} value={d}>{t("days", { days: d })}</option>)}
          </Select>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("scopes")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {API_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="scopes" value={s} className="mt-1" data-testid={`api-scope-${s}`} />
              <span><span className="font-mono text-xs">{s}</span> <span className="text-muted-foreground">— {ts(s.replace(":", "_"))}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {state && !state.ok && <Alert variant="destructive"><AlertDescription>{err(state.error)}</AlertDescription></Alert>}
      {state?.ok && state.data && <ShownOnce value={state.data.token} testId="api-token-value" label={t("shown_once")} />}
      <Button type="submit" disabled={pending} data-testid="api-create-token-submit">{t("create")}</Button>
    </form>
  );
}

function useRun() {
  const router = useRouter();
  const err = useErrorText();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<{ token?: string; secret?: string; expiresAt?: string }> | ActionResult>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(err(r.error));
      else {
        setError(null);
        const data = r.data as { token?: string; secret?: string } | undefined;
        if (data?.token || data?.secret) setSecret(data.token ?? data.secret ?? null);
        router.refresh();
      }
    });
  return { pending, error, secret, run };
}

export function ApiTokenActions({ slug, tokenId, canRotate }: { slug: string; tokenId: string; canRotate: boolean }) {
  const t = useTranslations("developers.tokens");
  const { pending, error, secret, run } = useRun();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 md:justify-end">
        {canRotate && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => { if (window.confirm(t("rotate_confirm"))) run(() => rotateApiTokenAction(slug, tokenId)); }}>{t("rotate")}</Button>}
        <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="api-token-revoke" onClick={() => { if (window.confirm(t("revoke_confirm"))) run(() => revokeApiTokenAction(slug, tokenId)); }}>{t("revoke")}</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {secret && <ShownOnce value={secret} testId="api-token-value" label={t("shown_once")} />}
    </div>
  );
}

export function CreateWebhookForm({ slug }: { slug: string }) {
  const t = useTranslations("developers.webhooks");
  const te = useTranslations("developers.events");
  const err = useErrorText();
  const [state, action, pending] = useActionState<ActionResult<{ secret: string }> | null, FormData>(createWebhookEndpointAction.bind(null, slug), null);
  return (
    <form action={action} className="space-y-4 rounded-lg border p-4" data-testid="webhook-create">
      <h4 className="text-sm font-semibold">{t("create_title")}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="webhook-url">{t("url")}</Label>
          <Input id="webhook-url" name="url" type="url" required maxLength={2000} placeholder="https://example.com/webhooks" inputMode="url" />
          <p className="text-xs text-muted-foreground">{t("url_hint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-description">{t("description_label")}</Label>
          <Input id="webhook-description" name="description" maxLength={200} placeholder={t("description_placeholder")} />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("events")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {WEBHOOK_EVENT_TYPES.map((e) => (
            <label key={e} className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="eventTypes" value={e} className="mt-1" data-testid={`webhook-event-${e}`} />
              <span><span className="font-mono text-xs">{e}</span> <span className="text-muted-foreground">— {te(e.replace(".", "_"))}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {state && !state.ok && <Alert variant="destructive"><AlertDescription>{err(state.error)}</AlertDescription></Alert>}
      {state?.ok && state.data && <ShownOnce value={state.data.secret} testId="webhook-secret-value" label={t("secret_once")} />}
      <Button type="submit" disabled={pending} data-testid="webhook-create-submit">{t("create")}</Button>
    </form>
  );
}

export function WebhookEndpointActions({ slug, endpointId, isActive }: { slug: string; endpointId: string; isActive: boolean }) {
  const t = useTranslations("developers.webhooks");
  const { pending, error, secret, run } = useRun();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 md:justify-end">
        <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="webhook-test" onClick={() => run(() => sendTestWebhookAction(slug, endpointId))}>{t("send_test")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="webhook-toggle" onClick={() => run(() => setWebhookEndpointActiveAction(slug, endpointId, !isActive))}>{isActive ? t("pause") : t("resume")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="webhook-rotate" onClick={() => { if (window.confirm(t("rotate_confirm"))) run(() => rotateWebhookSecretAction(slug, endpointId)); }}>{t("rotate")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="webhook-delete" onClick={() => { if (window.confirm(t("delete_confirm"))) run(() => deleteWebhookEndpointAction(slug, endpointId)); }}>{t("delete")}</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {secret && <ShownOnce value={secret} testId="webhook-secret-value" label={t("secret_rotated")} />}
    </div>
  );
}

export function RedeliverButton({ slug, deliveryId }: { slug: string; deliveryId: string }) {
  const t = useTranslations("developers.deliveries");
  const { pending, error, run } = useRun();
  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="webhook-redeliver" onClick={() => run(() => redeliverWebhookAction(slug, deliveryId))}>{t("redeliver")}</Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}
