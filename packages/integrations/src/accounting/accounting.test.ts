import { describe, expect, it } from "vitest";
import { IntegrationError } from "../types";
import { MockAccountingProvider } from "./mock";

const journal = (lines: { accountCode: string; debitMinor: number; creditMinor: number }[]) => ({ date: "2026-03-10", currency: "EUR", narration: "Daily sales 2026-03-10", reference: "sales-2026-03-10-v1", status: "draft" as const, lines: lines.map((l) => ({ ...l, description: l.accountCode })) });
const balanced = journal([{ accountCode: "1100", debitMinor: 12200, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 10000 }, { accountCode: "2200", debitMinor: 0, creditMinor: 2200 }]);

describe("MockAccountingProvider", () => {
  it("returns the chart of accounts and tests the connection", async () => {
    const p = new MockAccountingProvider();
    expect((await p.testConnection()).ok).toBe(true);
    const accounts = await p.fetchAccounts();
    expect(accounts.find((a) => a.code === "1100")?.type).toBe("asset");
    expect(accounts.some((a) => !a.active)).toBe(true);
  });

  it("creates a journal once per idempotency key, reads its status back and voids it", async () => {
    const p = new MockAccountingProvider();
    const a = await p.pushJournal(balanced, { idempotencyKey: "t:2026-03-10:v1" });
    expect(a.replayed).toBe(false);
    const again = await p.pushJournal(balanced, { idempotencyKey: "t:2026-03-10:v1" });
    expect(again).toEqual({ externalId: a.externalId, status: "draft", replayed: true });
    expect(p.journals.size).toBe(1);
    expect(await p.getJournalStatus(a.externalId)).toEqual({ externalId: a.externalId, status: "draft" });
    await p.voidJournal(a.externalId);
    expect((await p.getJournalStatus(a.externalId)).status).toBe("voided");
    expect(await p.getJournalStatus("someone-else")).toEqual({ externalId: "someone-else", status: "not_found" });
  });

  it("refuses unbalanced journals, unknown or archived accounts, and fails on request", async () => {
    const p = new MockAccountingProvider();
    await expect(p.pushJournal(journal([{ accountCode: "1100", debitMinor: 100, creditMinor: 0 }, { accountCode: "4000", debitMinor: 0, creditMinor: 90 }]), { idempotencyKey: "a" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(p.pushJournal(journal([{ accountCode: "1100", debitMinor: 100, creditMinor: 0 }, { accountCode: "6900", debitMinor: 0, creditMinor: 100 }]), { idempotencyKey: "b" })).rejects.toThrow(/6900/);
    p.failures.failNext("rate_limited");
    const err = await p.pushJournal(balanced, { idempotencyKey: "c" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).retryAfterMs).toBeGreaterThan(0);
    expect((await p.pushJournal(balanced, { idempotencyKey: "c" })).replayed).toBe(false);
  });
});
