# Gap analysis: Keel vs specialised tools

Audit of the Keel code base (commit `eae3092`) against the feature list of the depth programme. Status values: **PRESENT** (usable end to end), **PARTIAL** (model or a piece exists, the feature as specialists ship it does not), **ABSENT**. Effort: S (≤ half a day), M (1–2 days), L (3+ days). **EXTERNAL** marks features that need something outside this repository (an approved Shopify app or extension, a carrier or label contract, an LLM or ads API account with specific permissions, data from many clients): for those Keel ships the architecture, a mock adapter and the activation steps.

The table is updated at the end of every area: rows that moved from ABSENT/PARTIAL to PRESENT keep the note of what changed.

## Area 1 — Analytics, attribution, profit

| # | Feature | Status | What is missing | Effort | External |
| --- | --- | --- | --- | --- | --- |
| 1.1 | First-party pixel: sessions, events, cross-visit identity | ABSENT | Everything: event schema, collect endpoint keyed per tenant, identity stitching (customer id, hashed email, client id), session model, mock traffic in the seed. The collecting script must ship as a Shopify Web Pixel extension. | L | **EXTERNAL**: Shopify app with Web Pixel extension |
| 1.2 | Server-side conversions to Meta CAPI and Google Enhanced Conversions with dedup | ABSENT | `sendConversions` on `AdsPlatform`, event id dedup with the pixel, hashing of identifiers, retry queue, delivery log; mock + fixture tests. | M | Meta pixel/token and Google conversion actions on the client's accounts (credentials, no approval) |
| 1.3 | Selectable attribution models (first, last, linear, time decay, position, last platform click) | PRESENT | Was PARTIAL. Six models (first, last, linear, time decay, position based, last platform click) in `core/attribution-models` over `touchpoints` (order landing + earlier visits; pixel sessions once 1.1 is live), fallback to the order's own attribution; Analytics → Attribution with model and channel/campaign switch, last-click and platform-claim columns. | M | — |
| 1.4 | Platform-reported vs real attributed conversions | PRESENT | Was PARTIAL. Declared vs real per platform on Campaigns (purchases, value, ROAS, gap %) and per campaign/channel in the Attribution tab; per creative on the Creatives page. | S | — |
| 1.5 | Blended metrics: MER, nc-ROAS, CAC blended and per channel, POAS | PRESENT | Was PARTIAL. MER, nc-ROAS, blended CAC, CAC per paid channel, POAS from Keel's own economics; new customer = first non-cancelled order. Overview card + custom-metric base metrics. | S | — |
| 1.6 | Creative analysis: per ad and creative, previews, format/hook/angle grouping, fatigue | PRESENT | Was ABSENT. `ad_creatives` + daily metrics per creative, naming-convention tags (format / hook / angle), real orders via landing touch, CTR, CPC, thumb-stop, fatigue (CTR decay, frequency). Live fetch from Meta at ad level is part of the external block; previews are local placeholders. | M | — (Meta API fields; fixture-tested) |
| 1.7 | LTV and cohorts: 30/60/90/180/365 by acquisition cohort, channel, first product; time to repurchase; CAC payback | PRESENT | Was PARTIAL. LTV 30/60/90/180/365 on matured customers by acquisition month, channel or first product; repeat rate; median days to 2nd order; CAC and payback per cohort month. | M | — |
| 1.8 | Product analysis: entry products, bought together, first→second purchase path | PRESENT | Was PARTIAL. Entry products ranked by 365-day value, bought-together pairs with lift, first → second purchase paths with median days. | M | — |
| 1.9 | Post-purchase survey integrated in attribution | ABSENT | Schema for responses, ingest endpoint, weighting into the attribution engine, mock responses in the seed. The form lives in a checkout UI extension. | M | **EXTERNAL**: Shopify checkout extension |
| 1.10 | Custom metrics with a formula builder, per-user dashboards | PRESENT | Was ABSENT. Formula builder (safe parser, 18 base metrics, money/ratio/percent/number), shared custom metrics, per-user dashboard with period comparison. | L | — |
| 1.11 | Alerts: anomalies on spend, ROAS, conversion, stock; email and Slack | PRESENT | Was PARTIAL. Threshold and robust anomaly rules on revenue, orders, spend, MER, platform ROAS, AOV, cancel rate, stock-outs; cooldown; hourly job; in-app, email (provider adapter + mock) and Slack incoming webhook (live adapter, fixture-tested). Email needs the platform's provider key. | M | Email/Slack credentials of the tenant (adapter + mock) |
| 1.12 | End-of-month forecast for revenue and spend | PRESENT | Was ABSENT. Weekday-weighted run rate with band for revenue, orders and spend; dashboard and Analytics overview. | S | — |
| 1.13 | AI assistant in natural language with cited figures and filters | ABSENT | `LlmProvider` interface, tool-calling over the analytics services (never raw SQL), answer with the numbers and filters used, mock provider for the demo. | L | **EXTERNAL**: LLM API key |
| 1.14 | Fixed and shipping costs per period, estimate vs actual (requested by Federico) | PRESENT | Was PARTIAL. `period_costs` with estimate and actual per month for fixed lines and the shipping invoice; P/L uses actual ?? estimate and says which. | S | — |

**Area 1 status (2026-10-01):** every non-external feature is PRESENT. 1.1 (pixel), 1.2 (server-side conversions), 1.9 (post-purchase survey) and 1.13 (AI assistant) are handled in the external block: architecture, mock adapter, activation steps.

## Area 2 — Inventory and purchase planning

| # | Feature | Status | What is missing | Effort | External |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Demand forecast per SKU, 12 months, seasonality, trend, promotions/events, manual override | PARTIAL | Only a velocity over a lookback window. No monthly model, no seasonality indices, no event uplift, no overrides, no forecast table. | L | — |
| 2.2 | Demand plan from a revenue target | ABSENT | Allocation of a target revenue to SKUs by share and price, stock required per SKU. | M | — |
| 2.3 | Reorder with lead time, safety stock, service level, MOQ, multiples, costs | PARTIAL | `reorderSuggestion` to target days; `suppliers.lead_time_days` stored but unused; no safety stock, service level, MOQ, multiples, supplier assignment per variant. | M | — |
| 2.4 | Automatic PO drafts grouped by supplier, PDF to supplier, confirmation tracking | PARTIAL | A PO can be pre-filled from one product's suggestion. No grouping run, no PDF, no send/ack tracking. | M | Email provider for sending (adapter + mock) |
| 2.5 | Partial receipts, ordered vs received differences, landed cost allocated to product cost | PARTIAL | Partial receipts and backorders exist. No landed cost (duties, freight, fees) and no allocation. | M | — |
| 2.6 | Multi-location forecast and reorder, transfer suggestions | PARTIAL | Levels per location; reorder aggregated across locations; no transfers. | M | — |
| 2.7 | Bundles and kits with derived stock | ABSENT | Bundle components table, derived availability, sales explosion into components for velocity. | M | — |
| 2.8 | Raw materials and bills of materials | ABSENT | Materials, BOM per variant, consumption on production or sale, reorder of materials. | L | — |
| 2.9 | Cash flow impact of purchase plans | ABSENT | Payment terms per supplier, cash out schedule per PO and per plan. | M | — |
| 2.10 | Stock analysis: excess, slow movers, tied-up value, cover, turnover, ABC/XYZ | PARTIAL | Cover days and risk exist. No excess/slow mover view, no value tied up, no turnover, no ABC/XYZ. | M | — |
| 2.11 | Stock-out alerts with predicted date | PARTIAL | Risk tiers exist; date not shown; no alert delivery (ties to 1.11). | S | — |

## Area 3 — Returns and exchanges

| # | Feature | Status | What is missing | Effort | External |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Branded customer return portal, multilingual, order number + email | ABSENT | Public route per tenant, lookup, line/quantity/reason selection, custom fields, texts/colours/logo per tenant, submission into `return_requests`, notifications. | L | — |
| 3.2 | Eligibility rules by product, collection, country; exclusions; conditions; per-customer limits | PARTIAL | Window, excluded product types, shipping fallback days. No per-collection/country windows, no conditions, no per-customer limits. | M | — |
| 3.3 | Exchanges: variants of the same product, "shop now" credit with difference to pay | PARTIAL | `resolution = exchange` and `exchange_order_id` exist; no variant picker, no credit flow, no difference payment. | M | Difference payment via Shopify draft order invoice |
| 3.4 | Instant exchange before the return arrives, with guarantee authorisation | ABSENT | Replacement order creation exists (`createOrder`); the guarantee needs a card authorisation. | M | **EXTERNAL**: payment authorisation (Shopify) |
| 3.5 | Bonus on store credit to prefer credit over refund | ABSENT | Bonus % per tenant, applied when the customer chooses credit; voucher creation exists. | S | — |
| 3.6 | Automatic workflows with conditions (auto-approve under a threshold, inspection for categories) | ABSENT | Rule table, evaluator (pure), hooks on request creation and transitions. | M | — |
| 3.7 | Return labels via provider, QR without printer, multiple destinations | ABSENT | `LabelProvider` interface, mock, destinations per tenant, label/QR on the portal. | M | **EXTERNAL**: EasyPost/Shippo or carrier contract |
| 3.8 | Return fraud: serial returners, wear-and-return, flags | ABSENT | Generic customer return profile (count, rate, value) with thresholds and flags; the COD add-on has a similar model for recipients. | M | — |
| 3.9 | Returns analytics: rate by product, size/option and reason; revenue saved by exchanges; return cost in P/L | PARTIAL | By reason, fault, outcome, product. No per-option breakdown, no revenue saved, return cost in P/L is the refunded amount only. | S | — |
| 3.10 | Branded tracking page and status emails for the end customer | ABSENT | Public tracking route, shipment events timeline, email templates per status (adapter + mock). | M | Carrier events beyond Shopify are **EXTERNAL** |
| 3.11 | Write returns back to Shopify: mark as returned, refund, restock (requested by Federico) | ABSENT | `createReturn`/`refund` on `CommercePlatform`, calls on the workflow transitions, financial status sync. | M | — |

## Area 4 — CRM and retention

| # | Feature | Status | What is missing | Effort | External |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Dynamic segments in real time, synced to Meta Custom Audiences and Google Customer Match | PARTIAL | Segments are evaluated on demand and memberships stored. No incremental re-evaluation on order events, no audience sync. | M | **EXTERNAL**: ads accounts with audience permissions (adapter + mock) |
| 4.2 | Per-customer predictions: repurchase probability, next order date, expected LTV, churn risk | ABSENT | Pure model on inter-purchase times (recency/frequency based), stored per customer, usable in segments. | M | — |
| 4.3 | Export of segments to email tools through an adapter | PARTIAL | CSV export and a `MessagingChannel` interface. No `AudienceDestination` adapter, no push. | S | Email tool API keys (mock) |
| 4.4 | Campaigns with control group and incremental margin | PARTIAL | Holdout assignment and two-proportion test exist. No campaign entity, no exposure log, no incremental margin report. | M | — |

## Add-on COD — what the Control Room has and Keel does not (read-only scan of the reference)

Only features that are not client-specific. The Spoki/WhatsApp pieces, Elogy, Google address validation are **EXTERNAL** and go behind interfaces.

| # | Feature in the reference | Keel today | What to replicate | Effort |
| --- | --- | --- | --- | --- |
| C.1 | Queue tiles with count and average age per bucket, click to filter | Counts per view | Aging per bucket, tile filter | S |
| C.2 | Row colour by last call age; aging badge when never contacted | — | Same, from `last_attempt_at` / `entered_at` | S |
| C.3 | Auto-refresh every 30 s and on focus; prev/next navigation that keeps queue context | — | Client refresh + detail navigator | M |
| C.4 | Bulk actions: assign selected, distribute equally, bulk confirm/cancel, transfer | Distribute only | Selection bar with the four actions | M |
| C.5 | Schedule confirmation on a date (auto-confirm that morning) | Call-back scheduling only | `scheduled_confirm_at` + tick job | S |
| C.6 | Confirm dialog with copyable SKU × qty list for the warehouse | — | Add to the outcome dialog | S |
| C.7 | Pre-check dialog on opening a queued order: critical/warning factors, previous addresses, recompute when stale | Score card only | Auto-open dialog | M |
| C.8 | Duplicate siblings banner and lineage banner (replaces / replaced by) | Duplicates list; lineage events only | Banners on the order page | S |
| C.9 | Transfer menu: release, pass to colleague, escalate to admin, with the "no transfer after first call" rule | Claim/release | Full menu | S |
| C.10 | Dashboard widgets: COD pending (today / yesterday / 7 days), tickets per operator, my assigned split | None on the dashboard | Add-on widget slot on the dashboard (architecture) + the three widgets | M |
| C.11 | Customer-care console: my queue, supervisor per operator with bottleneck badge, efficiency (handled, confirmed, cancelled, attempts per confirmation, throughput) | "Mine" view and 7-day KPI table | Supervisor and efficiency tabs | M |
| C.12 | Apply a discount to an order before confirmation | — | `applyDiscount` on the adapter + dialog | M |
| C.13 | Change payment method on recreate (COD → card / bank transfer, drop the COD fee line) | Replacement keeps COD | Option in the modify dialog | S |
| C.14 | Risk panel details: refused %, wasted cost, expected value, linked phones | Tier and suggestion | Richer panel | S |
| C.15 | Score preview on an order from settings | — | Order number input + badge | S |
| C.16 | Sidebar badge with queue count; mobile card layout | — | Both | S |
| C.17 | WhatsApp: configurable templates, copy-to-clipboard, send via provider, status badge, conversation timeline | `MessagingChannel` interface + mock | Templates per tenant, send through the adapter, inbound status via webhook | M, **EXTERNAL** provider |
| C.18 | Address validation (Google) feeding the score | Heuristic address quality | `AddressValidator` interface + mock | S, **EXTERNAL** |
| C.19 | Carrier billing import (delivered / refused outcomes) feeding recipient risk | Outcomes from orders only | Generic CSV import of carrier outcomes | M |
| C.20 | Activity pings and operator presence | — | Not replicated: low value per complexity; efficiency metrics computed from attempts and assignments instead | — |

Documented in the reference but not implemented there (sorted priority, outcome per attempt, automatic unreachable, call-back with date/time, templates in settings): Keel already has them.

## Execution order

1. Area 1 without external dependencies: 1.14, 1.5, 1.7, 1.8, 1.4, 1.3 (engine on order touchpoints), 1.6, 1.11, 1.12, 1.10.
2. Area 2: 2.1, 2.3, 2.4, 2.5, 2.9, 2.10, 2.11, 2.6, 2.2, 2.7 (2.8 last).
3. Area 3: 3.1, 3.11, 3.2, 3.3, 3.5, 3.6, 3.8, 3.9, 3.10.
4. Area 4: 4.2, 4.4, 4.3, 4.1.
5. External features: architecture, mock adapter, activation steps (1.1, 1.2, 1.9, 1.13, 3.4, 3.7, 4.1 sync, C.17, C.18).
6. Add-on COD items C.1–C.16, C.19.
