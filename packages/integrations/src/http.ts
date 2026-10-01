import { IntegrationError } from "./types";

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface HttpOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries on 429 and 5xx; each attempt honours Retry-After (seconds) when present. */
  maxRetries?: number;
  minIntervalMs?: number;
}

/**
 * Thin HTTP layer shared by the live adapters: injectable fetch (tests pass recorded
 * fixtures, no network), rate-limit retries, and uniform error mapping.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private lastCallAt = 0;
  readonly calls: { url: string; method: string; body?: string }[] = [];

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
  }

  async request<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: { get(name: string): string | null }; json: T; text: string }> {
    let attempt = 0;
    for (;;) {
      if (this.minIntervalMs) {
        const wait = this.lastCallAt + this.minIntervalMs - Date.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastCallAt = Date.now();
      this.calls.push({ url, method: init.method ?? "GET", body: init.body });
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(url, init);
      } catch (e) {
        if (attempt < this.maxRetries) {
          attempt++;
          await this.sleep(500 * attempt);
          continue;
        }
        throw new IntegrationError("network", e instanceof Error ? e.message : String(e));
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        const ms = Math.max(retryAfter > 0 ? retryAfter * 1000 : 0, 1000 * (attempt + 1));
        if (attempt < this.maxRetries) {
          attempt++;
          await this.sleep(ms);
          continue;
        }
        throw new IntegrationError(res.status === 429 ? "rate_limited" : "network", `HTTP ${res.status}: ${text.slice(0, 200)}`, ms);
      }
      if (res.status === 401) throw new IntegrationError("token_expired", `HTTP 401: ${text.slice(0, 200)}`);
      if (res.status === 403) throw new IntegrationError("permission", `HTTP 403: ${text.slice(0, 200)}`);
      if (res.status === 404) throw new IntegrationError("not_found", `HTTP 404: ${text.slice(0, 200)}`);
      if (res.status >= 400) throw new IntegrationError("invalid_request", `HTTP ${res.status}: ${text.slice(0, 300)}`);
      let json: T;
      try {
        json = (text ? JSON.parse(text) : null) as T;
      } catch {
        throw new IntegrationError("unknown", `Non-JSON response from ${url}`);
      }
      return { status: res.status, headers: res.headers, json, text };
    }
  }
}

/** Builds a fetch stub from a route table; unmatched URLs throw so tests never hit the network. */
export function fixtureFetch(routes: { match: (url: string, init?: { method?: string; body?: string }) => boolean; status?: number; headers?: Record<string, string>; body: unknown | ((url: string, init?: { method?: string; body?: string }) => unknown) }[]): FetchLike {
  return async (url, init) => {
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`fixtureFetch: no route for ${init?.method ?? "GET"} ${url}`);
    const body = typeof route.body === "function" ? (route.body as (u: string, i?: { method?: string; body?: string }) => unknown)(url, init) : route.body;
    const headers = new Map(Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: route.status ?? 200, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
}
