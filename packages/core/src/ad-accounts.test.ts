import { describe, expect, it } from "vitest";
import { accountOf, matchesAccountFilter, normalizeMetaAccountId, summarizeAccountRuns } from "./ad-accounts";

describe("ad accounts", () => {
  it("normalizes Meta account ids", () => {
    expect(normalizeMetaAccountId(" 12345 ")).toBe("act_12345");
    expect(normalizeMetaAccountId("act_12345")).toBe("act_12345");
  });
  it("rows without an account belong to the primary one", () => {
    expect(accountOf(null, "act_1")).toBe("act_1");
    expect(accountOf("act_2", "act_1")).toBe("act_2");
    expect(accountOf(undefined, null)).toBeNull();
    expect(matchesAccountFilter(null, "act_1", "act_1")).toBe(true);
    expect(matchesAccountFilter(null, "act_2", "act_1")).toBe(false);
    expect(matchesAccountFilter("act_2", "act_2", "act_1")).toBe(true);
    expect(matchesAccountFilter("act_2", null, "act_1")).toBe(true);
  });
  it("a failing account is reported without failing the run, unless all fail", () => {
    const s = summarizeAccountRuns([{ account: "act_1", ok: true, error: null, rows: 10 }, { account: "act_2", ok: false, error: "token expired", rows: 0 }]);
    expect(s).toEqual({ ok: 1, failed: [{ account: "act_2", error: "token expired" }], rows: 10, allFailed: false });
    expect(summarizeAccountRuns([{ account: "act_2", ok: false, error: null, rows: 0 }]).allFailed).toBe(true);
    expect(summarizeAccountRuns([]).allFailed).toBe(false);
  });
});
