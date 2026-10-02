> Historical document: the product was formerly called Keel.

# Control Room (Lorena Milano) — Ops study: logistics, inventory, reorders, purchases, returns, discounts

Source: `/home/user/lorena-control-center` (read-only). React + Supabase (Postgres + Edge Functions in Deno). 582 SQL migrations under `supabase/migrations/`, edge functions under `supabase/functions/`, pure helpers in `supabase/functions/_shared/` and `src/lib/`. The `drizzle/` folder only holds video/AI/COD-queue migrations (`drizzle/migrations/0000..0026`) and is not the source of truth for the tables below; the Supabase migrations are.

Legend for classification: **GENERIC** = reusable for any e-commerce; **COD-ONLY** = only meaningful for cash-on-delivery; **CLIENT-SPECIFIC** = Lorena/Italy/shoes/Elogy/GLS/Qapla' only.

---

## A. Feature inventory

| Feature | Where | What it does | Class | Logic worth reusing |
|---|---|---|---|---|
| One shipment row per order, one column set per source | `logistics_shipments` (base: `migrations/20260326071538_*.sql`; Qapla' cols `20260504093047_*.sql`; GLS cols + `is_locked/exception_reason/exception_since` `20260820142619_*.sql`); UNIQUE on `order_id` since 15/05/2026 | Each source (3PL API/webhook, tracking aggregator, carrier) writes only its own `*_status`, `*_last_event_at`, `*_status_detail` columns. The visible `status` is never written by integrations. | GENERIC | "Each source owns its columns; a resolver computes the visible status." Also `source_of_truth` column to show which source won. |
| Multi-source status resolver (trigger) | `recompute_shipment_status()` — latest in `20260820142619_*.sql`; trigger `trg_recompute_shipment_status BEFORE INSERT OR UPDATE OF elogy_status, qapla_status, qapla_last_event_at` (`20260515094615_*.sql`) | Precedence: carrier (GLS) if fresh ≤24h and carrier matches → tracking aggregator (Qapla') if fresh ≤24h → 3PL (Elogy) → `pending`. Sticky exception with reason + 15-day auto-clear. Logs `source_conflict` events. | GENERIC pattern (values CLIENT-SPECIFIC) | Freshness-window precedence, sticky exceptions with a *reason* and an *age*, conflict audit. See C.1. |
| Carrier-status mapping table | `qapla_status_mapping` (`20260504093047_*.sql`), `map_qapla_status()` (`20260515094615_*.sql`) | Admin-editable table `(external_status → internal_status, label, is_exception, is_final)` seeded with defaults; SQL function with identical fallback mapping. | GENERIC | Per-tenant editable mapping from provider status to canonical status, with `is_final`/`is_exception` flags. |
| 3PL status normaliser (pure) | `supabase/functions/_shared/elogyStatus.ts` | `mapElogyLastStatus(last, prev)`, `mapElogyTrackingCode`, `mapElogyTrackingName`, `isReturnAfterDelivery`. "return after delivered stays delivered." | CLIENT-SPECIFIC values; GENERIC rule | Rule: a terminal `delivered` is never demoted; a `return` seen after `delivered` is a post-delivery customer return, not a carrier return. |
| Outcome fold table (order-arrival independent) | `elogy_shipment_outcomes` + `elogy_ingest_outcome_event()` (`20260915070001_risk_outcomes_v1.sql`), `elogy_ingest_api_orders()` (`20260915070003_*.sql`) | Keeps `first/last_delivered_at`, `first/last_return_at` with `least/greatest` on upsert; `outcome` and `outcome_at` are STORED generated columns (`refused` vs `returned_after_delivery` vs `delivered`). | GENERIC | Idempotent, commutative event folding; see C.3. |
| Effective shipment status read model (6-level precedence) | `logistics_effective_rows()`, `get_logistics_shipments()`, `get_logistics_overview()` (`20260915070006_logistics_effective_status.sql`) | Pure read-side resolver combining API final status, webhook final outcome, app final status, fresher non-final webhook code, non-final API status, app status. Buckets: pending, in_transit, out_for_delivery, stock, delivered, refused, returned_after_delivery, returned_unverified, exception, failed. Server-side pagination (50) + counts. | GENERIC pattern | "Final beats non-final; among non-final the fresher wins; app status is last resort." Stale = not concluded and created more than `logistics_stale_days` (default 14) ago. |
| Delivery propagation shipment ↔ order | `trg_propagate_delivery`, `trg_propagate_order_delivery_to_shipments` (described in `docs/team/08-logistica.md`) | Shipment status → `orders.delivery_status/delivery_source/delivery_updated_at`; reverse mapping for order-level updates; never demotes `delivered`/`returned`. | GENERIC | Two-way sync with "no demotion from terminal state" guard. |
| Webhook ack + background processing + log + replay | `supabase/functions/elogy-webhook/index.ts` (`elogy_webhook_logs`, `EdgeRuntime.waitUntil`), `qapla-webhook` (`X-Qapla-Signature`), `gls-webhook` (HMAC-SHA256 over raw body) | Multi-event single endpoint; store raw payload with `processed/error/retry_count`; ack 200 immediately; process async; replay authorized by secret. | GENERIC pattern | Log-first, ack, process later, replay from log. |
| Resumable reconciliation against 3PL list API | `elogy-sync?type=orders` + `_shared/elogyIngest.ts` + `sync_status(source, object_type, cursor_data)` | Pages of 100, ~110 s budget, cursor `{start,next_offset,total,pass_started_at,pass_completed_at}`, skip if a pass completed <20 h ago, `force=1`, `window=` (100..80 000), only non-PII fields sent to a service-role RPC (max 1000/call). | GENERIC | Budgeted, resumable, windowed backfill with "recent pass" skip. |
| Qapla' reconcile | `supabase/functions/qapla-reconcile` (cron 06:00) | Marks shipments never seen by the aggregator for >24 h as `missing_on_qapla` + notification. | GENERIC-ish | "Source coverage gap" alert. |
| Exception work queue (GLS holds) | `gls_giacenze_queue` (`20260515100436_*.sql`), `gls_giacenze_sync()` + `get_gls_giacenze()` (`20260915070007_gls_giacenze_align.sql`), cron every 15 min | Auto-enqueue shipments in hold/failed-attempt; soft claim (`claimed_by/claimed_at`); auto-close with `auto_*` resolution; re-open only auto-closed rows; manual closures never overwritten; `confirmed` flag for rows not confirmed by a source. | GENERIC pattern; CLIENT-SPECIFIC implementation (GLS, Italian hold flow) | Shared claim queue semantics, idempotent sync with dry-run. See C.4. |
| GLS write actions / instruction emails / hold rules engine | `gls-action`, `gls-instruction-email`, `_shared/holdInstructionEmail*.ts`, tables `shipment_holds, hold_rules, hold_settings, hold_events, hold_economics` | Change address / reschedule / hold at depot via email (Resend) or mock SOAP adapter; feature-flag gated. | CLIENT-SPECIFIC | Only the "anti double-send lock row with 5-minute expiry" idea. |
| Carrier returns automation ("Rientri al mittente") | `carrier_return_settings`, `carrier_return_actions`, `carrier_returns_detect/claim/tick/retry` (`20260925120001_carrier_returns.sql`, `20260928090001_*.sql`), edge `carrier-returns-process`, pure `_shared/carrierReturns.ts` | From outcomes: code 19.1 → cancel on Shopify `restock:false, email:false` + void 0.00 if still pending; code 21 → tag only; doubts → review. Cron 5 min, max 20/run, `FOR UPDATE SKIP LOCKED`, 429 requeue up to 6 attempts, 3 interrupted runs → error. | COD-ONLY / CLIENT-SPECIFIC business rule; GENERIC job pattern | Claim-queue + budgeted worker + pure decision function. |
| 3PL order push | `supabase/functions/elogy-push-order` | Pushes confirmed orders to the 3PL with flat address, prices, `gateway=cashondelivery`. | CLIENT-SPECIFIC | Only: "HTTP 200 with error body is an error"; keep external id on the shipment record. |
| Inventory snapshots (one row per variant) | `inventory_snapshots` (`20260325075935_*.sql`), unique index on `variant_id` (`20260326073611_*.sql`), `elogy_net_stock` col (`20260331143803_*.sql`) | `available_quantity, reserved_quantity, shopify_synced_at`; upsert on `variant_id`. No location dimension. | GENERIC (minus missing location) | Single current-state row per variant + `synced_at`; UI treats missing row as "not synced" not "out of stock". |
| Four inventory sync levels | `shopify-sync/index.ts` (`syncInventoryFromProducts`, `zeroInventorySnapshotsNotTouchedSince`, cursor in `sync_status.cursor_data`), `shopify-webhook` (order/fulfillment webhooks trigger targeted `inventory_levels.json` reads), `shopify-refresh-variant-stock/index.ts`, nightly pg_cron `shopify-inventory-nightly-full-sync` | Realtime targeted refresh on order/fulfillment/inventory webhooks; nightly full sync; manual "Force sync"; on-demand per-variant refresh resolving `inventory_item_id` lazily. | GENERIC | See C.5: chunked full sync with high-water mark, resume cursor, zeroing of untouched rows, 429 Retry-After, >100-variant products expansion. |
| Inventory matrix + incoming + committed | `src/lib/productInventory.ts` (`buildInventoryMatrix`, `incomingByVariant`, `PO_INCOMING_STATUSES`), RPC `compute_variant_capacity` (`20260907110039_*.sql`) | Product tab: available, committed in open orders, incoming from POs, per-cell matrix. Capacity = stock + incoming + original_in_order. | GENERIC (but matrix hardcodes color×size) | `compute_variant_capacity` decomposition: stock_now, incoming, committed_open, backorder_open, next_arrival_date/next_po_id, snapshot_missing. |
| Catalog / PIM | `products`, `product_variants` (`20260325075935_*.sql` + ADD COLUMNs: `product_code`, `last_purchase_cost`, `is_purchasable`, `is_ancillary`, `inventory_item_id`), `shopify-publish-product`, `shopify-publish-bulk`, `shopify-update-variant-sku`, `shopify-delete-product-variant`, `translate-color`, `src/lib/products/categories.ts` | Product statuses (Italian enum), fixed `color`/`size` columns, SKU pattern `Name-CODE-SizeColorEN`, category list with regex suggestion, publish/update to Shopify with variant match priority SKU → shopify_variant_id → option pair, bulk publish job table with realtime progress. | CLIENT-SPECIFIC schema; GENERIC publish/match pattern | Variant matching priority; "delete single variant on Shopify before local delete; soft dependencies cleanup; refuse if referenced by orders"; bulk job table + end-of-job notification. |
| Reorder dashboard (velocity / coverage / risk) | `reorder_dashboard_grouped()`, `reorder_variants_for_product()` — latest in `20260508195702_*.sql`; team doc `docs/team/07-riordini.md` | Per variant: units sold in lookback (non-cancelled orders), velocity/day, days remaining using stock+incoming, risk critical/warning/ok; product aggregates = sums, MIN days, worst risk. Lookback selector 7/14/30/60/90. | GENERIC | See C.6 for exact formulas. |
| Carton / size-curve block suggestion | `product_reorder_blocks`, `carton_presets` (`20260508130101_*.sql`, `20260521080305_*.sql`), `suggested_blocks_by_color` | Suggest N cartons per colour: `ceil(max(velocity*target − effective_stock, 0)/qty_per_size)` per variant, MAX per colour, SUM per product. | CLIENT-SPECIFIC (shoes) — generalises to "pack size / case pack" | Pack-based rounding: suggestion expressed in supplier pack units, computed as MAX over the variants a pack covers. |
| Uncovered-critical alerts | `refresh_uncovered_critical_alerts()` (`20260508195702_*.sql`), `reorder_alerts` | Idempotent: resolves alerts for variants now covered (PO in confermato/pagato/ritirato) or no longer critical; inserts new with `priority_score = 100 if stock=0 else max(0, 50 − days_left*5)`. | GENERIC | Idempotent alert refresh with priority score. |
| Suppliers | `suppliers` (`20260508140507_*.sql` + `code, payee_name, default_pieces_per_carton, default_carton_code` in `20260703142350_*.sql`) | Master data with billing entity (`payee_name`) and packing defaults. | GENERIC (payee_name useful) | Separate "supplier" from "billing entity". |
| Purchase orders & lines | `purchase_orders`, `purchase_order_items`, enum `purchase_order_status`, `gen_po_number()`, `handle_po_status_change()`, `recalc_po_total()`/`tg_purchase_order_items_recalc()`, `purchase_orders_list()`, `purchase_order_lines()` (`20260508140507_*.sql`, `20260703142350_*.sql`), `purchase_order_history` (`20260508194848_*.sql`) | States `bozza → da_confermare → confermato → pagato → ritirato → ricevuto → a_stock`, `annullato`; per-state timestamps set by trigger; `line_total` GENERATED; order total maintained by trigger; non-catalog lines (`description`, `supplier_sku`); cartons × pieces_per_carton → quantity; history snapshots; duplicate; delete only early states. | GENERIC (state names Italian; warehouses enumerated are CLIENT-SPECIFIC) | Timestamps-by-trigger, totals-by-trigger, generated line totals, non-catalog lines, history. |
| Receiving → stock | `po_stock_snapshot()` latest in `20260615105535_*.sql` (trigger `trg_po_stock_snapshot AFTER UPDATE`) | On transition to `a_stock`: for each line `INSERT … ON CONFLICT (variant_id) DO UPDATE SET available = available + qty`. | GENERIC | Upsert-increment on receipt. Note: no Shopify write-back here (stock on Shopify is owned by the 3PL in this client). |
| Receiving → product cost | Frontend `src/pages/Acquisti.tsx` ~L960-970 (`supabase.from("products").update({ last_purchase_cost })`) | On PO save (not on receipt) the last unit price per product overwrites `products.last_purchase_cost` (VAT-excluded), which feeds P/L COGS. | GENERIC concept, weak implementation | Keep the concept; move it server-side and on receipt. |
| Backorders / "waiting stock" release | `order_item_backorders` (`20260512112723_*.sql`), `purchase_orders_backorder_coverage()`, `po_received_trigger_backorder_check()` (`20260512114745_*.sql`), edge `orders-check-backorder-stock`, `compute_variant_capacity` | PO rows show "covers N customer orders". On PO → `ricevuto` a trigger calls the edge function with the PO's variant ids; it recomputes each backorder: `fulfilled` if stock ≥ qty, `covered` if incoming > 0, else `pending`; when all fulfilled → clear `awaiting_stock_since`, order event, notification. (Docs say the trigger fires on `a_stock`; code fires on `ricevuto`.) | GENERIC | See C.8. |
| Supplier balances | `supplier_outstanding_balances()`, `supplier_outstanding_orders()` (`20260703142350_*.sql`) | Open amount per supplier = SUM(total_amount) of POs not in (`bozza`,`annullato`) with `paid_at IS NULL`; oldest unpaid date; "mark paid" = set status `pagato` (trigger writes `paid_at`). | GENERIC | Derived ledger; no separate ledger table (see C.9). |
| Customer returns process | `returns` (ext.), `return_items`, `return_lookup_attempts`, `return_lookup_sessions`, `return_intents`; RPCs `_returns_*`, `returns_public_*`, `returns_transition`, `returns_list`, `returns_get` (`20260915062000_returns_process.sql`, `20260915091000_*.sql`, `20260928080000_returns_tracking_intents.sql`); edge `public-return`; UI libs `src/lib/returns/*` | Config in `app_settings.returns_config` (window days, shipping fallback days, customer-fault return cost, excluded SKUs/prefixes/title patterns, warehouse address, support email). Public form (order number + email/phone, rate-limited, 60-min session token, signed upload URLs). States richiesto → approvato → ricevuto → chiuso / rifiutato; resolutions rimborso/cambio/buono; fault derived from reason; pro-rata order discount per line; inspection outcomes per line with `restocked` flag; bulk transitions returning done/skipped; events in `order_events`; idempotency key; advisory lock per order. | GENERIC (IBAN/COD refund = COD-ONLY; `#LM` parsing and Italian labels CLIENT-SPECIFIC) | See C.10. |
| Returns → Shopify tag | edge `returns-tag-order`, `src/lib/returns/tag-order.ts`, `returns_record_tag_result()` | Adds `RIMBORSATO` tag on close_paid; failures stored in `shopify_tag_error` with retry. | CLIENT-SPECIFIC (tag-driven) | Only the "record external side-effect error on the row + retry" idea. |
| Discounts catalog sync | edge `shopify-discounts-sync/index.ts` | REST `price_rules` + `discount_codes` (paginated via Link header) AND GraphQL `discountNodes` (code + automatic discounts) → upsert `discounts` on `code`; skips pool discounts; scope error detection. | GENERIC | Dual-API sync; automatic discounts stored as `AUTO:<title>`. |
| Discount create / toggle / delete | edge `shopify-discount-create/index.ts` | Creates a Price Rule + one Discount Code (REST 2024-01), stores ids; toggle is local only; delete removes price rule. | GENERIC (legacy API) | Payload shape in C.11. |
| Apply discount to order | `shopify-order-actions` action `apply_discount` + `order_discounts` | Preset or custom percentage/fixed, Shopify Order Editing, fallback cancel+recreate for non-editable orders. | GENERIC idea / CLIENT-SPECIFIC fallback | Keep `order_discounts` application log. |
| Order discount normalisation | `_shared/orderDiscounts.ts` (`extractOrderDiscounts`) | Normalises `total_discounts` (prefers `current_total_discounts`), `discount_codes[]` enriched with `discount_applications` (percentage, title), automatic discounts without code. | GENERIC | Verbatim reusable. |
| Bulk unique-code pools | `marketing_discount_pools`, `marketing_discount_codes` (`20260927190001_f3_discount_pools.sql`), edge `shopify-discount-pool/index.ts`, pure `_shared/discountPool.ts`, `makeDiscountCode`/`chunk` in `_shared/shopifyAdmin.ts` | Generate N unique codes locally, create one `discountCodeBasicCreate`, add the rest via `discountRedeemCodeBulkAdd` in blocks of 250, poll `discountRedeemCodeBulkCreation`, classify imported/failed, refill, purge redeemed (exact ids only), deactivate, auto-maintain (refill/rollover). | GENERIC (pool purpose is WhatsApp campaigns, but mechanism is generic) | See C.11. |
| Discount client helpers | `src/lib/discounts.ts` | `calcDiscountAmount`, `validateDiscountApplicability`, `formatDiscountLabel`. | GENERIC | Verbatim (strings need i18n). |

---

## B. Data model (tables and key columns)

### Shipments
`logistics_shipments`
- `id`, `order_id` (UNIQUE, FK orders), `tracking_number`, `carrier`, `status` (visible, computed), `source_of_truth` (`gls|qapla|elogy|none`), `estimated_delivery`, `delivered_at`, `external_id`, `elogy_order_id`, `created_at`, `updated_at`.
- Source columns: `elogy_status`, `elogy_tracking_status`; `qapla_status`, `qapla_status_detail`, `qapla_last_event_at`, `qapla_tracking_url`, `qapla_first_seen_at`, `missing_on_qapla`, `missing_on_qapla_alerted_at`; `gls_status_code`, `gls_status_detail`, `gls_last_event_at`, `gls_pod_url`, `gls_giacenza_motivo`, `gls_giacenza_scadenza`, `gls_filiale_codice`, `gls_filiale_telefono`.
- Exception bookkeeping: `is_locked` (administrative lock, does not affect status), `exception_reason` (`delivery_error|invalid_order|source_exception`), `exception_since`.
- Client-specific assumptions: three hardcoded sources as columns (no `shipment_sources` child table); `carrier ILIKE 'gls%'` check inside the trigger; one shipment per order (no split shipments).

`logistics_events`: `id`, `shipment_id`, `event_type` (`source_conflict`, `return_after_delivery`, status changes…), `description` (jsonb-as-text for conflicts), `location`, `occurred_at`, `created_at`.

`elogy_shipment_outcomes` (per 3PL order ref): `order_ref` PK, `shopify_order_number`, `elogy_order_id`, `shopify_order_id`, `last_status`, `last_tracking_code`, `last_status_at`, `first_delivered_at`, `last_delivered_at`, `first_return_at`, `last_return_at`, `outcome` GENERATED (`refused|returned_after_delivery|delivered`), `outcome_at` GENERATED, `events_count`, `source` (`webhook|api`), plus API fields `api_status`, `final_tracking_code`, `final_tracking_name`, `final_tracking_at`, `api_seen_at`, `webhook_tracking_code`, `webhook_tracking_at`, `delivery_error_count`.

`qapla_status_mapping`: `qapla_status` UNIQUE, `internal_status`, `label_it`, `is_exception`, `is_final`.

`gls_giacenze_queue`: `shipment_id` UNIQUE, `order_id`, `motivo` (`GIACENZA_APERTA|TENTATIVO_FALLITO|EXCEPTION|FAILED|…`), `scadenza_ritiro`, `filiale_codice`, `filiale_telefono`, `claimed_by`, `claimed_at`, `resolved_at`, `resolution_action` (manual: `new_address|reschedule|pickup_point|customer_unreachable|returned|manual_resolved`; auto: `auto_delivered|auto_returned|auto_failed|auto_released|auto_cancelled`), `resolution_notes`, `email_sent_at`, `email_action`.

`carrier_return_settings` (singleton: `enabled`, `detect_since`, `max_per_run`), `carrier_return_actions` (`order_id`, `tracking_code` ∈ {19.1, 21}, `tracking_at`, `carrier`, `planned_action` ∈ {cancel, tag_only, cancel_refunded, review}, `tags_to_add[]`, `review_reason`, `status` ∈ {pending, in_progress, done, error, review, dismissed}, `attempts`, `last_error`, `result`, `claimed_at`, `processed_at`; UNIQUE `(order_id, tracking_code)`; CHECK `(planned_action='review') = (review_reason IS NOT NULL)`).

`sync_status`: `source`, `object_type` (UNIQUE pair), `last_synced_at`, `last_error`, `status`, `cursor_data` jsonb, `updated_at`. Used by every resumable job.

`elogy_webhook_logs`: `event`, `payload`, `processed`, `error`, `retry_count`, `created_at`, `processed_at` (2-day retention cron).

Orders carry `delivery_status` (Italian values: `consegnato|rientrato|in_consegna|in_transito|eccezione|non_disponibile`), `delivery_source`, `delivery_updated_at`, `shipped_at`, `delivered_at`, `elogy_id`, `awaiting_stock_since`.

### Catalog & inventory
`products`: `id`, `shopify_id` UNIQUE, `title`, `description`, `category` (free text, Italian list), `collection`, `status` enum `product_status` (`bozza|in_preparazione|pronto_pubblicazione|pubblicato|archiviato`), `tags[]`, `media_urls[]`, `notes`, `product_specs`, `slug`, `product_code`, `last_purchase_cost` (VAT-excl.), `is_purchasable`, `is_ancillary`, `supplier_id`, `warehouse_location`, `shopify_synced_at`.
`product_variants`: `id`, `product_id`, `shopify_variant_id` UNIQUE, `inventory_item_id`, `sku`, `color`, `size`, `price`, `compare_at_price`.
`inventory_snapshots`: `variant_id` (unique index), `available_quantity`, `reserved_quantity`, `elogy_net_stock`, `shopify_synced_at`, `created_at`.
`product_color_images`: `(product_id, color, media_url, position)`.
`shopify_publish_jobs`: bulk publish progress.
Client-specific assumptions: variants are exactly colour × size; `sku NOT IN ('contrassegno','assicurazione-pacco')` filters sprinkled across RPCs (COD fee and insurance sold as products); single location; stock also mirrored from the 3PL (`elogy_net_stock`).

### Reorders
`reorder_rules` (unused in practice: `min_stock_threshold`, `days_of_coverage`), `reorder_alerts` (`alert_type` e.g. `uncovered_critical`, `current_stock`, `estimated_days_remaining`, `priority_score`, `is_resolved`, `resolved_at`).
`product_reorder_blocks`: `product_id` PK, `sizes_qty` jsonb `{size: qty}` (legacy/default curve), `default_carton_code`, `overrides` `{carton_code: sizes_qty}`, `custom_cartons` `[{code,label,sizes_qty}]`, `notes`.
`carton_presets`: `code` UNIQUE, `label`, `sizes_qty`, `total_units` (trigger-computed), `sort_order`, `is_active`.

### Purchasing
`suppliers`: `name`, `company`, `email`, `phone`, `notes`, `is_active`, `code`, `payee_name`, `default_pieces_per_carton`, `default_carton_code`.
`purchase_orders`: `po_number` (`PO-YYYYMM-0001` from sequence), `supplier_id`, `purchase_date`, `expected_arrival_date`, `status` enum (`bozza, da_confermare, confermato, pagato, ritirato, ricevuto, a_stock, annullato`), `total_amount` (trigger-maintained), `notes`, `created_by`, `confirmed_at`, `paid_at`, `picked_up_at`, `received_at`, `stocked_at`, `cancelled_at`, `destination_warehouse` (CHECK in client list), `inbound_system`, `inbound_ref`, `pickup_requested_at`, `shipping_mode` (`pickup|supplier_ships`), `received_issue`.
`purchase_order_items`: `purchase_order_id`, `product_id` (nullable), `variant_id` (nullable), `quantity` (>0), `unit_price`, `line_total` GENERATED, `cartons` numeric, `pieces_per_carton`, `supplier_sku`, `description`, `colors_note`, `carton_code`.
`purchase_order_history`: action snapshots with actor.
`order_item_backorders`: `order_id`, `order_item_id`, `variant_id`, `qty`, `purchase_order_item_id`, `status` (`pending|covered|fulfilled|cancelled`), `resolved_at`.
No `supplier_ledger` / payments table exists: balances are derived from PO status and `paid_at`.

### Returns
`returns`: `return_number` (`R-00001`), `order_id`, `status` (`richiesto|approvato|rifiutato|ricevuto|chiuso`), `reason` (7 Italian codes), `fault` (`nostro|cliente|da_valutare`), `resolution_type` (`rimborso|cambio|buono`), `resolution_status` (`pagato|buono_emesso|cambio_spedito`), `exchange_request`, `customer_notes`, `evidence_paths[]` (≤5 product + ≤2 label), `iban`, `iban_holder`, `payment_method_original`, `proposed_items_amount`, `proposed_return_cost`, `proposed_total`, `rejection_reason`, `paid_amount/paid_at/paid_method/paid_note`, `voucher_code/voucher_value`, `replacement_order_id`, `source` (`cliente|staff`), `out_of_window`, `staff_note`, `idempotency_key` (unique partial), `shopify_tag_error`, `tracking_number`, `tracking_carrier`, per-transition `*_at/*_by`. CHECKs enforce closed ⇒ resolution_status, rejected ⇒ reason, out_of_window ⇒ staff_note.
`return_items`: `return_id`, `order_item_id` (UNIQUE pair), `quantity`, `unit_net_price`, `line_amount`, `inspection_outcome` (`integro|danneggiato|mancante`), `inspection_amount`, `inspection_note`, `restocked` bool.
`return_lookup_attempts` (ip, order_number, success), `return_lookup_sessions` (token, order_id, expires_at 60 min), `return_intents` (order_id UNIQUE, views, last_seen_at, converted_return_id).
Config: `app_settings.returns_config` jsonb.
Client-specific assumptions: order number parser `#LM-…`; COD refund requires IBAN; `restocked` is a flag only (no stock movement, no Shopify restock, no location).

### Discounts
`discounts`: `code` UNIQUE, `title`, `description`, `discount_type` (`percentage|fixed_amount|free_shipping`), `value`, `applies_to` (`order`), `minimum_amount`, `usage_limit`, `used_count`, `starts_at`, `ends_at`, `is_active`, `shopify_price_rule_id`, `shopify_discount_code_id`, `source` (`shopify|platform`), `synced_at`, `created_by`.
`order_discounts`: `order_id`, `discount_id` (nullable for custom), `code`, `discount_type`, `value`, `amount_applied`, `applied_at`, `applied_by`.
`marketing_discount_pools`: `campaign_id`, `title`, `discount_type`, `value`, `minimum_amount`, `starts_at`, `ends_at`, `applies_once_per_customer`, `usage_limit_per_code`, `shopify_discount_gid` UNIQUE, `status` (`draft|creating|ready|exhausted|disabled|error`), `target_size`, `error`.
`marketing_discount_codes`: `code` PK (CHECK upper), `pool_id`, `status` (`pending|available|assigned|redeemed|failed|void`), `bulk_creation_gid`, `recipient_id`, `phone_key`, `assigned_at`, `redeemed_order_id`, `redeemed_at`, `redeemed_by_other`.
Orders carry `total_discounts`, `discount_codes` jsonb `[{code, amount, type, percentage?, title?}]`.

---

## C. Patterns in detail

### C.1 Multi-source shipment status resolution (write-side trigger)
Source: `recompute_shipment_status()` in `20260820142619_*.sql`.

```
INPUT  row NEW (all source columns), OLD.status
CONST  FRESH = 24h, STICKY_MAX_AGE = 15 days
       REAL_EXCEPTION_REASONS = {delivery_error, invalid_order, source_exception}

old := coalesce(OLD.status, 'pending')
carrier_fresh := NEW.carrier_last_event_at > now() - FRESH
aggr_fresh    := NEW.aggregator_last_event_at > now() - FRESH

if carrier_fresh and carrier_matches(NEW.carrier) and NEW.carrier_code is not null:
    winner := 'carrier';  new := map_carrier(NEW.carrier_code)   -- unknown code → keep NEW.status or in_transit
elif aggr_fresh and NEW.aggregator_status is not null:
    winner := 'aggregator'; new := map_aggregator(NEW.aggregator_status)
elif NEW.threepl_status is not null:
    winner := 'threepl'; new := NEW.threepl_status
else:
    winner := 'none'; new := 'pending'

-- conditional sticky exception
real  := NEW.exception_reason in REAL_EXCEPTION_REASONS
stale := NEW.exception_since < now() - STICKY_MAX_AGE
if old = 'exception' and new = 'in_transit' and real and not stale:
    new := 'exception'

-- exception bookkeeping
if new = 'exception':
    if old <> 'exception' or NEW.exception_since is null: NEW.exception_since := now()
    if NEW.exception_reason is null: NEW.exception_reason := 'source_exception'
else:
    NEW.exception_since := null; NEW.exception_reason := null

NEW.status := new; NEW.source_of_truth := winner

-- conflict audit
if winner = 'carrier' and NEW.aggregator_status not null and NEW.aggregator_status <> new:
    insert logistics_events(shipment_id, 'source_conflict', json{winner, carrier, aggregator, threepl})
```
Earlier version (`20260515094615_*.sql`) also logged conflicts between aggregator and 3PL with `metadata={elogy, qapla, qapla_fresh, winner, final_status}`. Trigger is `BEFORE INSERT OR UPDATE OF <source columns>`; integrations never write `status`.

Design notes for Keel: replace hardcoded columns with a generic precedence list per tenant (`[{source, freshness_hours, priority}]`), keep `source_of_truth`, `exception_reason`, `exception_since`, and the conflict event. Delivered/returned are terminal and are never demoted by any later rule (docs + `trg_propagate_order_delivery_to_shipments`).

### C.2 Sticky exceptions — exact rules
1. Exception is sticky only against a transition to `in_transit`, only if `exception_reason` is "real" (`delivery_error`, `invalid_order`, `source_exception`), and only while younger than 15 days (`exception_since`).
2. Administrative locks (`order_locked`/`order_unlocked`) set `is_locked` and never touch `status` (fix of 20/08/2026 after 3 834 shipments were wrongly stuck).
3. `delivered`/`returned` always override an exception; a delivered shipment never returns to exception.
4. In the read model, a non-final webhook code fresher than the API snapshot (30 = hold, 18 = out for delivery, 17.x = transit) overrides the API's non-final state; any *final* state from any source overrides everything.

### C.3 Order-arrival-independent outcome fold
Source: `elogy_ingest_outcome_event()`.
```
on event(order_ref, status in {delivered, return, ...}, at):
  upsert outcomes(order_ref):
    first_delivered_at = least(old, at if status=delivered)
    last_delivered_at  = greatest(old, at if status=delivered)
    first_return_at    = least(old, at if status=return)
    last_return_at     = greatest(old, at if status=return)
    last_status/last_tracking_code only if at >= old.last_status_at
outcome (generated):
  if first_return and (first_delivered is null or first_delivered > first_return)
     and (last_delivered is null or last_delivered <= last_return)  → 'refused'       (carrier return, never delivered)
  elif first_return and first_delivered <= first_return             → 'returned_after_delivery' (customer return)
  elif last_delivered not null                                       → 'delivered'
```
This separates "refused/undelivered" from "returned after delivery", which matters for P/L and risk.

### C.4 Exception work queue (holds) — enqueue / auto-close / reopen
Source: `gls_giacenze_sync()`.
```
eff := effective rows (bucket, source, delivery_errors, created_at, carrier, order_void)
motivo(row) := 'HOLD_OPEN' if bucket='stock'
            else 'FAILED_ATTEMPT' if delivery_errors>0 and bucket in (pending,in_transit,out_for_delivery,exception)
                                   and created_at > now()-window_days(30)
            else null
close := open queue rows where bucket in finals (delivered/refused/returned*/failed) or order_void
         or (motivo is null and source is a confirmed source)
         → resolution_action = auto_delivered | auto_returned | auto_failed | auto_cancelled | auto_released, notes
reopen := rows resolved with resolution_action LIKE 'auto_%' whose motivo is not null again → clear resolved_at/claim
update motivo on open rows if changed
insert new rows for (motivo not null, not void, carrier matches) ON CONFLICT (shipment_id) DO NOTHING
dry_run returns counts only; result stored in app_settings for "last sync" display
```
Manual resolutions are never overwritten; claim is soft (`claimed_by`, `claimed_at`); page RPC returns `{total, rows, counts, last_sync}` with filters open/giacenza/failed_attempt/unconfirmed/claimed/resolved.

### C.5 Inventory sync levels
Source: `shopify-sync/index.ts` `syncInventoryFromProducts`, `zeroInventorySnapshotsNotTouchedSince`, `shopify-refresh-variant-stock/index.ts`.
```
FULL/DELTA SYNC (cron nightly full; delta otherwise):
  cursor := sync_status['inventory'].cursor_data  -- {next_url, high_water_mark, is_full_sync, inventory_full_started_at}
  if resuming: endpoint := cursor.next_url
  else: endpoint := products.json?limit=5&fields=...&updated_at_min=high_water_mark (delta only)
  started_at := now (full only, kept across resumes)
  while endpoint and time_budget_left:
     page := GET endpoint (429 → sleep Retry-After, retry; min gap between calls)
     expand products with ≥100 variants via products/{id}/variants.json (paginated)
     upsert products + variants locally (so inventory covers never-imported SKUs)
     item_ids := variants.inventory_item_id
     qty := GET inventory_levels.json?inventory_item_ids=chunk(50) ; sum `available` per item across locations
     upsert inventory_snapshots {variant_id, available_quantity, reserved 0, shopify_synced_at=now} in chunks of 200
     save cursor {next_url, high_water_mark=max(updated_at), is_full_sync, started_at}
     endpoint := next_url (Link header)
  if finished:
     if full: zero every snapshot with shopify_synced_at < started_at and available <> 0 (batches of 500)
     reset cursor
  else: enqueue self-continuation in background (EdgeRuntime.waitUntil → POST self with same params)

REALTIME: orders/create|updated|paid, fulfillments/* and inventory_levels/update webhooks → background read of
  inventory_levels for the involved variants only → upsert snapshots.

ON-DEMAND (UI): POST variant_ids → resolve missing inventory_item_id via variants/{id}.json (persist it) →
  inventory_levels for up to 50 items per call → upsert. Missing snapshot in UI = "Stock not synced" badge, never OOS.
```
Client-specific: the level sum collapses all locations into one number; Keel needs `inventory_levels(variant_id, location_id, available)`.

### C.6 Sales velocity / coverage / risk / reorder suggestion (exact formulas)
Source: `reorder_dashboard_grouped`, `reorder_variants_for_product` (`20260508195702_*.sql`).
```
PARAMS lookback_days L (default 7 in SQL, 30 in UI; selector 7/14/30/60/90), target_days T = 30
EXCLUDE variants whose sku ∈ service SKUs (client-specific: contrassegno, assicurazione-pacco)

units_sold(v)  = Σ order_items.quantity for orders with status <> cancelled and created_at >= now()-L days
stock(v)       = latest inventory_snapshots.available_quantity (0 if none)
incoming(v)    = Σ purchase_order_items.quantity for POs with status ∈ {confermato, pagato, ritirato}
effective(v)   = stock + incoming
velocity(v)    = round(units_sold / L, 4)                         (0 if L=0)
days_left(v)   = if units_sold = 0: (9999 if effective > 0 else 0)
                 else round(effective / (units_sold / L), 1)
risk(v)        = critical if effective = 0
                 critical if units_sold>0 and days_left <= 7
                 warning  if units_sold>0 and days_left <= 21
                 ok otherwise
pack suggestion (only if a size curve exists and qty_per_size(v.size) > 0):
  blocks(v)    = 0 if velocity = 0
                 else ceil( max(velocity*T − effective, 0) / qty_per_size(v.size) )
  per colour c = MAX blocks(v) over variants of colour c (colour key = lower(trim(color)) or '__nocolor__')
  per product  = Σ per-colour blocks ; also returned as jsonb {colour: blocks}
  simulated_units(v, N_c) = qty_per_size(v.size) * N_c

product aggregates: total_stock = Σ stock; total_velocity = Σ velocity; units_sold = Σ;
  worst_days_remaining = MIN(days_left ≠ 9999) (9999 if all); worst_risk = critical > warning > ok;
  counts of critical/warning/ok variants; incoming_units = Σ incoming.
list: server-side search/filter (all/critical/warning/ok), sort whitelist, LIMIT/OFFSET 50, total_count.
```
Alerts (`refresh_uncovered_critical_alerts(L)`): critical := stock = 0 or stock/(units_sold/L) ≤ 7 (stock only, no incoming); covered := variant in any PO with status ∈ {confermato, pagato, ritirato}; resolve alerts for non-(critical ∧ uncovered); insert for the rest with `priority_score = 100 if stock=0 else max(0, 50 − 5*days_left)`.

Note the inconsistency the codebase carries: "incoming" uses three different status sets depending on the view (reorders: confermato/pagato/ritirato; order "verify stock" and capacity RPC: da_confermare..ricevuto; product-register value: bozza..ritirato). Keel should define one `incoming_statuses` set per tenant.

### C.7 Capacity decomposition for order editing
Source: `compute_variant_capacity(variant_ids, exclude_order_id)`.
```
stock_now      = latest snapshot available
incoming       = Σ PO lines, PO not cancelled, status ∈ {da_confermare, confermato, pagato, ritirato, ricevuto}
committed_open = Σ order_items.quantity of orders not cancelled/replaced/delivered/returned (excluding the edited order)
backorder_open = Σ order_item_backorders.qty with status ∈ {pending, covered} (excluding the edited order)
original_in_order = quantity already on the edited order
cap            = max(stock_now + incoming + original_in_order, 0)
next_arrival_date / next_po_id = earliest expected_arrival_date among incoming POs
snapshot_missing, snapshot_synced_at
```
Frontend `computeBackorderItems` (`src/lib/backorder.ts`): backorder qty = max(0, requested − stock_now) per variant line.

### C.8 Purchase order lifecycle → cost → stock → backorder release
```
STATES  bozza → da_confermare → confermato → pagato → ritirato → ricevuto → a_stock ; annullato (any time before a_stock)
on status change (BEFORE UPDATE trigger handle_po_status_change):
   set confirmed_at/paid_at/picked_up_at/received_at/stocked_at/cancelled_at = now() if null
on line insert/update/delete (AFTER trigger): purchase_orders.total_amount = Σ line_total  (line_total = quantity*unit_price GENERATED)
line quantity = cartons × pieces_per_carton (UI), manually overridable; carton_code stored per line
on save (frontend, Acquisti.tsx): products.last_purchase_cost := unit_price of the last line per product  ← feeds COGS/P/L
on → ricevuto (AFTER UPDATE trigger po_received_trigger_backorder_check):
   variant_ids := distinct line variants; POST orders-check-backorder-stock {variant_ids} (pg_net)
on → a_stock (AFTER UPDATE trigger po_stock_snapshot):
   for each line: upsert inventory_snapshots(variant_id) available += quantity   (no Shopify write-back)

orders-check-backorder-stock(variant_ids | order_id | none=all awaiting):
   for each candidate order with backorders in {pending, covered}:
      caps := compute_variant_capacity(variants, exclude=order)
      for each backorder b: new := fulfilled if stock_now ≥ b.qty ; covered if incoming > 0 ; else pending
      if all fulfilled and order.awaiting_stock_since: call internal_mark_stock_ready (tag "Pronto da spedire"),
         clear awaiting_stock_since, insert order_event 'stock_disponibile', notify admin/operations
PO list badge: purchase_orders_backorder_coverage(po_ids) → orders_count, units_total, details[] of waiting orders
   matched on variant with backorder status ∈ {pending, covered} and order.awaiting_stock_since not null.
```
For Keel: fire the release on the state that actually puts goods on shelf (receipt), update cost on receipt (server-side, average or last cost configurable), optionally push `inventorySetQuantities` to Shopify per location, and record an inventory movement row rather than overwriting a snapshot.

### C.9 Supplier balance computation
```
open_amount(supplier) = Σ purchase_orders.total_amount
                        WHERE status NOT IN ('bozza','annullato') AND paid_at IS NULL
po_count, oldest_unpaid_purchase_date = count / MIN(purchase_date) over the same set
HAVING open_amount > 0 ; search on name/company/payee_name ; sort whitelist ; LIMIT/OFFSET
mark paid: UPDATE status='pagato' → trigger sets paid_at → row leaves the balance view
drill-down: supplier_outstanding_orders(supplier_id) same predicate ordered by purchase_date desc
```
No partial payments, no credit notes. Keel's `supplier_ledger` should store payments explicitly and derive balance = Σ PO totals (non-draft, non-cancelled) − Σ payments.

### C.10 Customer returns workflow
Source: `20260915062000_returns_process.sql` (+ photos `20260915091000`, tracking/intents `20260928080000`).
```
CONFIG returns_config: window_days (14), shipping_fallback_days (5), return_cost_customer_fault (null|€),
       warehouse_address, support_email, excluded_skus[], excluded_sku_prefixes[], excluded_title_patterns[]

ELIGIBILITY(order):
   delivery := coalesce(delivered_at, shipped_at + fallback_days)
   deadline := delivery + window_days
   blocked if cancelled/replaced → 'cancelled'; if delivery null or delivery_status = returned → 'not_delivered';
   if now > deadline → 'window_expired' (staff may override with mandatory staff_note → out_of_window=true);
   if no returnable lines → 'no_returnable_items'
RETURNABLE LINES(order):
   exclude lines matching excluded SKUs/prefixes/title patterns (case-insensitive)
   unit_net_price := round(unit_price × (1 − min(order.total_discounts / Σ line totals, 1)), 2)   -- pro-rata order discount
   qty_returnable := quantity − Σ qty in returns with status <> rifiutato
CREATE (shared staff/customer; advisory lock per order; idempotency_key short-circuit):
   validate reason ∈ list, resolution ∈ {rimborso, cambio, buono}
   fault := nostro if reason ∈ {difettoso, danneggiato, non_conforme, articolo_sbagliato}
            cliente if reason ∈ {taglia_errata, cambio_idea} ; else da_valutare
   customer + cambio ⇒ exchange_request required; photos: paths must start with session prefix, ≤5 product, ≤2 label,
   ≥1 of each for customers; customer + rimborso + payment cod ⇒ IBAN (mod-97 valid) + holder required;
   tracking: normalised upper, no spaces/dots, ^[A-Z0-9-]{6,40}$, unique among non-rejected returns;
   items: no duplicates, 1 ≤ qty ≤ qty_returnable
   insert returns + return_items(line_amount = unit_net × qty); recompute; log order_event 'reso_richiesto'
RECOMPUTE(return):
   items := Σ coalesce(inspection_amount, line_amount)
   cost  := return_cost_customer_fault if fault = cliente and resolution = rimborso else 0
   proposed_total := max(items − cost, 0)
TRANSITIONS (returns_transition(ids[], action, data) — bulk, each row FOR UPDATE, returns {done[], skipped[{reason}]}):
   approve/reject/set_fault require 'richiesto' ; approve refused while fault = da_valutare ; reject needs reason
   receive requires 'approvato': items optional (one return at a time when given); each item outcome ∈
      {integro, danneggiato, mancante}, amount ∈ [0, line_amount], note mandatory if amount ≠ line_amount,
      restocked flag; without items ⇒ all integro, full amount; then recompute
   close_paid / close_voucher / close_exchange require 'ricevuto' and matching resolution_type;
      close_paid: paid_amount (default proposed_total), paid_at, paid_method ∈ {bonifico, shopify, paypal, altro}
      close_voucher: voucher_code required, value default proposed_total
      close_exchange: replacement_order_id must exist
   every transition logs an order_event with metadata {return_id, return_number}
PUBLIC ACCESS: lookup(order_input, contact, ip): rate limit 5 failed / 15 min per ip and per order number;
   contact matched on normalised email or E.164 phone (customer or shipping phone); success → session token (60 min);
   signed upload URLs scoped to sessions/<token>/; submit via token. Intents table tracks "opened instructions, not submitted".
LIST: filters status/resolution/reason/payment/date/q (order no., R-number, phone, name, email), counts by status,
   days_in_status from the last transition timestamp, IBAN only for writers.
```
Restock is only a boolean on `return_items`; nothing moves stock. Keel should turn `restocked` into an inventory movement at a chosen location and optionally a Shopify restock.

### C.11 Discount sync, creation, and bulk unique-code pools
Catalog sync (`shopify-discounts-sync`):
```
pool_gids := gids of locally-managed pools (skip them)
REST: for price_rule in GET price_rules.json?limit=250 (follow Link rel=next):
   for code in GET price_rules/{id}/discount_codes.json: upsert discounts ON CONFLICT (code)
      type: shipping_line → free_shipping; value_type percentage → percentage; else fixed_amount; value = |value|
      minimum_amount from prerequisite_subtotal_range.greater_than_or_equal_to; usage_limit; used_count = dc.usage_count
      is_active = ends_at null or in future
GraphQL discountNodes(first:100) paginated: DiscountCodeBasic / DiscountCodeFreeShipping / DiscountAutomaticBasic /
   DiscountAutomaticFreeShipping → value: percentage*100 or amount; automatic ones stored as code 'AUTO:<title>';
   is_active = status = ACTIVE; used_count = asyncUsageCount
scope errors (read_price_rules / write_discounts) surfaced as MISSING_SHOPIFY_SCOPE with remediation text.
```
Single code creation (`shopify-discount-create`, REST 2024-01): `POST price_rules.json {title, target_type: line_item|shipping_line, target_selection: all, allocation_method: across, value_type, value: "-10.00" or "-100.0" for shipping, customer_selection: all, starts_at, ends_at, prerequisite_subtotal_range?, usage_limit?}` then `POST price_rules/{id}/discount_codes.json {discount_code:{code}}`; store both ids, `source='platform'`.

Bulk unique pool (`shopify-discount-pool` + `_shared/discountPool.ts` + `shopifyAdmin.makeDiscountCode`):
```
CODE FORMAT: prefix 'LM-' + 8 chars from a fixed alphabet via crypto.getRandomValues (uppercase; DB CHECK code = upper(code))
GENERATE N: loop (max 50 rounds): build a Set of fresh codes, upsert into codes table with ignoreDuplicates on PK code,
   keep only returned rows; repeat until N collected  → collision handling by DB uniqueness, never by lookup
CREATE: insert pool(status creating); codes := generate(N)
   discountCodeBasicCreate(input) with input = {title, code: codes[0], startsAt, endsAt, customerSelection:{all:true},
      customerGets:{value:{percentage: v/100}, items:{all:true}}, appliesOncePerCustomer:true,
      combinesWith:{orderDiscounts:false, productDiscounts:false, shippingDiscounts:true},
      minimumRequirement?:{subtotal:{greaterThanOrEqualToSubtotal}}}   -- NO usageLimit (it is per discount, not per code)
   store shopify_discount_gid; mark codes[0] available
   discountRedeemCodeBulkAdd(discountId, codes[]) in blocks of 250 → store bulkCreation.id on each code row
   if ≤4 blocks: wait 3 s and poll, else return 'creating'
POLL (cron): for each pending block gid: discountRedeemCodeBulkCreation(id){done, codes(first:250){code, errors}}
   failed := codes listed with errors; imported := rest → statuses available/failed; pool ready if any available else error
REFILL: same as create minus the discount creation; target_size += count
PURGE REDEEMED: find exact DiscountRedeemCode id per code (query without 'code:' prefix, exact match client-side) then
   discountCodeRedeemCodeBulkDelete(discountId, ids[]) in blocks of 250 — never the `search` argument (would match prefix)
DISABLE: discountCodeDeactivate + codes available/pending → void
AUTO-MAINTAIN: RPC marketing_discount_pool_needs → refill or rollover (new pool titled with next month, endsAt = end of next month)
Scope errors (ACCESS_DENIED / write_discounts) → HTTP 403 scope_missing; logs never contain codes in clear.
```

---

## D. Things to explicitly NOT bring into a generic core
- Elogy, Qapla', GLS as named columns, enums, cron names, numeric tracking codes (0/17/17.4/17.5/18/19/19.1/21/26/30) and Italian status names (`consegnato`, `rientrato`, `giacenza`…). Keel: generic `shipment_sources` with a per-tenant mapping table and a precedence config.
- `orders.delivery_status` Italian vocabulary and tag-derived order workflow (`derive_order_workflow_from_tags`, tags `Confermato`, `Attesa stock`, `Pronto da spedire`, `RIMBORSATO`, `Rientrato <CARRIER>`, `Reso al mittente`). Keel state must come from `state_rules`, never fixed tags.
- Carrier-return automation that cancels Shopify orders with `restock:false` and posts a 0.00 void on a pending COD sale; "19.1 vs 21" semantics; `carrier_return_*` tables. COD-only and tied to the Italian 3PL. If anything, an `addon.cod` concern.
- GLS hold queue specifics: branch codes, instruction emails via Resend with Italian templates, hold rules engine (`shipment_holds`, `hold_rules`, `hold_settings`, `hold_economics`), mock SOAP adapter, `GLS_*` secrets.
- Elogy push payload (`gateway=cashondelivery`, flat address, `LM` prefix), `elogy_net_stock` mirror, `elogy_stock_records`.
- Variants as fixed `color` + `size` columns, SKU convention `Name-CODE-SizeColorEN`, `translate-color` (Italian→English via AI), shoe size presets, carton presets 24/30/36/72 and the per-size curve (`sizes_qty`). Generalise to dynamic options and an optional "pack size per variant/supplier".
- Italian product categories and `suggestCategoryFromTitle` regexes; `product_status` Italian enum.
- Service SKUs `Contrassegno` / `Assicurazione-pacco` filtered by name in SQL; `is_ancillary` flag is the better idea — keep the flag, drop the names.
- PO `destination_warehouse` CHECK list (`plogistics`, `lendinara`, `elogy`, `warehouse`), `inbound_system` list, Europe/Rome defaults, VAT 22% display (`i.i. = i.e. × 1.22`).
- Returns: `#LM` order-number parser, Italian reason/resolution/status codes as DB CHECKs (make them tenant-configurable), IBAN capture for COD refunds (COD add-on), `RIMBORSATO` tag side-effect, `<support-email>` defaults.
- Discount pool naming `LM-WA`, Spoki campaign coupling (`spoki_campaigns`, `spoki_campaign_recipients`), Italian month names in rollover titles.
- Supabase-specific mechanics: `has_role()`/`current_user_has_page()` inside RLS, `security_invoker=false` search views, `pg_net` HTTP calls from triggers, `app_settings` key/value for secrets and URLs, `EdgeRuntime.waitUntil`, `count: estimated`. Keel uses pg-boss jobs and `withTenant`.
- Frontend-side writes of derived business data (e.g. `last_purchase_cost` written from `Acquisti.tsx`).

---

## E. Pure utility functions worth reusing (verbatim or near-verbatim)
| Name | Path | What it does |
|---|---|---|
| `elogyData`, `mapElogyLastStatus`, `mapElogyTrackingCode`, `mapElogyTrackingName`, `isReturnAfterDelivery` | `supabase/functions/_shared/elogyStatus.ts` | Pure status normaliser with the "return after delivered stays delivered" rule; template for any 3PL adapter mapping. |
| `extractOrderDiscounts` | `supabase/functions/_shared/orderDiscounts.ts` | Normalises Shopify order discounts (`current_total_discounts` preference, `discount_applications` enrichment, automatic discounts). Directly reusable in the Shopify adapter. |
| `makeDiscountCode(prefix, len)`, `chunk(arr, size)` | `supabase/functions/_shared/shopifyAdmin.ts` | Crypto-random code generator over a fixed alphabet; array chunking. |
| `shopifyGraphql` (retry on 429/THROTTLED using `extensions.cost.throttleStatus`, max 3) | `supabase/functions/_shared/shopifyAdmin.ts` | GraphQL client with throttle-aware retry; `shopifyFetch` attaches `status` and `retryAfter` to errors. |
| `isPoolDiscount`, `poolGidSet`, `buildBasicCodeDiscountInput`, `classifyBulkCreation`, `pickExactRedeemCodeId`, `isScopeError`, `endOfNextMonth`, `planMaintenance` | `supabase/functions/_shared/discountPool.ts` | Pure, vitest-tested pieces of the bulk unique-code flow (GraphQL input shape, bulk result classification, exact-id selection, scope error detection). |
| `decideCarrierReturn`, `needsVoidAfterCancel`, `pickVoidGateway`, `buildVoidTransaction`, `buildLocalCancelPatch`, `parseTags`, `throttleWaitMs`, `parseRetryAfterMs`, `retryWaitMs` | `supabase/functions/_shared/carrierReturns.ts` | Business decision is COD/Elogy specific, but `throttleWaitMs` / `parseRetryAfterMs` / `retryWaitMs` (min gap between calls; backoff 2-4-8 s or `Retry-After`, whichever is longer) are generic rate-limit helpers. |
| `pickElogyApiOrder`, `ingestElogyApiOrders` | `supabase/functions/_shared/elogyIngest.ts` | Pattern: pick only non-PII fields and hand ≤1000 rows to a service RPC. |
| `computeBackorderItems`, `totalBackorderUnits` | `src/lib/backorder.ts` | Backorder quantity per line = max(0, requested − stock_now), skipping service lines. |
| `buildInventoryMatrix`, `incomingByVariant`, `sortSizes`, `isIncomingStatus` | `src/lib/productInventory.ts` | Option × option matrix with incoming PO units per cell and natural/numeric size sort (generalise axes). |
| `isExcludedItem` | `src/lib/returns/exclusions.ts` (SQL twin `_returns_item_excluded`) | SKU exact / prefix / title-contains exclusion rules. |
| `normalizeTracking`, `isValidTracking`, `carrierLabel` | `src/lib/returns/tracking.ts` | Return-shipment tracking normalisation and validation. |
| `normalizeIban`, `isValidIban` | `src/lib/returns/iban.ts` (SQL twin `_returns_iban_valid`) | IBAN format + mod-97 checksum (COD add-on). |
| `returnBadgeForLine`, `RETURN_EVENT_LABELS`, `isReturnEvent` | `src/lib/returns/order-returns.ts` | "Returned q/n" badge and event-type registry (labels need i18n). |
| `bulkHeadline`, `bulkSkippedLines`, `bulkSummary` | `src/lib/returns/bulk-summary.ts` | Formats `{done[], skipped[{reason}]}` results of bulk actions. |
| `csvEscape`, `csvAmount`, `RETURNS_CSV_HEADERS` | `src/lib/returns/csv.ts` | CSV export helpers (`;` separator, UTF-8 BOM, comma decimals — make locale-driven). |
| `stepForErrorCode` | `src/lib/returns/error-routing.ts` | Maps server error codes to the form step that should show them. |
| `photosComplete` | `src/lib/returns/photos.ts` | Upload-group completeness check. |
| `calcDiscountAmount`, `validateDiscountApplicability`, `formatDiscountLabel` | `src/lib/discounts.ts` | Client-side discount maths and validity checks (percentage/fixed/free shipping, min amount, dates, usage limit). |
| `BUCKET_UI`, `sourceLabel`, `giacenzaMotivoLabel`, `giacenzaResolutionLabel` | `src/lib/logisticsStatus.ts` | Bucket → label/variant map; useful as the shape of a status registry (labels to i18n). |
| SQL: `_returns_order_lines` pro-rata net price, `_returns_eligibility`, `_returns_recompute`, `returns_transition` skip-report pattern | `supabase/migrations/20260915062000_returns_process.sql` | Reimplement in `packages/core` as pure functions with tests (pro-rata discount allocation, window computation, proposed refund). |
| SQL: `elogy_ingest_outcome_event` least/greatest fold | `supabase/migrations/20260915070001_risk_outcomes_v1.sql` | Commutative event folding for shipment outcomes. |
| SQL: `compute_variant_capacity` | `supabase/migrations/20260907110039_*.sql` | Stock / incoming / committed / backorder decomposition. |
| SQL: `refresh_uncovered_critical_alerts` | `supabase/migrations/20260508195702_*.sql` | Idempotent alert refresh with priority score. |

### Additional cross-cutting patterns observed (for ARCHITECTURE/DECISIONS)
- Every list RPC: server-side search with a whitelist for sort columns, `LIMIT 50 OFFSET`, `total_count` in each row or a `{total, rows, counts}` jsonb; counts computed in the same query.
- "Last sync" surfaced to the UI from `sync_status` or an `app_settings` key written by the job itself.
- Jobs are budgeted (~100–110 s), save a resume cursor after every batch, and re-enqueue themselves; "recent pass" skip prevents duplicate daily passes; `force=1` and `window=` for operators.
- Webhooks: verify (shared secret in query or HMAC header), write the raw log row, ack 200, process with `waitUntil`; replays read from the log; dedup by `(external_id, topic, updated_at)` for Shopify.
- Concurrency for workers: DB claim with `FOR UPDATE SKIP LOCKED`, `attempts`, `claimed_at` expiry (15 min) and max-attempt escalation to `error`.
- Idempotency: unique constraints as the only collision handling (`ON CONFLICT DO NOTHING`), `idempotency_key` columns with partial unique indexes, advisory locks per aggregate (`pg_advisory_xact_lock(hashtextextended('returns:'||order_id,0))`).
- Audit: every write-RPC inserts an `order_events` row with actor and metadata; triggers insert `logistics_events` for status conflicts.
