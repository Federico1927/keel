import { HttpClient, type HttpOptions } from "../http";
import { IntegrationError } from "../types";
import { GOOGLE_ADS_API_VERSION, GOOGLE_ADS_SCOPE, type GoogleAdsCredentials } from "./index";

/**
 * "Sign in with Google" for Google Ads (#90): the platform's OAuth client and developer token (owner
 * prerequisites, docs/DEPLOY.md "Production"), the merchant's consent, then the pick of the account among
 * those the signed-in user can reach, directly or through a manager (MCC) account.
 */
type Env = Record<string, string | undefined>;
type Rec = Record<string, unknown>;

/** The platform's Google Ads app: OAuth client and developer token (Basic access). Null until the owner sets all three. */
export interface GoogleAdsPlatformApp {
  clientId: string;
  clientSecret: string;
  developerToken: string;
}
export function platformGoogleAdsApp(env: Env = process.env): GoogleAdsPlatformApp | null {
  const clientId = env.HULLWISE_GOOGLE_ADS_CLIENT_ID?.trim();
  const clientSecret = env.HULLWISE_GOOGLE_ADS_CLIENT_SECRET?.trim();
  const developerToken = env.HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  return clientId && clientSecret && developerToken ? { clientId, clientSecret, developerToken } : null;
}

/** Stored credentials of a store: its own app (manual path), or only the refresh token and account when it signed in with the platform's app. */
export type StoredGoogleAdsCredentials = Omit<GoogleAdsCredentials, "developerToken" | "clientId" | "clientSecret"> & Partial<Pick<GoogleAdsCredentials, "developerToken" | "clientId" | "clientSecret">> & { app?: "platform" | "own" };

/** Completes stored credentials with the platform's app (a rotated platform secret then applies to every store at once). */
export function googleAdsCredentials(stored: StoredGoogleAdsCredentials, env: Env = process.env): GoogleAdsCredentials {
  if (stored.developerToken && stored.clientId && stored.clientSecret) return stored as GoogleAdsCredentials;
  const app = platformGoogleAdsApp(env);
  if (!app) throw new IntegrationError("permission", "The platform's Google Ads app is not configured (HULLWISE_GOOGLE_ADS_CLIENT_ID, HULLWISE_GOOGLE_ADS_CLIENT_SECRET, HULLWISE_GOOGLE_ADS_DEVELOPER_TOKEN): contact support");
  return { ...stored, developerToken: stored.developerToken || app.developerToken, clientId: stored.clientId || app.clientId, clientSecret: stored.clientSecret || app.clientSecret };
}

export function googleOAuthAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_ADS_SCOPE);
  // offline + consent: Google returns a refresh token even when the user granted the scope before
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", input.state);
  return u.toString();
}

/** Authorization code → tokens. A missing refresh token means the consent was not offline: sign in again. */
export async function exchangeGoogleOAuthCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, opts: HttpOptions = {}): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const http = new HttpClient({ maxRetries: 1, ...opts });
  const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri }).toString();
  const res = await http.request<{ access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string }>("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (res.json?.error || !res.json?.access_token) throw new IntegrationError("token_expired", `${res.json?.error ?? "invalid_grant"}: ${res.json?.error_description ?? "no access token"}`);
  if (!res.json.refresh_token) throw new IntegrationError("token_expired", "invalid_grant: Google returned no refresh token (offline consent missing)");
  if (!(res.json.scope ?? "").includes(GOOGLE_ADS_SCOPE)) throw new IntegrationError("permission", "access_denied: the Google Ads permission was not granted");
  return { accessToken: res.json.access_token, refreshToken: res.json.refresh_token, scope: res.json.scope ?? "" };
}

/** A Google Ads account a signed-in user can pick. */
export interface GoogleAdsAccountOption {
  customerId: string;
  name: string;
  /** The manager (MCC) the account is read through; null when the user has direct access. */
  loginCustomerId: string | null;
  managerName: string | null;
  currency: string | null;
}

const CLOSED = new Set(["CANCELED", "CANCELLED", "CLOSED"]);

/**
 * The accounts to offer, from each accessible root's `customer_client` rows (level 0 = the root, level 1 =
 * its direct clients): a plain account as itself, a manager's open client accounts through the manager.
 * An account reachable both ways is offered once, directly. Managers themselves have no campaigns to read.
 */
export function googleAdsAccountOptions(roots: { rootId: string; rows: Rec[] }[]): GoogleAdsAccountOption[] {
  const out = new Map<string, GoogleAdsAccountOption>();
  const add = (o: GoogleAdsAccountOption) => {
    const prev = out.get(o.customerId);
    if (!prev || (prev.loginCustomerId && !o.loginCustomerId)) out.set(o.customerId, o);
  };
  for (const { rootId, rows } of roots) {
    const clients = rows.map((r) => (r.customerClient ?? r.customer_client ?? {}) as Rec);
    const root = clients.find((c) => Number(c.level ?? 0) === 0) ?? { id: rootId };
    const rootName = String(root.descriptiveName ?? root.descriptive_name ?? rootId);
    if (!root.manager) {
      add({ customerId: String(root.id ?? rootId), name: rootName, loginCustomerId: null, managerName: null, currency: (root.currencyCode as string | undefined) ?? null });
      continue;
    }
    for (const c of clients) {
      if (Number(c.level ?? 0) !== 1 || c.manager || CLOSED.has(String(c.status ?? "").toUpperCase())) continue;
      add({ customerId: String(c.id), name: String(c.descriptiveName ?? c.descriptive_name ?? c.id), loginCustomerId: rootId, managerName: rootName, currency: (c.currencyCode as string | undefined) ?? null });
    }
  }
  return [...out.values()].sort((a, b) => (a.managerName ?? "").localeCompare(b.managerName ?? "") || a.name.localeCompare(b.name));
}

const googleAdsError = (err: { message?: string; status?: string; details?: unknown }): IntegrationError => {
  const text = `${JSON.stringify(err.details ?? "").match(/"(\w+_(?:NOT_APPROVED|NOT_ENABLED|PERMISSION_DENIED|PROHIBITED|INVALID))"/)?.[1] ?? err.status ?? ""}: ${err.message ?? ""}`;
  return new IntegrationError(err.status === "UNAUTHENTICATED" ? "token_expired" : err.status === "RESOURCE_EXHAUSTED" ? "rate_limited" : err.status === "PERMISSION_DENIED" ? "permission" : "invalid_request", text);
};

/** Every account the signed-in user can pick (at most `maxRoots` accessible roots are expanded). */
export async function listGoogleAdsAccounts(input: { accessToken: string; developerToken: string }, opts: HttpOptions & { apiVersion?: string; maxRoots?: number } = {}): Promise<GoogleAdsAccountOption[]> {
  const http = new HttpClient({ minIntervalMs: 100, maxRetries: 2, ...opts });
  const base = `https://googleads.googleapis.com/${opts.apiVersion ?? GOOGLE_ADS_API_VERSION}`;
  const headers = { authorization: `Bearer ${input.accessToken}`, "developer-token": input.developerToken, "content-type": "application/json" };
  const list = await http.request<{ resourceNames?: string[]; error?: { message?: string; status?: string; details?: unknown } }>(`${base}/customers:listAccessibleCustomers`, { headers });
  if (list.json?.error) throw googleAdsError(list.json.error);
  const ids = (list.json?.resourceNames ?? []).map((r) => r.replace(/^customers\//, "")).slice(0, opts.maxRoots ?? 10);
  if (!ids.length) throw new IntegrationError("not_found", "No accessible Google Ads accounts for this Google user");
  const roots: { rootId: string; rows: Rec[] }[] = [];
  let firstError: IntegrationError | null = null;
  for (const id of ids) {
    const res = await http.request<{ results?: Rec[] }[] | { error?: { message?: string; status?: string; details?: unknown } }>(`${base}/customers/${id}/googleAds:searchStream`, { method: "POST", headers: { ...headers, "login-customer-id": id }, body: JSON.stringify({ query: "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status, customer_client.currency_code FROM customer_client WHERE customer_client.level <= 1" }) }).catch((e: unknown) => ({ json: { error: { message: e instanceof Error ? e.message : String(e), status: e instanceof IntegrationError && e.code === "permission" ? "PERMISSION_DENIED" : "UNKNOWN" } } }));
    if (!Array.isArray(res.json)) {
      firstError ??= googleAdsError(res.json?.error ?? {});
      continue;
    }
    roots.push({ rootId: id, rows: res.json.flatMap((chunk) => chunk.results ?? []) });
  }
  const options = googleAdsAccountOptions(roots);
  if (!options.length) throw firstError ?? new IntegrationError("not_found", "No accessible Google Ads accounts for this Google user");
  return options;
}
