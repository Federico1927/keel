> Historical document: the product was formerly called Keel.

# Feature inventory of the reference platforms

Read-only study of the two client codebases, performed before writing any Keel code (2026-10-01).

| Platform | Location studied | Stack |
| --- | --- | --- |
| **Control Room / Command Center** ("CC") | `/home/user/lorena-control-center` (GitHub `Federico1927/lorena-control-center`) | React + TS (Vite, Lovable), Supabase: Postgres + RLS, Deno edge functions, pg_cron. ~240k orders, single tenant, Italian shoe brand, heavy cash on delivery. |
| **Rehaus Ops Studio** ("RH") | `/home/user/rehaus-ops-studio-533b1b8f` (GitHub `Federico1927/rehaus-ops-studio-533b1b8f`) | React + TS (Vite, Lovable), Supabase. UK pre-owned designer furniture consignment: sellers, settlements, payouts, Xero, partner portals. |

Nothing was copied from either repository: no files, no `.env`, no keys, no personal data. Logic is described here in words and re-implemented for Keel's canonical model. Detailed study notes (algorithms in pseudo-code, file paths) were produced per area and condensed into this document.

## Classification key

| Tag | Meaning | Where it goes in Keel |
| --- | --- | --- |
| **CORE** | Generic: useful to any e-commerce, whatever the payment method | `packages/core`, `packages/db`, `apps/web` modules of section 7 of CLAUDE.md |
| **ADDON.COD** | Only makes sense when cash is collected at delivery | `addon.cod`, phase 11, behind a feature flag |
| **ADDON.OTHER** | Generic concept, but a connector sold per account (3PL, carrier, WhatsApp) | Interface + mock only; catalog entry "available on request" |
| **DISCARD** | Client-specific (Lorena, Italy, shoes, Elogy, GLS, Qapla', Spoki, Releasit, Shopify Flow workarounds; Rehaus consignment business) | Not ported |
| **PATTERN** | The business feature is client-specific but the engineering pattern is reused | Pattern re-implemented where noted |

---

## 1. Orders, Shopify sync, webhooks (CC)

| Feature | From | Class | What Keel reuses (logic, not code) |
| --- | --- | --- | --- |
| Webhook receiver: HMAC verified synchronously on the raw body, immediate `200`, processing in background | CC `shopify-webhook` | CORE | Verify → persist raw event → enqueue pg-boss job → ack. Internal errors still ack 200 so the platform never disables the webhook. Fail closed when the secret is missing. |
| Webhook log table as idempotency store + retry queue + audit | CC `shopify_webhook_logs` | CORE | `webhook_events(tenant_id, source, topic, external_id, source_updated_at, payload, status, attempts, last_error)` with a unique key on `(tenant, source, topic, external_id, source_updated_at)` replacing CC's 60-second dedup heuristic. Replay from the log; max 3 automatic retries, then manual. |
| Topic → handler dispatch table; idempotent upsert handlers keyed by external id | CC `TOPIC_HANDLERS` | CORE | Same shape in the Shopify adapter: `orders/*`, `fulfillments/*`, `products/*`, `inventory_levels/update`, `customers/*`, `returns/*`, `app/uninstalled`. |
| Idempotent webhook self-registration (diff against existing subscriptions) | CC `registerWebhooks` | CORE | "Connect" step registers only missing topics and reports per-topic status on the integration page. |
| Order payload mapping with field precedence: `current_total_price` over `total_price`; phone fallback `order → shipping → billing → customer`; name fallback `customer → shipping → billing` | CC `mapOrderData` | CORE | Same precedence in `packages/integrations/shopify/mappers`. Gateway → payment method goes through a **per-tenant configurable gateway map** (CC hardcodes `cod/carta/paypal`). |
| No-op skip on noisy `orders/updated` using a fingerprint of significant fields including line items | CC `upsertOrder` | CORE | `orderFingerprint(order)` pure function; skip write and events when unchanged, but never skip when local line items are missing. |
| Non-destructive line-item sync: upsert first, delete stale rows only after success, per-row fallback | CC webhook + sync | CORE | Same ordering in the order upsert service. |
| Timeline event with structured diff on every platform update and every operator edit | CC `order_events` | CORE | `OrderEvent(type, actor_id nullable, diff jsonb {field:{from,to}}, tags/items as {added,removed,updated})`, produced by a pure `diffOrder(prev, next)` in `packages/core`. System vs user attribution rule. |
| Internal notes with `@mentions` → one notification per mentioned user, excluding the author | CC `order_internal_notes` | CORE | Mention parsing regex, keep only mentions whose label survives in the text, fan-out at write time. Platform note and internal notes are two different entities. |
| Customer order history: normalized strong keys (platform id, email, phone, address) with up to 3 hops of transitive closure (cap 300) and weak `name+zip` match never expanded | CC `get_customer_order_history` | CORE | Same algorithm on canonical `customers` + `orders`, keys computed with libphonenumber E.164 instead of Italian digit stripping; `matched_via` and `hops` exposed to the UI; buckets delivered / in progress / returned / cancelled with counts and amounts. |
| Previous address suggestions from history | CC | CORE | Dedupe history addresses by normalized key. |
| Duplicate order detection: same customer by platform id, email or phone, ±5 days, open orders, sharing a product or a variant; lineage excluded | CC `get_duplicate_sibling_orders` | CORE | `findDuplicateOrders(order, siblings, window=5d)` in core, "service line" matcher configurable per tenant instead of the Italian regex. Banner in order detail. |
| Cancel & recreate with lineage (`replaces`, `replaced_by`, `lineage_root`); replaced order is a terminal state excluded from KPIs; new order inherits creation day for metrics | CC `cancel_and_create` | CORE (model) | Lineage columns on `orders`; `replaced` excluded from KPIs. The forced "cancel and recreate for any product edit" is a Releasit/Elogy workaround → DISCARD. |
| Local cancellation guard: terminal local states never overwritten by upstream sync | CC `applyLocalCancellationGuard` | CORE | Pure guard applied by webhook, sync and reconciliation. |
| Ghost order handling: probe remote before mutating, on 404 align locally and log an event | CC `cancel` action | CORE | Same in the cancel action of the Shopify adapter. |
| Cancel with refund of remaining captured amount + restock; if restock fails still cancel and log | CC `buildRefundPayload` | CORE | Same decision order. |
| Customer name propagation to orders, capped event noise (10 most recent), never blank a name | CC `customerNameSync` | CORE | Pure diff function. |
| Periodic delta sync with resumable cursor: rolling window, high-water mark with 2-minute overlap, early exit on empty first page, cursor persisted after every page, time budget then resume | CC `shopify-sync` | CORE | `sync_runs(tenant_id, integration, object, cursor jsonb, high_water_mark, status)`; pg-boss job re-enqueues itself until the cursor is exhausted. |
| Monthly / nightly reconciliation: candidates from DB, remote fetch in batches of 250 by ids with reduced fields, skip unchanged, apply guard, run row with counters | CC `shopify-monthly-reconcile` | CORE | Nightly job per tenant over the last N days (tenant setting), results shown on the integration health page. `closed_at` is never treated as cancelled. |
| Targeted re-sync tool with modes, dry run and background flag | CC `shopify-resync-by-ids` | CORE | "Resync" button on the integration page uses the same service with `dryRun`. |
| Budgeted historical backfills that stop when a round updates nothing | CC `shopify-backfill-*` | CORE | Pattern for the initial historical import (phase 9). |
| Marketing attribution: UTM and click ids (`fbclid`, `gclid/gbraid/wbraid`, `ttclid`, `msclkid`) from landing site, referrer and note attributes with key normalization; campaign resolved by external id → normalized name → primary product link; three capture levels upserting one row per order; derived channel with priority rules | CC `_shared/orderAttribution.ts`, `compute_order_channel` | CORE | `extractAttribution(payload)` + `resolveCampaign` + `deriveChannel` in core; `order_attribution` table. `lm_pid`/`lm_aid` custom params → DISCARD. |
| Order state derived from a fixed list of Italian tags, replicated in four places | CC `deriveOrderState`, `derive_order_workflow_from_tags`, `pl_order_workflow_status` | DISCARD (vocabulary) / CORE (lessons) | Keel: one `canonical_status` column written on every change by a single pure function evaluating per-tenant `state_rules` (conditions on tags, payment method, financial status, fulfillment status; priority). Hard overrides above any rule: `cancelled_at`, `voided`, `refunded`. Holds ("awaiting stock") outrank confirmation. Fulfillment and delivery are separate dimensions with explicit precedence for the primary badge. |
| Dashboard RPC with "running" comparisons (today vs yesterday vs 7 days ago at the same time of day) in the tenant timezone, one query for the whole KPI row, shared exclusions with P/L | CC `dashboard_summary` | CORE | Period comparison helper in core, timezone from tenant settings. COD counters → ADDON.COD. |
| Orders list: order-number detection routed to exact match, trigram search on a generated `search_blob`, server-side filters, page size 50, estimated counts, retry with backoff, filters persisted in session | CC `OrdersTable`, `v_orders_list` | CORE | Generated search column + GIN trigram index per tenant; filters in URL search params; RLS by simple equality on `tenant_id` (leakproof friendly) so no special view is needed. |
| Bulk actions with bounded parallelism (3) and one summary toast | CC `BulkActionBar` | CORE | Same. |
| Sticky "origin" flag (created from draft) set once by trigger | CC | CORE | `orders.source_channel` / `created_from_draft`, monotonic. |
| Scheduled actions stored as `scheduled_at` + `scheduled_by`, applied by a daily job, retried by not clearing the field | CC `scheduled_confirm_at` | PATTERN | Pattern kept for the COD confirmation schedule (ADDON.COD); not needed in core. |
| Operator activity tracking (idle-aware pings, sessions by gap, "handled" = authored events) | CC `user_activity_pings` | PATTERN | Generic time-on-entity tracking is deferred (not in MVP); confirm rate and attempts per confirmation are ADDON.COD. |
| Manual order creation with stock capacity check and backorder hold | CC `create` action | CORE (later) | Capacity decomposition reused for purchasing (section 3). Manual order creation is not in the MVP scope. |
| Variation lock / tag sanitation against Shopify Flow | CC `variationLock.ts` | DISCARD | Symptom of tag-as-state. |
| Releasit quirks, `ORDER_NOT_EDITABLE` strings, fulfillment-hold hacks | CC | DISCARD | |
| COD fee line auto-added, "Carta da confermare → Già pagato" swap, mark-as-paid tag reset | CC | DISCARD | "Record a manual payment" survives as a generic payment event without tag semantics. |
| Italy constants: `+39`, `0039` stripping, `Europe/Rome`, EUR, 22% VAT-included, `LM-` prefix, Google Places restricted to IT, shoe size heuristics | CC | DISCARD | All become tenant settings: country, currency, timezone, tax rates per country, order number prefix. |
| Supabase-specific mechanics: `EdgeRuntime.waitUntil`, 25-second budgets, self-invoking HTTP continuation, `security_invoker=false` views, `app_settings` as job state | CC | DISCARD (mechanics) / PATTERN (ideas) | Budgeted resumable jobs re-implemented with pg-boss. |

## 2. Shipments and logistics (CC)

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| One shipment row per order, each source owns its own columns, the visible status is computed by a resolver and `source_of_truth` records who won | CC `logistics_shipments`, `recompute_shipment_status` | CORE (model) | `shipments` + `shipment_source_states(shipment_id, source, status, detail, last_event_at)` child rows (instead of hardcoded Elogy/Qapla'/GLS columns) + pure `resolveShipmentStatus(states, precedence)` in core. Today the only source is Shopify fulfillments; precedence list per tenant `[{source, freshness_hours, priority}]`. |
| Precedence: fresher source within a freshness window wins, then fallback chain, else `pending`; sticky exception only with a real reason and younger than N days; admin locks never touch status; `delivered`/`returned` never demoted; conflicts logged as events | CC trigger | CORE | Same rules, constants per tenant (freshness 24h, sticky max 15 days). |
| Editable mapping table provider status → canonical status with `is_exception`, `is_final` | CC `qapla_status_mapping` | CORE | `shipment_status_mappings(tenant_id, source, external_status, canonical_status, is_exception, is_final)`. |
| Read-side 6-level effective status (final beats non-final, fresher non-final wins, app status last) and "stale" = unfinished and older than N days | CC `logistics_effective_rows` | CORE | Shipments list buckets and "stuck more than N days" filter (N per tenant). |
| Order-arrival-independent outcome fold with `least/greatest` on first/last delivered/return timestamps; outcome `refused` vs `returned_after_delivery` vs `delivered` | CC `elogy_ingest_outcome_event` | CORE | Pure `foldShipmentOutcome(events)` in core; separates carrier refusals from customer returns for P/L and (in the add-on) risk. |
| Delivery propagation shipment ↔ order with no demotion from terminal states | CC triggers | CORE | Service-level propagation when a shipment resolves to delivered/returned. |
| Shopify fulfillment → shipment: pick delivered-or-latest fulfillment, map `shipment_status` to canonical buckets, fill only empty fields, only upgrade from pending | CC `pickBestFulfillment`, `mapShopifyShipmentStatus` | CORE | Same in the Shopify adapter. |
| Exception work queue: auto-enqueue, soft claim, auto-close with `auto_*` resolutions, reopen only auto-closed rows, dry run | CC `gls_giacenze_queue` | PATTERN | Generic "shipment exceptions" list in the shipments module (read-only queue, no carrier actions). GLS hold emails, branch codes, rules engine → DISCARD. |
| "Source coverage gap" alert (shipment never seen by a source for 24h) | CC `qapla-reconcile` | PATTERN | Deferred; relevant only with a second source. |
| Carrier returns automation (cancel on Shopify without restock + void pending payment on refused COD parcels) | CC `carrier_return_actions` | ADDON.COD / DISCARD | Business rule is COD and 3PL specific. The worker pattern (`FOR UPDATE SKIP LOCKED`, attempts, 429 requeue, backoff) is used by pg-boss anyway. |
| 3PL order push, Elogy numeric codes, Qapla' and GLS webhooks, Italian status names | CC | DISCARD | Slots kept as `WarehouseProvider` and `CarrierProvider` interfaces with mocks (ADDON.OTHER). |

## 3. Catalog, inventory, reorders, purchasing (CC)

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| Inventory current state per variant with `synced_at`; missing row = "not synced", never out of stock | CC `inventory_snapshots` | CORE | `inventory_levels(variant_id, location_id, available, committed, incoming, synced_at)` — CC collapses locations, Keel keeps them. |
| Four inventory sync levels: realtime targeted refresh on webhooks, nightly full sync with high-water mark and zeroing of untouched rows, manual force sync, on-demand per-variant refresh | CC `shopify-sync`, `shopify-refresh-variant-stock` | CORE | Same levels in the inventory service; full sync chunked with resume cursor; products with ≥100 variants expanded. |
| Capacity decomposition: stock now, incoming (POs in configurable statuses), committed in open orders, backorders, next arrival | CC `compute_variant_capacity` | CORE | Pure `variantCapacity()` in core. CC uses three different "incoming" status sets; Keel has one configurable set per tenant. |
| Sales velocity / coverage / risk: `velocity = units_sold(non-cancelled, lookback L)/L`, `effective = stock + incoming`, `days_left = effective/velocity`, risk critical if `effective = 0` or `≤ 7` days, warning `≤ 21`, product = worst variant | CC `reorder_dashboard_grouped` | CORE | Exact formulas in `packages/core/inventory`, lookback and thresholds from tenant settings. |
| Reorder suggestion rounded to supplier pack size: `ceil(max(velocity×target − effective, 0)/pack)` | CC size-curve cartons | CORE (generalised) | "Pack size" per variant/supplier optional; shoe size curves, cartons 24/30 → DISCARD. |
| Idempotent "uncovered critical" alert refresh with `priority_score = 100 if stock=0 else max(0, 50 − 5×days_left)` | CC `refresh_uncovered_critical_alerts` | CORE | Low-stock notifications. |
| Option × option inventory matrix with incoming units per cell, natural sort | CC `productInventory.ts` | CORE (generalised) | Axes are the product's dynamic options, not colour × size. |
| Suppliers with separate billing entity (`payee_name`) and packing defaults | CC `suppliers` | CORE | Same fields. |
| Purchase orders: states with per-state timestamps set on transition, line total generated, order total maintained, non-catalog lines, history | CC `purchase_orders` | CORE | States renamed in English: `draft → sent → confirmed → in_transit → partially_received → received`, `cancelled`. |
| Receiving → stock: upsert-increment on receipt | CC `po_stock_snapshot` | CORE | Receipt creates `inventory_movements` rows (not an overwrite) at the chosen location; optional Shopify write-back behind confirmation. |
| Receiving → product cost feeding P/L | CC frontend write of `last_purchase_cost` | CORE (fixed) | Done server-side on receipt; `last_cost` and moving average kept on the variant. |
| Backorders linked to PO lines; on receipt recompute `fulfilled / covered / pending`, release held orders with event + notification; "covers N orders" badge on POs | CC `order_item_backorders`, `orders-check-backorder-stock` | CORE | Same, triggered on the receiving transition only. |
| Supplier balances derived from PO status and `paid_at` | CC `supplier_outstanding_balances` | CORE (improved) | `supplier_payments` table; balance = Σ non-draft, non-cancelled PO totals − Σ payments. |
| Catalog / PIM: product creation with code, colour × size variants, SKU convention, AI colour translation, bulk publish | CC | DISCARD (PIM) / CORE (publish pattern) | Keel syncs the catalog from Shopify and writes back only price and status. Variant match priority (SKU → platform id → option set) kept for write-back. |
| Italian product categories, service SKUs filtered by name, destination warehouse CHECK list | CC | DISCARD | `is_ancillary` flag kept as a column, names not hardcoded. |

## 4. Customer returns and discounts (CC)

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| Returns config per tenant: window days, shipping fallback days, customer-fault return cost, exclusions by SKU / prefix / title | CC `returns_config` | CORE | `return_policies` per tenant + `return_reasons` table (CC hardcodes Italian reason codes as CHECK constraints). |
| Eligibility: delivery = `delivered_at` or `shipped_at + fallback`, deadline = delivery + window, blocked when cancelled / not delivered / expired / no returnable lines; staff override with mandatory note | CC `_returns_eligibility` | CORE | Pure `returnEligibility()` in core with tests. |
| Returnable lines with pro-rata allocation of the order discount: `unit_net = unit_price × (1 − min(total_discounts / Σ line totals, 1))`; quantity returnable net of previous non-rejected returns | CC `_returns_order_lines` | CORE | Pure function. |
| Fault derived from reason (merchant / customer / to evaluate), approval refused while fault is undetermined | CC | CORE | Reason rows carry a default fault. |
| Workflow `requested → approved → received → inspected → closed (refunded / exchanged / voucher)`, `rejected`; bulk transitions returning `{done, skipped[{reason}]}`; idempotency key; advisory lock per order | CC `returns_transition` | CORE | Same state machine, states configurable per tenant within this set. |
| Per-line inspection (intact / damaged / missing, amount, note when amount differs) and recompute of proposed refund | CC | CORE | Same. |
| Restock flag only, no stock movement | CC `return_items.restocked` | CORE (fixed) | Restock creates an inventory movement at a chosen location, optional Shopify restock. |
| Public return form with rate limit, session tokens, signed uploads, intents | CC `public-return` | CORE (later) | Out of MVP scope; noted as a next step. |
| IBAN capture for COD refunds, `RIMBORSATO` tag, `#LM` number parser | CC | ADDON.COD (IBAN) / DISCARD | |
| Discount catalog sync via REST price rules + GraphQL `discountNodes` (code and automatic discounts, `AUTO:<title>`), upsert on code, scope error detection with remediation text | CC `shopify-discounts-sync` | CORE | Same in the Shopify adapter; scope errors surface on the integration health page. |
| Single code creation payload shape | CC `shopify-discount-create` | CORE | GraphQL `discountCodeBasicCreate` in Keel (REST price rules are legacy). |
| Bulk unique-code pool: crypto-random `PREFIX + 8` chars, collision handling only via unique constraint, one discount + `discountRedeemCodeBulkAdd` in blocks of 250, poll bulk creation, classify imported / failed, refill, purge redeemed by exact ids, deactivate | CC `shopify-discount-pool`, `discountPool.ts` | CORE | Same algorithm; prefix per tenant. `LM-WA`, Spoki coupling, Italian month names → DISCARD. |
| Order discount normalisation (`current_total_discounts` preferred, applications enriched) | CC `extractOrderDiscounts` | CORE | Re-implemented as a mapper with tests. |
| Client discount maths (`calcDiscountAmount`, applicability validation) | CC `discounts.ts` | CORE | Pure functions in core. |

## 5. Intelligence: ads, margins, P/L, campaigns ↔ stock (CC)

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| Order economics computed once per order and reused by every report: net revenue, COGS from last purchase cost, `cogs_complete` flag propagated with `bool_and`, shipping cost, margin | CC `v_order_economics` | CORE | `orderEconomics()` pure function in `packages/core/finance` + tenant-scoped view. VAT 22% and `Europe/Rome` → tenant settings (tax rate per country, timezone). Payment fees per method added (CLAUDE.md). |
| Campaign × day ledger: full outer join of daily spend and attributed orders, `has_ads` / `has_orders` flags, ratios never stored, "data missing" badges | CC `v_campaign_day_perf`, Controllo Ads | CORE | `campaign_daily_perf` view + ads daily register page with reason badges and CSV export. |
| Which orders count: all non-cancelled, non-refunded (code) vs "confirmed only" (docs) | CC `campaign_stock_report` | CORE (corrected) | Keel rule from CLAUDE.md: profit counts only orders with canonical status not in `cancelled`, `returned`, `refunded` (and `returned_partial` counted net). One `ordersInScope()` query builder used by dashboard, P/L and drill-downs so numbers agree by construction. |
| P/L cascade: gross → net of tax → COGS → gross margin → marketing → logistics → fixed costs → EBITDA; derived rates | CC `pl_summary` | CORE (structure) | Per-order and per-period P/L in core; fixed costs deferred (post-MVP). "Pending" bucket is COD-shaped → ADDON.COD. |
| Product sales with estimated cancel/return rates and shipping allocation per product | CC `intelligence_product_sales_v2` | CORE (formulas) | Product performance page; default rates become tenant settings with neutral defaults. |
| Campaign → product link with suggestion by name match (exact → prefix → contains → first token), auto-link only exact matches, manual approval for the rest; product id in ad `url_tags` | CC `campaign_product_suggestions` | CORE | `suggestProductsForCampaign(name, products)` pure + suggestion from ad landing URLs (`/products/<handle>` regex). Several products per campaign (CC: one primary). |
| Traffic light by ROI thresholds and recommended action by state × performance × repurchasable; restock advice when stock below threshold | CC `campaign_stock_report` | CORE | `recommendCampaignAction()` in core, extended with the stock dimension required by CLAUDE.md: active + stock below threshold + no incoming PO → pause (stock); incoming PO → consider. Enum codes, not Italian labels. |
| Pause / resume on Meta with user confirmation; local status realigned at next sync | CC `facebook-marketing` | CORE | `AdsPlatform.pauseCampaign()` with confirmation dialog; audit log. |
| Meta insights sync: 30-day live window, resumable month-window backfill queue claimed with `SKIP LOCKED`, stop on first error to not burn retries on rate limit, placeholder campaigns for unknown ids | CC `meta_backfill_windows` | CORE | `ads_backfill_windows` table + pg-boss job; same claim and stop-on-error semantics. |
| Meta error handling: retryable codes, capped exponential backoff, halve page size on "reduce the amount of data", token errors mapped to readable states | CC `metaInsights.ts` | CORE | Adapter error taxonomy: `rate_limited`, `token_expired`, `permission`, `invalid_request`; mock adapter simulates them. |
| Google Ads daily sync with `gclid` and API version monitoring | CC `google-ads-sync` | CORE | Read-only Google adapter; API version shown on health page. |
| Marketing overview across channels, channel derivation cascade (utm aliases → click id → referrer → direct) | CC `compute_order_channel` | CORE | `deriveChannel()` table-driven with default seed. |
| Conversion adjustments (retractions to ad platforms) | CC | CORE (post-MVP) | Noted in EVALUATION as a next step. |
| Defaults 28% cancel, 6% return, €8.90 shipping, €19 margin, 13% payback | CC | DISCARD | Tenant settings. |
| Mega-RPCs with 30+ columns patched by string replacement in migrations | CC | DISCARD | Calculations in `packages/core`, SQL only for set retrieval. |

## 6. CRM: segments, RFM, campaigns with control group (CC)

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| Segment rules JSON: `{match: all|any, conditions: [leaf | group]}`, depth ≤ 3, ≤ 30 leaves, typed operators per field, field catalog served by the server | CC `segmentRules.ts`, `marketing_segment_field_catalog` | CORE | Same schema, zod-validated; field catalog in core with an extension hook so `addon.cod` can register fields (e.g. risk tier) without touching core. |
| Compilation JSON → SQL with whitelisted expressions and quoted literals only | CC `marketing_segment_group_sql` | CORE | Compiled to Drizzle SQL fragments over a `customer_profiles` materialised table; tested against expected customer sets. |
| Exclusion flags (suppressions, consent, recent order, open order, marketing frequency, invalid phone, in measurement) | CC | CORE (subset) | Consent, recent order, open order, frequency kept in the model; channel-specific ones deferred with `MessagingChannel`. |
| Stable random sample `hash(key, seed) % 100` | CC `random_pct` | CORE | Same for segment sampling. |
| RFM: recency bands (0–90, 91–180, 181–365, ≤ 2y, > 2y), frequency bands (1, 2, 3–4, 5+), tier rules top-down (lost, dormant, champions, loyal, at risk, promising, new, one-time), matrix with contactable / revenue / AOV, spontaneous 90-day rebuy baseline frozen at `now − 150d` | CC `marketing_rfm_tier`, `rfm.ts` | CORE | `rfmTier()` and `buildRfmMatrix()` pure with configurable thresholds; cell click → segment rules. Italian feminine tier names → enum codes + i18n. |
| Deterministic holdout: `md5(campaign:key:salt) → bucket 0–9999`, `holdout` if below `pct × 100`, variant with a different salt | CC `marketing_campaign_bucket` | CORE | `assignHoldout(segmentId, customerId, pct, salt)` in core with test vectors; `Segment.holdout_percentage` + `segment_memberships(group)` in the model as required by CLAUDE.md. |
| Uplift statistics: intention-to-treat, two-proportion z-test (pooled SE for z, unpooled for CI), p-value via normal CDF, incremental buyers / margin, per-person Welch CI, minimum control size, provisional until window complete; holdout size advice with power and minimum detectable effect | CC `marketing_two_prop`, `marketing_holdout_advice` | CORE (library) | `twoProportionTest()`, `normCdf()`, `holdoutAdvice()` in core with tests. Campaign sending itself is not in the MVP (only the interface and the mock). |
| Campaign engine: status machine, materialisation, lease-based batch claim with throttle, autopause circuit breaker, priority preemption, always-on enrolment | CC `spokiCampaignSend.ts` | PATTERN | Documented in ARCHITECTURE as the design for future `MessagingChannel` campaigns; not implemented in the MVP. |
| Customer marketing profile keyed by phone, WhatsApp receptivity, size preferences, personal pages by size, Spoki templates and credits, `LM-WA` pools | CC | DISCARD | Keel keys customers on `customer_id` with email/phone match tables; "prevalent attribute" generalises size. |
| Contacts page with profile, value, frequency, last order | CC | CORE | CRM customer list and detail. |

## 7. Platform: roles, impersonation, notifications, health, settings, MCP (CC)

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| Roles with page-level permissions seeded in a table; `admin` bypass; effective role resolved through impersonation; protected routes redirect to the first allowed page | CC `role_permissions`, `current_effective_role` | CORE | Matrix `role × page × action` in `packages/config`, enforced server-side (route handlers, server actions) and in RLS; roles `owner, admin, operations, customer_care, marketing, viewer` per tenant membership. |
| Role impersonation ("view as") with expiry and audit | CC `admin_impersonations` | CORE | Pattern reused for **tenant** impersonation by the super-admin: `(admin_user_id, tenant_id, role, expires_at)`, visible banner, every action audited. |
| Notifications table with type, severity, link, metadata; preferences by category; broadcast to a role with anti-spam window | CC `notifications`, `spoki_notify_admins` | CORE | Same shape per tenant; types: mention, stock low, integration health, return requested, order assigned. |
| Announcements / release notes | CC `release_items` | DISCARD (MVP) | Not needed for the evaluation. |
| Integration health: explicit ack per sync with `last_success_at`, `last_metric_date`, `rows_written`, consecutive failures; states ok / idle / stale / error / degraded by freshness threshold per source; checker cron auto-retries stale sources and escalates after 2 failures with 6-hour anti-spam | CC `integration_health`, `integration-health-check` | CORE | `integration_health(tenant_id, source, …)` + connection status `not_connected / connected / error / syncing`, "Test connection" and "Resync" buttons, readable last error. |
| Readable errors from backend calls: `[function] message` with standard texts per HTTP status | CC `invokeEdge` | CORE | Error envelope `{code, message, hint}` from server actions, mapped to i18n texts. |
| Settings page: users and roles, suppliers, product categories, app settings key/value | CC | CORE (subset) | Tenant settings typed (country, currency, timezone, language, tax rates, order prefix, thresholds, payment fees); users and roles; integrations. |
| MCP server: OAuth with user token, RLS enforced through the user's session, PII masking, input sanitising, read tools + draft-only write tools | CC `mcp-server`, `privacy.ts` | CORE (post-MVP) | Designed in ARCHITECTURE as a connector per tenant; the MVP ships the masking and sanitising helpers in core and a stub route. |
| AI assistant with read-only SQL sandbox over `v_ai_*` views, rate limited | CC `ai_assistant_run_sql` | DISCARD (MVP) | Out of scope for the MVP; the guard regex approach is noted. |
| Mobile: curated mobile view, bottom navigation | CC | CORE | Responsive layout with usable mobile list/detail. |
| Client-side audit inserts with `WITH CHECK (true)`, secrets in `app_settings`, Lovable AI gateway | CC | DISCARD | Audit written server-side only; credentials encrypted per tenant (AES-GCM). |
| Date range helper hardcoded to Rome | CC `dateRange.ts` | CORE (parametrised) | Period presets in the tenant timezone, "N full days ending yesterday" convention kept with tests. |

## 8. Rehaus Ops Studio (RH)

Rehaus is a consignment business (enquiries → contracts → collections → intake/QC → listings → Shopify → orders → settlements → payouts → Xero, plus seller, brand-partner and logistic-partner portals). The business flows are not reusable; the engineering underneath is, and in several places it is more mature than Control Room's.

| Feature | From | Class | What Keel reuses |
| --- | --- | --- | --- |
| One permission matrix, three consumers: `role → page → none/read/write` JSON read by the UI hook, by SQL `has_page_access()` in RLS/RPCs and by job gates; page groups drive the editor, route → page map drives the guard; fail closed when the matrix is missing | RH `usePermissions`, `has_page_access` | CORE | `packages/config/permissions.ts` matrix + `can(role, page, action)` used by middleware, server actions, RLS helper and sidebar. Feature flags for add-ons checked the same way. |
| Role registry with protected built-ins; text role + registry FK rather than growing a Postgres enum | RH `roles` | CORE | Roles stored as text with a CHECK against config; no `ALTER TYPE ADD VALUE`. |
| RLS policy templates: `has_role` as `SECURITY DEFINER` wrapped in `(select …)` so it is evaluated once per statement; restrictive policies for deletes; revoke execute from `public`/`anon` on every definer function (Rehaus had 256 of 303 definer functions callable anonymously by default privilege) | RH migrations, June RLS audit | CORE | Keel policies: `tenant_id = current_setting('app.tenant_id')::uuid` plus role helper; default privileges revoked in the first migration; isolation tests per table. |
| Multi-audience auth (staff + external portals) with portal lock in the guard and versioned HMAC tokens | RH | PATTERN | Mechanism for super-admin vs tenant users and for future partner access; not an MVP feature. |
| Client-side role switcher | RH `RoleSwitcher` | PATTERN | Insufficient for tenant impersonation; Keel's impersonation is server-side with audit (CLAUDE.md 8.2). |
| Diff-only audit trigger (`old/new` jsonb of changed keys only), bookkeeping columns excluded, status history table with "age in status", bulk audit with `batch_id` | RH `log_row_changes`, `listing_status_history` | CORE | `audit_logs(tenant_id, actor, action, table, record_id, diff)`; `OrderEvent` carries `batch_id` for bulk actions; sync bookkeeping columns never generate audit rows (Rehaus produced 17.6M rows / 9 GB). Pruning server-side by `ctid` batches with a run row. |
| Pull-only Shopify sync with explicit authority rules: platform wins by default, locally authored columns protected per row, pull writers skip `status` while a push is queued, service-role writers never enqueue (no echo loops) | RH products pull, `shopify_publish_jobs` | CORE | Authority rules documented in ARCHITECTURE; price/status write-back goes through an outbound job queue. |
| Outbound write job queue with supersede, status-only fast path, max 3 attempts, stuck-running reap at 20 minutes; idempotent external writes keyed `entityType:entityId:operation:hash` | RH `enqueue_shopify_status_push`, `shopify_write_idempotency` | CORE | `outbound_jobs` via pg-boss with a `write_idempotency` table; used for Shopify price/status/inventory writes and Meta pause. |
| Per-location inventory reconciliation: GraphQL in batches of 250, retry on throttle, null node ≠ deleted (never delete on partial responses), clamp negatives and log deduped conflicts, diff only changed columns, delete stale location pairs, write a run summary, dry run first | RH `reconcile-shopify-inventory`, `_deletion-decision.ts` | CORE | Nightly inventory reconciliation job per tenant with `reconcile_runs(dry_run, scanned, changed, conflicts)`. Deterministic primary-location tie-break (Rehaus bug flipped 407 listings every 15 minutes). |
| Atomic reservation RPCs (`UPDATE … WHERE available ≥ qty`, `insufficient_stock`), append-only state table, TTL sweep | RH `reserve_listing` | CORE (post-MVP) | Shape for backorder holds; MVP uses committed/backorder quantities only. |
| Line-level fulfilment tasks with SQL precedence rollup, write-after-remote-ack | RH `get_outbound_board`, `fulfill-shopify-order` | PATTERN | Keel reads fulfilments from Shopify in the MVP; the rollup precedence idea feeds `resolveShipmentStatus`. |
| Returns & refunds: `refunds/calculate` first, remaining refundable computation, audit row per refund, downstream money rows flipped by trigger on status | RH | CORE | Refund service in the Shopify adapter; mock calculates locally. |
| Outbox + `FOR UPDATE SKIP LOCKED` claim + advisory lock + HMAC-signed deliveries + backoff table + delivery log + dead letter | RH `webhook-drainer`, `xero_outbox` | CORE (design) | Design for the integration event layer and the add-on slots (3PL, WhatsApp); implemented in the MVP as pg-boss retry policy + `integration_events` log. |
| Partner REST API with hashed keys, scopes, safe column projection, `updated_since` cursor, per-request log; rate limiting helper (fails open in Rehaus → must fail closed) | RH `api-gateway` | CORE (post-MVP) | Basis for the MCP connector and public API; noted in ARCHITECTURE. |
| Error-log pipeline (global handlers, single logging toast facade, ignore list, ring buffer) + 5-minute alert dispatcher with signature dedupe + run tables as evidence trail | RH `error-logger.ts`, `dispatch-alerts` | CORE (subset) | `job_runs` table for every scheduled job; alert on absence of success per integration (Rehaus lacked it); windowed dedupe. Client error page deferred. |
| Nightly backup, one table per invocation, PK-aware paging, redacted secret columns, retention, dry-run restore | RH `backup-critical-tables` | PATTERN | Documented as the per-tenant data export design; not in the MVP. |
| Internal notes with `@[Name](uuid)` mentions, role channels via sentinel ids, server-side recipient validation, entity → link map, per-user notification preferences enforced by trigger, legacy-link normalisation | RH mentions, `notify_role` | CORE | Mention format and server-side validation adopted for order notes; preferences table. |
| Tasks with automation rules and templated titles | RH | DISCARD (MVP) | |
| Saved views + sticky filters per page key; prev/next across the filtered list from a session id list | RH `useStickyFilter`, `useAdjacentIds` | CORE | Filters live in URL search params (shareable) with a per-page remembered default; prev/next on order detail. |
| Dashboard widget catalogue gated by permission page, role-specific default layouts | RH | CORE (simplified) | Fixed KPI dashboard per role in the MVP; catalogue idea noted. |
| KPI maths as pure function per KPI with tests; anti-pattern: four revenue definitions across pages | RH `dashboard-kpis`, KNOWN-ISSUES D10 | CORE | One revenue definition in `packages/core/finance`, used everywhere. |
| Period filter with presets | RH `PeriodFilter` | CORE | Same with tenant timezone. |
| Settlements / payouts formula as data with TS mirror and parity test, integer minor units, rates snapshotted at creation | RH settlements | PATTERN | Keel P/L: money as integer minor units, `cost_settings` snapshotted on the order economics row, parity tests between SQL aggregates and core functions. |
| Global search tokeniser with per-token OR chaining | RH `search-tokens.ts` | CORE | Search helper for lists. |
| Shared mailbox with thread routing precedence | RH | DISCARD (MVP) | |
| CSV import with header aliases, classify-before-write, malformed-row report, import audit record | RH migration tooling | CORE (post-MVP) | Shape for future cost / supplier imports. |
| FX rates table with trigger-computed base currency column | RH `fx_rates` | CORE (post-MVP) | Multi-currency reporting is deferred; tenants have one currency in the MVP. |
| Terms acceptance with content hash | RH | CORE (post-MVP) | Useful for tenant ToS at signup. |
| Support tickets, onboarding checklist, keyboard shortcuts, HTML sanitisation, media handling | RH | CORE (later) / DISCARD (MVP) | Onboarding checklist pattern reused for the super-admin tenant setup checklist. |
| Design language: 8pt grid, max width 1440, serif headings and metrics, one muted accent, understated semantic colours, tabular right-aligned numbers, ≥44px hit areas, HSL tokens only, single toast facade | RH `design-guidelines.md` | CORE (system, not palette) | Keel design system follows these rules with its own neutral palette. |
| Record page template: back + prev/next, eyebrow + title, one primary CTA + actions menu, chip row, KPI strip, sticky tabs | RH `DetailPageShell` | CORE | `DetailShell` in `packages/ui` used by order, product, customer, campaign, supplier pages. |
| List page toolbar: search + multi-select filters + secondary filters popover + saved views + view toggle + period; mobile bottom sheet; server pagination with "from–to of total" and windowed pages; 3-state sortable headers | RH | CORE | `DataTable` toolbar conventions in `packages/ui`. |
| Kanban + list dual view with server-side column counts | RH | CORE (returns, purchase orders) | Status columns with counts from the same query. |
| Known mistakes to design around: webhook always 200 with no retry and poll cursor never persisted; pg_cron "succeeded" = queued only; alert dedupe "once ever"; raw Shopify `financial_status` used as order state; stage lists duplicated in three client files | RH KNOWN-ISSUES | — | Each has an explicit counter-decision in DECISIONS.md. |
| Consignment business: enquiries, valuations, contracts, collections, QC, settlements, store credit, Xero, auctions, brand/logistic partner portals, market scraping, AI valuation | RH | DISCARD | |

## 9. Summary: what goes where

| Keel module (CLAUDE.md §7) | Main sources | Reused logic |
| --- | --- | --- |
| 1 Inbound orders | CC orders, RH audit/notes | webhook ack+queue+idempotency, fingerprint skip, non-destructive items, timeline diff, mentions, customer history 3-hop, duplicates ±5d, lineage, cancellation guard, attribution |
| 2 Outbound / shipments | CC logistics | per-source states + resolver with freshness precedence, sticky exceptions, final-state guard, outcome fold, mapping table, stale filter |
| 3 CRM | CC segments/RFM/holdout, RH LTV | nested rules schema + compiler, RFM bands and tiers, deterministic holdout, uplift statistics library |
| 4 Analytics | CC economics/P/L, RH KPI discipline | one economics function, one `ordersInScope`, ledger views without ratios, running comparisons, drill-through |
| 5 Campaigns ↔ inventory | CC campaign-stock, Meta backfill | name/URL suggestions, traffic light + action with stock dimension, pause with confirmation, window-queue backfill, error taxonomy |
| 6 Products & inventory | CC inventory/reorders, RH reconciliation | per-location levels, four sync levels, velocity/coverage/risk formulas, pack rounding, reconciliation that never deletes on partial data |
| 7 Returns | CC returns | policy config, eligibility, pro-rata lines, fault from reason, state machine, inspection, restock as movement |
| 8 Discounts | CC discounts | dual-API sync, GraphQL creation, bulk unique pools in blocks of 250, attributed revenue/margin per code |
| 9 Purchasing | CC purchasing | PO states with timestamps, receipt → movements + cost + backorder release, supplier payments ledger |
| 10 Platform | CC health/notifications, RH permissions/audit/jobs | matrix with three consumers, diff-only audit, health acks with freshness, job run tables, outbound write queue |
| addon.cod | CC COD modules | see section 10 |

## 10. Cash-on-delivery modules → `addon.cod` (CC)

Everything in this section is implemented only in phase 11, behind the `addon.cod` feature flag, after the core is complete. Nothing here leaks into core tables, KPIs or screens.

| Feature | From | Class | What the add-on reuses |
| --- | --- | --- | --- |
| Queue predicate based on state, not tags: payment method COD, open, canonical status pending review, not shipped, not scheduled in the future; one predicate shared by page, metrics, assignment and sweep | CC `is_cod_queue_order` | ADDON.COD | `isCodQueueOrder(order)` pure in the add-on package; `2025-01-01` cutoff → add-on setting. |
| Queue ordering: documented 4-level priority (modification requests, overdue callbacks, failed attempts, age) but implemented as `created_at` only | CC `cod_queue_page` | ADDON.COD | Keel implements the documented priority. |
| Outcomes: confirmed, no answer, call back, cancelled, modification; "3 attempts → unreachable" documented but never implemented; outcomes stored as tag rewrites | CC `cod_contact_attempts` | ADDON.COD (fixed) | Explicit `cod_attempts(outcome, channel, attempt_number, next_call_at)` with a tenant setting for max attempts; outcome drives the canonical status through the state service, never tags. |
| Scheduled confirmation: date stored, daily job applies, failures retry by not clearing the field | CC `scheduled_confirm_at` | ADDON.COD | Same. |
| Weighted round-robin assignment: available operators from weekly hours and daily exceptions (off / extra), skill routing by allowed tags, `quota_share = hours/Σhours`, `debt = quota_share × (1 + assigned_today_total) − assigned_today`, pick max debt, tie → more hours → lower id; assignment log with source and reason; idempotent per order; sweep every 10 minutes for the backlog; reassignment when skills no longer match; release / transfer / escalate allowed to the operator only before the first attempt, always to admins | CC `assign_next_cod_operator`, `auto_assign_cod_order` | ADDON.COD | Same algorithm as pure `pickOperator(available, assignedToday)` with tests; calendars and absences tables; allowed tags → allowed queues. |
| Operator KPIs: handled, confirmed, cancelled, conversion, attempts per confirmation, average handling time capped at 4h, throughput per active hour; supervisor view with bottleneck threshold | CC `operator_efficiency_metrics` | ADDON.COD | Same definitions, computed from attempts and events. |
| Delivery score: weighted arithmetic mean over factors that fire, weights as relative sliders, clamp 0–100, breakdown stored with each factor's raw score, weight and severity; recomputed by triggers on relevant changes; admin editor with live preview on an order | CC `compute_order_delivery_score` | ADDON.COD | `computeDeliveryScore(inputs, weights)` pure with per-factor explanation; weights per tenant; preview endpoint. |
| Generic factors kept: customer history (exponential decay with configurable half-life, minimum 2 orders), draft origin, prepaid vs COD, attempts (`max(20, 80 − 20n)`), channel engagement, time elapsed (`max(20, 90 − 15·days)`), cart duplicates, address quality with per-country validators, address validation verdicts, postcode zone statistics (min sample), similar orders (same zip + payment, 180 days, min 10), anomalous value vs tenant AOV, night order, manual risk flag, recent cancellations (`max(5, 60 − 15n)`, −15 if same product), duplicate siblings (100 / 40 / 15) | CC | ADDON.COD | All ported with configurable weights; AOV computed per tenant; address rules by country code. |
| Shoe-specific factors: cart size mismatch, size vs dominant historical size | CC | DISCARD (generalised) | Optional "variant option differs from the customer's dominant value for a size-like option" behind a flag; not in the default weights. |
| Recipient risk: identity on E.164 phone (email fallback, never name), phones linked through shared emails (≤ 5 phones per email) by connected components; outcomes from carrier billing (priority) or events; `weighted_returns = floor(Σ 1.0 if ≤ 12 months else 0.5)`; tiers watch ≥ 1, high risk ≥ 2, blacklisted ≥ 3; one-step redemption after `max(3, weighted_returns)` consecutive deliveries; manual override group-wide; score penalty multiplier and cap per tier; expected value from return probability bands vs margin and failed-order cost; cancel suggestion as text only for blacklisted; tier changes audited | CC `risk_classify`, `risk_penalized_score`, `risk_estimate` | ADDON.COD | Pure functions ported with test vectors; constants (margin, failed cost, probabilities) per tenant; `+39` rule replaced by libphonenumber with the tenant's default country. Never any automatic action. |
| Outcome source from 3PL billing import (Elogy invoices) | CC `elogyBillingImport.ts` | DISCARD | Outcomes come from shipment events in Keel; a generic CSV import of carrier outcomes is a later add-on. |
| COD fee line auto-added by variant id, confirmation templates copied to clipboard, WhatsApp via Spoki | CC | DISCARD | Fee modelled as an order-level fee; messaging only through `MessagingChannel`. |

---

## 11. Decisions taken from this study

1. Keel's canonical order status is a stored column written by one pure function over tenant `state_rules`; no module ever derives state from tags at read time.
2. Every integration write path is log-first and idempotent; webhooks are acked before processing; sync and backfill jobs persist a cursor after each page and record a run row.
3. Shipments keep one row per source state and a resolver with a tenant precedence list; terminal states are never demoted.
4. Economics are computed once per order in `packages/core` and reused by dashboard, P/L, campaigns and discounts through a single `ordersInScope` perimeter.
5. Permissions are a single matrix consumed by UI, server actions and RLS; add-on flags are checked the same way.
6. Audit is diff-only, server-side, never triggered by sync bookkeeping columns.
7. All COD logic (queue, assignment, score, risk, scheduled confirmation, COD-specific KPIs) lives in `addon.cod`.
8. Nothing from either repository is copied as code; utilities listed as "reusable verbatim" are rewritten against Keel's model with their own tests.

The detailed study notes (per-area reports with pseudo-code and the reference file paths) are kept in `docs/reference/study/` for later phases.
