# Onboarding a store (runbook)

From "the contract is signed" to "the store's numbers match Shopify". Read top to bottom the first time; afterwards use it as a checklist. Every step ends with **Check**: what to look at, and where, before going on. Italian version: [ONBOARDING.it.md](ONBOARDING.it.md).

Paths: `/admin/…` is the super-admin console (also `https://admin.<domain>/…` when `ADMIN_URL` is set); `/t/<store>/…` is the tenant app, where `<store>` is the tenant's slug. The console's tenant page links this runbook under the setup checklist.

Before the first store, the platform side must be ready: your own owner account (`HULLWISE_OWNER_EMAIL`), `HULLWISE_INTEGRATION_MODE=live` with the worker, the vendor prerequisites, daily backups. See `docs/DEPLOY.md`, **Production**.

## 0. What to ask the merchant before you start

- Company data: legal name, country, currency, time zone (the one set in Shopify: Shopify admin → Settings → General), language of the team, VAT/sales-tax rate of their country, order number prefix (as in Shopify, e.g. `#NW`).
- The owner's name and email, and the people who will use the app with their role (owner, admin, operations, customer care, marketing, viewer).
- Access: a staff account on their Shopify store with permission to create apps (or the store owner on a call), admin access to their Meta Business Manager, Google Ads and TikTok Ads accounts.
- How far back to import orders (default 24 months).
- A cost per product (Shopify's "Cost per item", or a spreadsheet), their payment providers' fees, and what a shipment costs them on average.

## 1. Create the tenant

**Do.** `/admin/tenants/new`: name, slug (the URL, lower case, never changed later), country, currency, time zone, default language, order number prefix, plan, tax rate (in basis points: 2200 = 22%), owner name and owner email. **Create tenant** makes the workspace, the default order state rules, the integration slots of the plan, a trial subscription with the setup-fee invoice, and an invitation for the owner.

**Check.** **Open setup checklist** (`/admin/tenants/<id>`): "Company data" is ticked with country · currency · time zone; "Owner account" says *invitation pending*. The **Subscription and invoices** card shows the trial and the setup invoice.

## 2. The owner's access (and yours while email is off)

The owner joins by accepting the invitation email. Emails go out only when `RESEND_API_KEY` is set (the console's **Email** page says "Email not configured" otherwise, and the invitation stays in the log as captured by the mock).

- **Email on:** the owner clicks the link (valid 7 days, one use), sets their password and lands in the store. Resend the invitation from `/t/<store>/users` → **Invitations** if needed.
- **Email off:** do the setup yourself with **Open as support** (`/admin/tenants/<id>`, top right): you act as owner, a banner shows it, and every action is audited as the super-admin. Invite the merchant's team only once email works (step 7).

**Check.** As support, `/t/<store>` opens with the support banner. With email on: the console's checklist ticks "Owner account" after the owner accepts; `/t/<store>/users` lists them as Active.

## 3. Connect Shopify and import the history

**Do.** First set how many months of orders to import: `/t/<store>/settings` → **Thresholds & fees** → "Order history read when Shopify is connected (months, 0 = all)". Then `/t/<store>/integrations` → **Shopify** card → follow its checklist with the merchant (own app in the Shopify Dev Dashboard, version with the required scopes, release and install on the store, copy Client ID and Client secret) and paste store domain (`name.myshopify.com`), Client ID and Client secret → **Connect**. The card explains every error it can return (wrong secret, store outside the app's organization → "Install on your store", version not released, missing scopes). The full guide with the scopes per module is at `/t/<store>/integrations/guide/shopify`.

Connecting checks the credentials and scopes, registers the webhooks, and starts the import of the order history in the background (products, customers and orders, resumable).

**Check.**
- The Shopify card says **Connected**, mode *live*, with the store name; "Optional permissions not granted yet" lists what is missing, if anything.
- **Order history import** box on the card: *In progress* then *Complete*, with the number of orders and the oldest order date. If it stops (*Failed*), **Resync** continues where it stopped.
- **Recent sync runs** (same page, below the cards): rows `shopify/orders · backfill` (and products, customers) with status *Success*, rows scanned and changed.
- **Webhook log** (same page): within minutes of the first new order or product change on the store, rows such as `orders/create`, `orders/updated`, `products/update` with status *Processed*. A *Failed* row has a retry button and its error.
- `/t/<store>/orders`: the latest orders are there, with the same numbers as in Shopify admin.
- Console checklist: "Shopify connected" and "Order history imported" ticked.

## 4. Order states: rules and preview

Hullwise has its own order statuses (new, pending review, confirmed, fulfilling, shipped, delivered, on hold, cancelled, returned…), computed from what Shopify says through rules the store controls; nothing is read from hard-coded tags.

**Do.** `/t/<store>/settings/order-states`: read the default rules with the merchant; adapt them to how they work (e.g. orders tagged `hold` → on hold, a payment method that needs a manual check → pending review). Each rule: conditions (tags, payment method, financial status, fulfillment status), resulting status, priority (lowest first; cancellations, refunds, returns and deliveries always win).

**Check.** The **Preview on recent orders** table on the same page runs the current rules on the store's **last 50 orders**: "On the last 50 orders the current rules would change N"; changed rows are highlighted with *Current* and *Would be*. Go through the highlighted rows with the merchant until every *Would be* is what they expect. Console checklist: "Order state rules" ticked (at least one active rule).

## 5. Costs (without them, margins look better than they are)

**Do.**
1. **Product costs.** If the merchant fills Shopify's "Cost per item", the import already brought it (source *platform*). Otherwise, or to correct it: `/t/<store>/products/import-costs` → upload a CSV with `sku,cost` (Shopify's cost export works as is; template downloadable) → **Preview** (nothing written yet, unmatched SKUs listed) → choose "Fill only orders without a cost" or "Restate all past orders" → import. A single product: its page → **Product cost**. Later, receiving a purchase order updates the cost too.
2. **Payment fees.** `/t/<store>/settings` → **Thresholds & fees** → **Payment fees**: percentage (basis points, 180 = 1.80%) and fixed fee per order for each method (card, wallet, bank transfer, BNPL, cash on delivery, other).
3. **Shipping.** Same tab: "Default shipping cost" per order; then `/t/<store>/analytics/costs` for the monthly carrier invoice (estimate first, actual when known) and the fixed costs (rent, payroll, tools).
4. **Tax rates.** `/t/<store>/settings` → **Tax rates**: one rate per shipping country they sell to, and whether prices include tax.

**Check.**
- Missing-cost report: `/t/<store>/products/quality?issue=missing_cost` lists the active variants without a cost; aim for none, or only negligible ones.
- `/t/<store>/analytics?tab=pnl` for last month: no "N orders contain products without cost" warning (or a share the merchant accepts); the link in the warning opens those orders.
- Console checklist: "Cost settings" ticked.

## 6. Ads: Meta, Google, TikTok (and GA4)

**Do.** `/t/<store>/integrations`, one card per platform, each with its own checklist and the merchant at the keyboard:
- **Meta Ads**: system user in their Business Manager, never-expiring token with `ads_read`, `ads_management`, `business_management`, ad account id; more ad accounts can be added from the card. Pixel id for the Conversions API is optional.
- **Google Ads**: **Sign in with Google** and pick the account (requires the platform's Google app, see DEPLOY); otherwise the advanced path with their own credentials.
- **TikTok Ads** (Growth plan and up): **Connect TikTok** and pick the advertiser accounts.
- **Google Analytics 4** (optional): add our reader email as Viewer on their property, paste the property ID.

**Check.**
- Each card **Connected**, *live*, with the account name; **Test connection** answers OK.
- **Recent sync runs**: `meta/…`, `google/…`, `tiktok/…` rows with status *Success*; spend appears day by day at `/t/<store>/campaigns`, and the **Ads daily register** (`/t/<store>/campaigns/ledger`) matches the spend in the platform's own Ads Manager for yesterday (small differences for today are normal: the platforms restate recent days).
- Console checklist: one tick per ad platform of the plan.

## 7. Users and roles

**Do.** `/t/<store>/users` → **Invite a member**: email, role, optional name. Roles: owner (everything, billing, data export), admin, operations, customer care, marketing, viewer; the matrix of what each role can open is in the app. Needs email (step 2).

**Check.** Each person shows as *Active* after accepting; "Invitations" shows the pending ones with their expiry. Console checklist: "At least two users" ticked. Ask one non-owner to sign in and confirm they see what they need and nothing more.

## 8. Add-ons on request

Add-ons (cash on delivery, customer campaigns, WhatsApp, subscriptions, accounting push, …) are switched on per tenant by the platform owner, when sold.

**Do.** `/admin/tenants/<id>` → **Plan and add-ons** → switch on the add-on (only released versions can be switched on), with a note. Then configure it in the store: e.g. cash on delivery at `/t/<store>/cod/settings`, WhatsApp at `/t/<store>/whatsapp/settings` (paste our webhook URL in Spoki), subscriptions from the **Subscriptions** card in Integrations. Connectors marked "On request" (3PL, local messaging providers) are custom work, not a switch.

**Check.** The add-on's pages appear in the store's menu; the console's tenant page shows it active with the date; the next invoice includes it.

## 9. Final review with the merchant

**Do.** Pick the last closed month and walk through it together:
- `/t/<store>` (dashboard) and `/t/<store>/analytics` (**Overview**): revenue, orders, AOV, cancellation and return rates, new and returning customers, with the comparison to the previous period.
- `/t/<store>/analytics?tab=pnl`: net revenue, cost of goods, gross margin, shipping, payment fees, contribution margin, advertising, fixed costs, operating profit. Every number opens the orders behind it.
- `/t/<store>/campaigns`: spend, attributed orders, profit and ROAS per campaign; the recommendations take stock into account.

**Check.** The merchant recognises the numbers (no orders missing, no absurd margin). Anything odd usually comes from a missing cost (step 5), an order state rule (step 4) or a tax rate (step 5.4).

## 10. Reconcile with Shopify admin (±0.5%)

**Do.** For the same closed month:
- Hullwise: `/t/<store>/analytics/daily-sales?from=<YYYY-MM-01>&to=<YYYY-MM-last>` → **Total** row: gross sales, discounts, refunds, net sales, shipping, tax, total, and the number of sales. Export CSV if useful.
- Shopify admin: **Analytics → Reports → Finances summary** (or "Total sales over time") for the same dates (report names change: to verify on the day). Shopify defines gross sales − discounts − returns = net sales, + shipping + taxes = total sales, the same identity as the Hullwise page.

**Check.** Net sales and the number of orders within **±0.5%**. If not, in this order: the time zone (tenant settings vs Shopify's store time zone: a different one moves orders across days and months), the history import (step 3: did it cover the whole month?), test orders, POS or draft orders the merchant does not count, gift cards, orders in a presentment currency other than the store currency, refunds dated in another month. Write the two figures and the difference in your onboarding sheet.

## After go-live

- Watch for a week: `/t/<store>/integrations` (no card in error, sync runs green), the console's **Alerts** and **Integrations** pages.
- Check the lifecycle on the console's tenant page: trial until the subscription is paid, then active.
- Privacy requests, tenant deletion, secret rotation, backups: `docs/DEPLOY.md`, **Production**.
