import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { adminDb } from "@hullwise/db";
import { PRODUCT_NAME } from "@hullwise/config";
import { checkAuthorizeRequest, mcpTenantChoices } from "@hullwise/services";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@hullwise/ui";
import { BrandMark } from "@/components/brand-mark";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { getCurrentUser } from "@/server/session";
import { mcpOrigin } from "@/server/mcp";
import { approveMcpAuthorization, denyMcpAuthorization } from "@/server/actions/mcp";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("mcp.consent"))("title") };
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const KEYS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const;

/**
 * OAuth 2.1 consent screen of the MCP server (#21): the signed-in person picks one workspace (MCP
 * must be available there), sees what the client asks for and can narrow the scopes.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const params = Object.fromEntries(KEYS.map((k) => [k, one(sp[k])])) as Record<(typeof KEYS)[number], string | undefined>;
  const t = await getTranslations("mcp.consent");
  const ts = await getTranslations("mcp.scopes");
  const tr = await getTranslations("roles");
  const checked = await checkAuthorizeRequest(adminDb(), params);
  const shell = (body: React.ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-9 w-9" />
            <div>
              <p className="text-xs font-medium text-muted-foreground">{PRODUCT_NAME}</p>
              <h1 className="text-2xl">{t("title")}</h1>
            </div>
          </div>
          <LocaleSwitcher />
        </div>
        {body}
      </div>
    </main>
  );
  if (!checked.ok) {
    if (checked.redirect) {
      const u = new URL(checked.redirectUri);
      u.searchParams.set("error", checked.error);
      u.searchParams.set("error_description", checked.description);
      if (checked.state) u.searchParams.set("state", checked.state);
      u.searchParams.set("iss", mcpOrigin());
      redirect(u.toString());
    }
    return shell(
      <Alert variant="destructive" data-testid="mcp-consent-error">
        <AlertDescription>{t("invalid_request")} <span className="font-mono text-xs">{checked.description}</span></AlertDescription>
      </Alert>,
    );
  }
  const user = await getCurrentUser();
  if (!user) {
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }
  const req = checked.request;
  const choices = await mcpTenantChoices(adminDb(), user.id);
  const usable = choices.filter((c) => c.availability === "ok");
  const host = (() => {
    try {
      return new URL(req.redirectUri).host || req.redirectUri;
    } catch {
      return req.redirectUri;
    }
  })();
  return shell(
    <Card>
      <CardHeader>
        <CardTitle data-testid="mcp-consent-client">{t("heading", { client: req.client.clientName })}</CardTitle>
        <CardDescription>{t("description", { user: user.email })}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={approveMcpAuthorization} className="space-y-6" data-testid="mcp-consent-form">
          {KEYS.map((k) => (params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null))}
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">{t("workspace")}</legend>
            {choices.map((c, i) => (
              <label key={c.tenantId} className={`flex items-center justify-between gap-3 rounded-md border p-3 text-sm ${c.availability === "ok" ? "cursor-pointer" : "opacity-60"}`}>
                <span className="flex items-center gap-3">
                  <input type="radio" name="tenantId" value={c.tenantId} defaultChecked={c.availability === "ok" && usable[0]?.tenantId === c.tenantId} disabled={c.availability !== "ok"} required data-testid={`mcp-consent-tenant-${i}`} />
                  <span>
                    <span className="font-medium">{c.name}</span>
                    {c.availability !== "ok" && <span className="block text-xs text-muted-foreground">{t(`unavailable.${c.availability}`)}</span>}
                  </span>
                </span>
                <Badge variant="secondary">{tr(c.role)}</Badge>
              </label>
            ))}
            {choices.length === 0 && <p className="text-sm text-muted-foreground">{t("no_workspace")}</p>}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">{t("scopes")}</legend>
            <p className="text-xs text-muted-foreground">{t("scopes_hint")}</p>
            {req.scopes.map((s) => (
              <label key={s} className="flex items-start gap-3 rounded-md border p-3 text-sm">
                <input type="checkbox" name="scopes" value={s} defaultChecked disabled={s === "read"} className="mt-1" data-testid={`mcp-consent-scope-${s}`} />
                {s === "read" && <input type="hidden" name="scopes" value="read" />}
                <span>
                  <span className="font-mono text-xs">{s}</span>
                  <span className="block text-muted-foreground">{ts(s.replace(":", "_"))}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t("note_role")}</li>
            <li>{t("note_pii")}</li>
            <li>{t("note_proposals")}</li>
            <li>{t("note_redirect", { host })}</li>
          </ul>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="submit" variant="outline" formAction={denyMcpAuthorization} formNoValidate data-testid="mcp-consent-deny">{t("deny")}</Button>
            <Button type="submit" disabled={usable.length === 0} data-testid="mcp-consent-approve">{t("approve")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>,
  );
}
