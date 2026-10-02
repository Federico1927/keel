import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No payment keys in the repository (#53): Stripe secret and restricted keys and webhook signing
 * secrets live only in Railway variables. Scans every tracked file for real-looking `sk_…`,
 * `rk_…` and `whsec_…` values; fixtures use short, obviously fake ones. The only allowed match is
 * the public example secret from the Svix documentation used by the email webhook test.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const PATTERN = /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{16,})/g;
const ALLOWED = new Set(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i;

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  return out.split("\0").filter(Boolean);
}

describe("secrets", () => {
  it("no Stripe key or webhook secret is committed", () => {
    const files = trackedFiles().filter((f) => !BINARY.test(f));
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of files) {
      const abs = path.join(ROOT, f);
      let text: string;
      try {
        if (statSync(abs).size > 5_000_000) continue;
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(PATTERN)) if (!ALLOWED.has(m[0])) hits.push(`${f}: ${m[0].slice(0, 12)}…`);
    }
    expect(hits).toEqual([]);
  });

  it("the pattern catches real-looking keys", () => {
    const fake = ["sk", "live", "a".repeat(24)].join("_");
    expect(`STRIPE_SECRET_KEY=${fake}`.match(PATTERN)).toHaveLength(1);
    expect("rk_test_fixture whsec_fixture".match(PATTERN)).toBeNull();
  });
});
