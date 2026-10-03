# Subscriptions add-on (`addon.subscriptions`)

Status: **v1 in development** (`packages/config/src/addon-versions.ts`, issue #77). It is switched on for the demo tenant
Harbor Home so it can be tried end to end; the console cannot switch it on for other tenants until v1 is released.
Issue: #67. Price in the catalog: 149/month (not billed while in development).

## What it does

Hullwise is the analysis and operations layer on top of the subscription app the store already uses (Shopify
Subscriptions, Recharge or Loop). It never charges a card, edits selling plans or replaces the customer portal: it reads
contracts, billing attempts and cancellations from the app and sends customer-care actions back through it.

- **Overview**: MRR and its monthly movement (new, expansion, reactivated, contraction, churned), active / paused /
  new subscribers, voluntary and involuntary churn, renewal success rate, value at risk, recovery rate, survival cohorts
  by activation month, 30/60/90-day renewal forecast, profit per subscriber and per renewal (product cost, shipping,
  payment fees, returns from the core P/L), LTV against acquisition cost per campaign and channel of the first order.
  Every number opens the subscribers or orders behind it.
- **Subscribers**: server-side filters (status, risk, failing payment, cohort, MRR movement, churn kind, reason,
  variant), search, pagination, cards on a phone; four ready-made segments that open the segment builder.
- **Subscriber detail**: lines, price and MRR, next billing, renewals, charges with decline reasons and the app's next
  retry, timeline with author and field diff, the orders the contract created, churn risk explained factor by factor.
  Customer-care actions the app supports (pause, resume, skip, swap variant, change frequency, reschedule, cancel with a
  reason, send the payment-update link): each one is confirmed, written once through the app (outbox, idempotent),
  recorded as an event with author and diff and in the audit log.
- **Recovery**: failed renewals with value at risk, the app's retry schedule, last contact, assignee; assign, note,
  payment-update link; recovery rate and recovered value.
- **Stock for renewals**: units the scheduled renewals need per variant for the next 1–8 weeks against available stock
  plus incoming purchase orders; a variant that runs out before its renewals is flagged with a suggested quantity
  (also used by reorder planning).
- **Cancellations**: reasons by product, cohort and acquisition channel with a monthly trend; the tenant's editable
  reason list (raw customer text is kept and normalised onto it).
- Elsewhere: the subscription card on the customer page and on subscription orders, the orders filter
  `?subscription=first|renewal`, six subscription fields in the segment builder, four home widgets (MRR, active
  subscribers, churn, value at risk), three read-only MCP tools (`get_subscriptions_overview`,
  `list_subscription_recovery`, `get_renewal_stock`), the integration card and the activation guide.
- Background: the `subscriptions` tick every 15 minutes (delta sync, full pass at 03:00 UTC, churn risk). In mock mode
  the same tick lets the simulated app charge the renewals that came due (see below).

Without the add-on (Northwind) every page, the guide, the webhook endpoint, the widgets and the MCP tools answer 404 or
are not listed.

## Try it on the demo

Password of every demo user: `hullwise-demo-2026` locally (on the hosted demo, the value of `HULLWISE_DEMO_PASSWORD`).

1. Sign in as **`owner@harborhome.demo`**. Open **Subscriptions** in the sidebar.
   - Overview: about 400 subscribers to a refill line (candles and cleaning concentrates) over 12 months; MRR movement,
     cohorts (better retention after the price cut six months ago), forecast, profit and LTV. Switch 30/90/365 days;
     click any number (a cohort, a movement cell, a KPI) to open the subscribers behind it.
   - In the **Subscription app** card at the bottom right: **Test connection**, **Resync**, and the two simulation
     buttons (mock mode only): **Simulate a renewal** charges the next healthy renewal (the message names the customer
     and the new order `#HH-…`), **Simulate a declined card** declines one (it appears in Recovery).
2. **Subscribers** tab: filter by status, risk or failing payment, search by name or email, open a subscriber.
   On the detail page try the actions in the right column (each asks for confirmation); the timeline shows who did what.
   The ready-made segments at the bottom open the segment builder pre-filled.
3. Sign in as **`care@harborhome.demo`** (customer care, Ava) to work as the support team: the same actions, plus
   **Recovery**: assign a failed payment to yourself, add a note, send the payment-update link, and (mock mode only)
   **Simulate the app's retry** to see a payment recovered and its order created.
4. **Stock for renewals** tab (`?weeks=1`): "Candle Refill · Fig" runs out before next week's renewals; the incoming
   purchase order arrives too late; the suggested quantity is also in Inventory → Planning.
5. **Cancellations** tab: reasons by product / cohort / channel, monthly trend, and (owner or admin) the reason list:
   add or deactivate a reason.
6. **Integrations**: the Subscriptions card (status, mode "Simulated", Test connection, Manage sheet with Resync and the
   app picker, "…" menu with the two simulations) and **Activation guide** with one section per app.
7. **Orders** → filter "Subscription: renewal" to see the orders the contracts created; an order shows its subscription
   card. **Customers** → a subscriber shows the subscription card.
8. Console: sign in as **`superadmin@hullwise.demo`**, open **Tenants → Harbor Home**: the add-on is active with the
   badge "v1 in development" and its summary line. (Switching it off is allowed; switching it back on is not until v1 is
   released, see the release checklist.)

The tour is automated in `apps/web/e2e/addon-subscriptions-tour.spec.ts` (desktop and iPhone 15).

## What is simulated and what is ready for a live app

| Part | Demo (mock mode) | Live |
| --- | --- | --- |
| Contracts, charges, cancellations | `MockSubscriptionProvider`, started from the rows Hullwise holds (an untouched sync changes nothing) | Adapters for Shopify Subscriptions (Admin GraphQL), Recharge (REST 2021-11), Loop (admin REST), tested on recorded fixtures only |
| Renewals happening over time | The simulated app charges renewals that came due on every `subscriptions` tick (about 1 in 12 declined, deterministic per contract and cycle), retries declines after 3 and 4 days (about 45% recovered) and cancels for non-payment after the last retry; a paid charge creates the store's renewal order through the core order import | The real app charges; Hullwise imports the attempts on sync and webhooks; the order arrives through the Shopify order sync |
| Customer-care actions | Applied in memory by the simulator, then imported back | Written through the app's API via the outbox, contract re-read from the app's answer |
| Webhooks | Signed mock payloads (`x-mock-signature`) | HMAC verification per app; endpoint `/api/webhooks/subscriptions/<tenantId>` |
| Connection | Seeded as connected in mock mode; the setup sheet answers with each documented error for the trigger values | Recharge and Loop: token and webhook secret pasted and verified; Shopify Subscriptions: through the Shopify connection |
| Demo data | `packages/db/src/seed/subscriptions.ts` (own RNG, deterministic); reaches a hosted demo through `ensureDemoSettings` when Harbor has the add-on and no contracts | — |

## Release checklist (before v1 can be marked `released`)

- [ ] **Live validation per app** on a real store: Recharge and Loop endpoints, field names, pagination and webhook
      signatures against the recorded fixtures; Shopify Subscriptions contract queries and the draft → commit flow.
- [ ] **Shopify approval** to read subscription contracts created by other apps (`read_own_subscription_contracts`
      only covers contracts the app itself created; third-party apps need Shopify's protected-scope approval). Without it
      only Recharge and Loop can be supported.
- [ ] Vendor partner/API access where required (Recharge partner token or merchant API token scopes; Loop admin API
      access on the merchant's plan).
- [ ] Retry schedule: the Shopify Admin API does not expose the app's retry calendar; decide whether to show "unknown"
      or infer it per app.
- [ ] Payment-update link: today it goes through the app's own email; confirm per app that the call exists on the
      merchant's plan.
- [ ] Load test of the sync on a store with tens of thousands of contracts (page sizes, time budget, resumable cursor).
- [ ] Cancellation reason labels per language (they are tenant data in one language today, like other editable lists).
- [ ] Pricing confirmed (149/month placeholder) and the version flipped to `released` in `addon-versions.ts` by the owner.
