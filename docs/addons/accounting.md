# Accounting push add-on (`addon.accounting`)

Status: **v1 in development** (`packages/config/src/addon-versions.ts`, issue #77). It is switched on for the demo tenant
Northwind Apparel so it can be tried end to end; the console cannot switch it on for other tenants until v1 is
released. Issue: #85. Price in the catalog: 69/month (not billed while in development).

## What it does

Every closed local day, Hullwise builds one journal from the **daily sales summary** (a core page every tenant has:
Analytics → Daily sales summary) and pushes it to the store's accounting system, so the bookkeeper does not re-type the
day's sales.

- **Journal per day**: credits for sales and output tax per tax rate (`IT 22%`, `DE 19%`…) and shipping income; debits
  for discounts, refunds, payment fees (actual from the processor's payouts when known, otherwise the configured
  estimate) and the payment-processors clearing account for the net. Debits always equal credits.
- **Only days that reconcile are pushed**: the day is closed in the store's time zone (plus a settle delay), every line
  has an account, debits equal credits, and no order of the day is still syncing from Shopify or waiting for a change
  to reach Shopify. Other days wait, with the reason in plain words (for example "1 order waits for a change to reach
  the store: #NW-1234").
- **Push log** (sidebar → Accounting push): one row per day and journal version with status (pushed, waiting, failed,
  voided, nothing to post), the external journal id, totals, the error of a failed push and its next attempt (back-off
  15 min doubling up to 12 h); **Retry now** for failed or waiting days, **Re-push day** for pushed ones (confirmed:
  voids the pushed journal in the accounting system and pushes version + 1 built from today's summary, audited with the
  before/after), **Push now** runs the hourly job for the store.
- **Reconciliation** (top of the push log): every pushed day of the window compared with the journal today's summary
  gives for the same day. A day that no longer matches (an order synced after the push, actual fees replacing the
  estimate, a mapping changed later) is listed with the lines that moved and the difference, with Re-push next to it;
  the day page shows the same comparison line by line.
- **Day page**: every version of the day's journal with its lines and totals, link to the day's sales summary.
- **Settings** (Platform → Accounting settings): the connection card, the chart of accounts read from the system, the
  account for each summary line with overrides per tax rate (codes must exist and be active in the chart), first day
  to push, look-back window, settle delay, and whether journals are created as draft or posted.
- **Integration card** (Integrations): status, Test connection, Manage sheet with Resync (re-reads the chart) and the
  health of the pushes, "…" menu with **Simulate a refusal** (mock mode), activation guide (Xero, QuickBooks Online and
  Fatture in Cloud listed as "available on request", steps marked "To verify").
- MCP tool `get_accounting_push_status` (read only). Hourly `accounting` tick, idempotent per tenant, day and version
  (the idempotency key sent to the system is tenant + day + version).

Permissions: owners and admins push, retry, re-push and edit settings; viewers read the log; other roles do not see it.
Without the add-on (Harbor Home) pages, guide, card and nav entries answer 404 or are hidden.

## Try it on the demo

Password of every demo user: `hullwise-demo-2026` locally (on the hosted demo, the value of `HULLWISE_DEMO_PASSWORD`).

1. Sign in as **`owner@northwind.demo`** and open **Accounting push** in the sidebar.
   - The counters show about 30 pushed days, **1 waiting** (one of its orders has a note edit Shopify throttled, still in
     the outbox) and **1 failed** (the simulated system answered "rate limited"; next attempt in about 30 minutes).
   - The status chips filter the log; one older day shows a re-push (version 1 voided, version 2 pushed).
2. **Reconciliation** card: one pushed day no longer matches (an order reached Hullwise after the day was pushed). Click
   the day: the "Differs from what was pushed" panel lists sales, tax and clearing before and after. Click **Re-push
   day** and confirm: version 1 is voided, version 2 pushed, the panel disappears and the day leaves the
   reconciliation list.
3. Back on the log: **Retry now** on the failed day pushes it. **Retry now** on the waiting day explains it still waits.
   **Push now** runs the job for every day of the window.
4. To see a failure: **Integrations → Accounting system → "…" → Simulate a refusal** (the next journal push is refused;
   tests, reads and voids still answer), then **Re-push day** on a pushed day: the old version is voided and the new
   version shows **Failed** with `[rate_limited]` and its next attempt; **Retry now** pushes it.
5. **Accounting settings** (link at the top of the log): chart of accounts, mapping per line and per tax rate (Germany,
   France and Spain go to the export sales and reduced-rate tax accounts), push rules. Change "Create journals as" and
   save; the change is audited.
6. A day's link opens its journal; "Daily sales of this day" opens the summary with the orders behind every number.
7. Console: **`superadmin@hullwise.demo` → Tenants → Northwind Apparel**: the add-on is active with the badge
   "v1 in development".

The tour is automated in `apps/web/e2e/addon-accounting-tour.spec.ts` (desktop and iPhone 15).

## What is simulated and what is ready for a live system

| Part | Demo (mock mode) | Live |
| --- | --- | --- |
| Accounting system | `MockAccountingProvider`: generic 12-account chart, validates like a real system (balanced, known active accounts, one currency), honours idempotency keys, voids, fails on request | **No live connector yet.** The `AccountingProvider` interface (chart, push, read back, void) is what a Xero, QuickBooks Online or Fatture in Cloud connector implements; built per account on request |
| Journals | Built by the core functions from the real demo orders (`buildDailyJournal`, `dailySalesSummary`) | Same |
| Push log, retries, re-push, reconciliation | Real services and job | Same |
| Connection | Seeded as connected; "Connect the simulated system" when disconnected | OAuth / API key per system, to be built with the connector |
| Demo data | `packages/db/src/seed/accounting.ts`: settings, chart, 32 days of log (pushed, waiting, failed, a re-pushed day, a day that no longer reconciles); reaches a hosted demo through `ensureDemoSettings` when Northwind has the add-on and no journals | — |

## Release checklist (before v1 can be marked `released`)

- [ ] **At least one live connector** (first candidate decided by the first paying customer: Xero, QuickBooks Online or
      Fatture in Cloud), behind `AccountingProvider`, with OAuth or token storage encrypted like the other integrations,
      tested on recorded fixtures and then on a sandbox company.
- [ ] Vendor app registration and approval where required (Xero app partner certification for more than 25 connections,
      Intuit app review for QuickBooks Online production keys, Fatture in Cloud app registration).
- [ ] Per-country checks with an accountant: journal layout, tax codes on lines (`taxCode` is read from the chart but
      not yet sent), multi-currency days, cash-on-delivery remittances on the clearing account.
- [ ] Decide how a re-push maps to each system (void + new journal vs. reversing journal) and whether posted journals
      may be voided at all once the period is locked.
- [ ] Alerting: a day failing or waiting for more than N days should notify the owner (today it is visible in the log
      and in integration health only).
- [ ] Pricing confirmed (69/month placeholder) and the version flipped to `released` in `addon-versions.ts` by the owner.
