import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { WEBHOOK_LIMITS } from "@hullwise/config";
import { checkWebhookUrl, isAllowedWebhookAddress, type WebhookUrlPolicy } from "@hullwise/core";

/**
 * The only way a webhook leaves the platform (#81). SSRF guard: the URL passes `checkWebhookUrl`
 * (https, no credentials, no internal names or private literals), and the connection's own DNS
 * lookup refuses private, loopback, link-local and metadata addresses, so a name that resolves (or
 * re-resolves) to one is never contacted. Redirects are not followed (Node's http client never
 * does); the whole request has a 10 s budget; only the status and a short excerpt are read.
 */

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  policy: WebhookUrlPolicy;
}

export interface WebhookResponse {
  /** HTTP status, null when no answer arrived (blocked, refused, timeout). */
  status: number | null;
  durationMs: number;
  /** Short, sanitised reason when no 2xx came back. */
  error: string | null;
  excerpt: string | null;
}

export type WebhookSender = (req: WebhookRequest) => Promise<WebhookResponse>;

/**
 * The policy of this process: loopback receivers (test servers) only with
 * `HULLWISE_WEBHOOKS_ALLOW_LOOPBACK=1` outside live mode. Private ranges are never allowed.
 */
export function webhookUrlPolicy(env: Record<string, string | undefined> = process.env): WebhookUrlPolicy {
  return { allowLoopback: env.HULLWISE_WEBHOOKS_ALLOW_LOOPBACK === "1" && env.HULLWISE_INTEGRATION_MODE !== "live" };
}

class BlockedAddressError extends Error {
  readonly code = "EBLOCKED";
}

/** Resolves every address of a host name; null when it does not resolve. */
export async function resolveHostAddresses(host: string): Promise<string[] | null> {
  try {
    const all = await dns.promises.lookup(host, { all: true, verbatim: true });
    return all.map((a) => a.address);
  } catch {
    return null;
  }
}

function guardedLookup(policy: WebhookUrlPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as dns.LookupAddress[];
      const bad = list.find((a) => !isAllowedWebhookAddress(a.address, policy));
      if (!list.length || bad) return callback(new BlockedAddressError("blocked address"), "", 4);
      if (options.all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === "EBLOCKED") return "blocked: the host resolves to a private, loopback or link-local address";
  if (e?.message === "timeout") return "timeout";
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return "dns: host not found";
  if (e?.code === "ECONNREFUSED") return "connection refused";
  if (e?.code === "ECONNRESET") return "connection reset";
  if ((typeof e?.code === "string" && e.code.startsWith("ERR_TLS")) || /certificate|self.signed/i.test(e?.message ?? "")) return "tls: certificate not trusted";
  return e?.code ? `network: ${e.code}` : "network error";
}

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, WEBHOOK_LIMITS.responseExcerptChars);

export const guardedWebhookSend: WebhookSender = (req) =>
  new Promise((resolve) => {
    const started = Date.now();
    const done = (r: Omit<WebhookResponse, "durationMs">) => resolve({ ...r, durationMs: Date.now() - started });
    const check = checkWebhookUrl(req.url, req.policy);
    if (!check.ok) return done({ status: null, error: `blocked: ${check.problem}`, excerpt: null });
    const url = check.url;
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (r: Omit<WebhookResponse, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const request = mod.request(url, { method: "POST", headers: { ...req.headers, "Content-Length": String(Buffer.byteLength(req.body)) }, lookup: guardedLookup(req.policy), agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        if (size < 4096) chunks.push(c);
        size += c.length;
        // enough for the excerpt: stop reading a large answer
        if (size >= 4096) res.destroy();
      });
      const settle = () => {
        const status = res.statusCode ?? null;
        const text = clean(Buffer.concat(chunks).toString("utf8"));
        const ok = status !== null && status >= 200 && status < 300;
        finish({ status, error: ok ? null : status !== null && status >= 300 && status < 400 ? `redirect ${status} not followed` : `http ${status}`, excerpt: text || null });
      };
      res.on("end", settle);
      res.on("close", settle);
      res.on("error", settle);
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("timeout"));
      finish({ status: null, error: "timeout", excerpt: null });
    }, req.timeoutMs ?? WEBHOOK_LIMITS.timeoutMs);
    request.on("error", (err) => finish({ status: null, error: describe(err), excerpt: null }));
    request.end(req.body);
  });
