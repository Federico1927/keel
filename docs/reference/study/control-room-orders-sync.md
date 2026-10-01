# Control Center (Lorena Milano) — Study: Orders core, Shopify sync, webhooks, timeline, customer history, customer care, dashboard, state derivation

Reference repo (read-only): `/home/user/lorena-control-center`
Stack: React + TS (Vite) frontend, Supabase (Postgres + RLS + Edge Functions in Deno). ~240k orders in production, which shaped most of the performance-related patterns below.

Sources read: `.lovable/memory/**` (index, tech, features, constraints), `docs/team/02-dashboard.md`, `03-ordini.md`, `04-customer-care.md`, `17-glossario.md`, then code under `supabase/functions/*`, `supabase/functions/_shared/*`, `supabase/migrations/*.sql`, `drizzle/migrations/*.sql`, `src/lib/*`, `src/components/orders/*`, `src/pages/*`, `src/hooks/*`, `src/integrations/supabase/types.ts`.

Classification legend used in section A:
- **GENERIC** – reusable for any e-commerce (goes into Keel core, rewritten for the canonical model).
- **COD-ONLY** – only makes sense when payment is collected at delivery (candidate for `addon.cod`).
- **CLIENT-SPECIFIC** – Lorena / Italy / shoes / Elogy / Releasit / Shopify-Flow workaround; do not port.

---

## A. Feature inventory

| Feature | Where (file paths) | What it does | Class | Logic worth reusing |
|---|---|---|---|---|
| Webhook receiver with HMAC + immediate ACK + background processing | `supabase/functions/shopify-webhook/index.ts` (`Deno.serve`, lines ~1281-1448); memory `tech/webhook-ack-pattern.md` | Verifies `X-Shopify-Hmac-Sha256` synchronously (fail closed when secret missing), then returns `200 {ok:true, queued:true}` and does all DB work inside `EdgeRuntime.waitUntil`. Internal errors still ACK 200 so Shopify never disables the webhook. | GENERIC | Verify → ack → process-in-background; never let DB latency reach the sender. Keel: verify HMAC, persist raw event, enqueue pg-boss job, return 200. |
| Webhook log table as idempotency + retry queue | `shopify-webhook/index.ts` (`shopify_webhook_logs` insert/update, `handleReplay`), `src/pages/WebhookPage.tsx` | Every event is inserted as `processed=false` with full payload; marked `processed=true` on success, or `error` JSON + `retry_count` on failure. Dedup window: skip if same `(shopify_id, topic, payload.updated_at)` processed in last 60 s. `?action=replay` reprocesses failed rows (filters: `only_timeout`, `max_age_days`, `max_retry`, explicit `log_ids`). High-frequency topics downgrade payload to a "light" stub after success to save storage. Admin page lists failed logs, replays one/all, deletes. | GENERIC | Event log = queue + audit + replay. Dedup by `(external_id, topic, source_updated_at)`. Keep full payload until processed. |
| Topic router | `shopify-webhook/index.ts` `TOPIC_HANDLERS` | Map topic → handler: `orders/create|updated|cancelled|paid` → `upsertOrder`; `fulfillments/create|update` → `handleFulfillmentWebhook`; `products/*`, `inventory_levels/update`, `customers/create|update`. Unknown topics logged only. | GENERIC | Simple dispatch table; handlers are idempotent upserts. |
| Webhook self-registration | `shopify-webhook/index.ts` `registerWebhooks` (GET) | Lists existing webhooks for the callback URL, registers only missing topics, reports per-topic status. | GENERIC | Idempotent registration diffed against existing subscriptions. |
| Order payload mapping | `shopify-webhook/index.ts` `mapOrderData`, `shopify-sync/index.ts` `mapOrderData` | Normalizes Shopify order → local row: prefers `current_total_price` over `total_price` (post-edit totals), phone fallback chain `order.phone → shipping.phone → billing.phone → customer.phone`, name fallback `customer → shipping.name → billing.name`, tags split/trim, payment gateway → method, discounts extracted via shared helper. | GENERIC (except gateway→method mapping which is CLIENT-SPECIFIC: `cod/carta/paypal`) | Field-precedence rules; `current_*` fields win. Keel: map `payment_gateway_names` through a per-tenant configurable gateway→method table. |
| No-op skip for noisy `orders/updated` | `shopify-webhook/index.ts` `upsertOrder` lines ~282-346 | Shopify fires 14-18 updates/day/order. Before writing, compares status, financial, fulfillment, total, tags (sorted), cancelled_at, customer name/phone, shipping phone and a canonical line-item fingerprint; if nothing relevant changed, returns without upsert/events. | GENERIC | "Significant-field fingerprint" before writes; must include line items so missing rows get repaired (memory `shopify-order-sync-integrity.md`). |
| Non-destructive line-item sync | `shopify-webhook/index.ts` lines ~462-549; `shopify-sync/index.ts` `batchUpsertOrderItems` | Filters out `current_quantity = 0` rows (removed by Order Editing) except on cancelled orders (keep originals for visibility). Upsert on `shopify_line_item_id` first; delete stale rows only after upsert success; on batch error retry per-row, never empty the order. | GENERIC | Upsert-then-cleanup ordering; per-row fallback. |
| Timeline event with diff on every webhook update | `shopify-webhook/index.ts` lines ~420-460 | Writes `order_events` (`shopify_import` / `shopify_update`) with `metadata` = `{from,to}` per changed scalar field, `tags:{added,removed}`, `shipping_address:{field:{from,to}}`. | GENERIC | See C.5 for algorithm. |
| Timeline event with diff on operator edits | `shopify-order-actions/index.ts` action `update` lines ~1236-1445 | Snapshots local order + items before the change, computes `customer_name`, `customer_phone`, address field diff, `notes {from,to,mode:append|replace}`, `line_items {added,removed,updated}` keyed by variant, `tag_added`; writes `ordine_modificato` with `actor_id`. | GENERIC | See C.5. |
| Timeline UI (author + diff rendering) | `src/components/orders/OrderTimeline.tsx` | Loads `order_events` desc, resolves `actor_id → profiles.display_name`, shows "Sistema" for known system event types without actor, renders `ChangeDetails` (from→to strikethrough, +/- tags, +/- line items, note append). | GENERIC | Event-type → icon map; system-vs-user attribution rule; diff renderer. |
| Internal notes with @mentions → notifications | `src/components/orders/InternalNotesCard.tsx`; migration `20260511193401_*.sql` (table `order_internal_notes`, trigger `notify_mentioned_users_on_internal_note`) | Textarea with `@` autocomplete over `profiles`; stores `mentions uuid[]` (only labels still present in text at save); realtime channel on the table; DB trigger inserts one `notifications` row per mentioned user (excluding author) with `link_to='/ordini/<id>'`. Delete only by author/admin. | GENERIC | Mention detection regex `(?:^|[\s(])@([\p{L}\p{N}._-]{0,30})$` before caret; keep mentions whose label survives; DB-side fan-out trigger. |
| Customer order history (multi-key transitive match) | RPC `get_customer_order_history` (`supabase/migrations/20260915100905_*.sql`, newer bucket version in `drizzle/migrations/0026/0030/0031`), keys in `20260907105050_*.sql`; hook `src/hooks/useCustomerOrderHistory.ts`; UI `src/components/orders/CustomerOrderHistory.tsx`; client mirror `src/lib/customerOrderHistory.ts` | Given one order (or free params), finds all orders of the same person via normalized strong keys (platform customer id, email, phone, address) with up to 3 hops of transitive closure (cap 300), plus weak name+zip match (not expanded). Returns matched_via per order, stats per bucket, `identified`/first-order states. | GENERIC | See C.6. |
| Previous address suggestions from history | `src/components/orders/PreviousAddressSuggestions.tsx` (uses same RPC) | Offers previously used shipping addresses when editing/creating an order. | GENERIC | Reuse history payload; dedupe by normalized address key. |
| Duplicate order detection (siblings) | RPC `get_duplicate_sibling_orders` (`supabase/migrations/20260703123126_*.sql`), banner `src/components/orders/DuplicateSiblingsBanner.tsx` | Same customer (platform id OR email OR phone digits ≥9), ±5 days, open (not cancelled/voided/refunded, not "annullato per variazione", excluding own lineage), sharing a product (`same_product`) or exact variant (`same_variant`). Bidirectional banner with links. | GENERIC (the non-product regex `commissione|contrassegno|assicuraz|mystery box` and "same size" wording are CLIENT-SPECIFIC) | See C.7. |
| Order merge (unisci ordini) | `shopify-order-actions/index.ts` action `merge` (~2352-2700), `src/components/orders/MergeOrderDialog.tsx` | Pick destination + N sources of same customer; unified item table; per source: replace destination line items via Order Editing, refund+restock+cancel the source, tag both (`Unito con #X`/`Unificato in #Y`), events on both; fallback "merge via recreate" when destination not editable. | GENERIC (concept) / CLIENT-SPECIFIC (tag names, Releasit fallback) | Multi-source merge loop; lineage inheritance on recreate. |
| Cancel & recreate with lineage | `shopify-order-actions/index.ts` action `cancel_and_create` (~1951-2300); columns `replaces_order_id`, `replaced_by_order_id`, `lineage_root_id`, `is_replacement`; `src/components/orders/OrderLineageBanner.tsx` | New order on Shopify, old order marked `status='sostituito'`, `total=0`, `financial_status='voided'`, `cancelled_at`. New local row inherits `created_at`, `assigned_to`, `first_contact_at`, `contact_attempts_count`, `notes` from the lineage root so KPIs stay on the original day. Attribution note_attributes copied; click-ids renamed `lm_orig_*` to avoid double conversions. Events `ordine_sostituito` / `ordine_creato`. | GENERIC | Lineage chain fields; "replaced" as a distinct terminal state excluded from KPIs; inherit creation day for metrics. |
| Local cancellation guard | `_shared/orderStatus.ts` `applyLocalCancellationGuard`; DB trigger `orders_guard_cancelled_state` (`20260914200816_*.sql`) | Three invariants applied both in code (webhook, sync, reconcile) and as BEFORE UPDATE trigger: (1) `sostituito` is terminal; (2) cancelled + `replaced_by_order_id` ⇒ `sostituito`; (3) a locally cancelled+zeroed order never regains total or drops from `voided` back to `pending/authorized`. | GENERIC | Protect locally-authoritative terminal states from upstream overwrites. |
| Ghost order handling (deleted on Shopify) | `shopify-order-actions/index.ts` action `cancel` (~850-900) | Probes `GET orders/{id}`; on 404 skips all remote calls and aligns locally (cancelled, voided, total 0, unassign) with event `ordine_non_piu_su_shopify`; UI shows info toast. | GENERIC | Probe-before-mutate; degrade to local-only alignment on 404. |
| Cancel with selective refund + restock | `shopify-order-actions/index.ts` `buildRefundPayload` (~240-290), `cancelWithRestock` (~295-310) | For captured payments: compute remaining refundable per parent transaction, refund with `restock_type: cancel`; for pending (COD) skip pre-refund; then `cancel.json {restock:true}`; if restock fails, still cancel and log `storno_stock_mancato`. | GENERIC | Refund-remaining computation; "cancel anyway, log restock failure". |
| Customer name propagation | `_shared/customerNameSync.ts` (`buildCustomerNameUpdate`, `splitCustomerName`), webhook `upsertCustomer` | On `customers/update`, propagate `first+last` to all orders of that customer where different; events only on 10 most recent; never blank a name. Reverse: order edit updates Shopify customer + contacts; failure logged as event, never fails the edit. | GENERIC | Pure diff function + capped event noise. |
| Periodic delta sync with resumable cursor | `supabase/functions/shopify-sync/index.ts` (`getCursorData`, `saveCursorData`, `syncSingleType`, `getNextSecondaryType`) | Cron-driven; orders use rolling 30-day `created_at_min` + `updated_at_min` = high-water-mark minus 2 min overlap; early-exit if first page empty; pagination via `Link: rel=next`; cursor (`next_url`, `high_water_mark`, `query_*`) persisted after every page in `sync_status.cursor_data`; 25 s wall budget then "pause, resume next round"; secondary types (products, customers, inventory) round-robin with resume priority. 650 ms min interval and 429 retry-after. | GENERIC | See C.3. |
| Sync health indicator | `src/hooks/useOrdersSyncHealth.ts`, `sync_status` table, dashboard `SyncStatusWidget` | `sync_status(source, object_type, status, last_synced_at, last_error, cursor_data)`; UI flags error or staleness > 15 min. | GENERIC | Per-(source,object) status row. |
| Monthly reconciliation | `supabase/functions/shopify-monthly-reconcile/index.ts`, table `shopify_reconciliation_runs` | Cron day 2 of month (prev month, Europe/Rome) or `?month=YYYY-MM` / `?months=N`. Loads DB orders in range (pages of 1000), fetches Shopify in batches of 250 by ids with reduced `fields`, derives status, applies cancellation guard, skips unchanged, updates 50 in parallel; run row with counters (candidates, fetched, updated, not_found, unchanged, errors, duration). | GENERIC | See C.2. |
| Targeted re-sync | `supabase/functions/shopify-resync-by-ids/index.ts` | Modes `ids`, `all_in_range`, `date_range`, `all_voided`, `tag`; dry-run; background flag; never touches line items; never downgrades `confermato`→`nuovo`. | GENERIC | Ops tool pattern: dry-run + bg + modes. |
| Historical backfills (budgeted loops) | `shopify-backfill-items`, `shopify-backfill-phones`, `shopify-backfill-attribution` | Each: 25-45 s budget, batch 50-250 ids, throttle, RPC to find candidates (`orders_missing_items`), stop when a round updates nothing (anti tight-loop). Attribution backfill self-invokes to continue and persists state in `app_settings`. | GENERIC | See C.3 (backfill variant). |
| Marketing attribution capture (UTM / click ids) | `_shared/orderAttribution.ts` (`extractAttributionParams`, `captureOrderAttribution`), table `order_attribution`, trigger `compute_order_channel` (`20260703135317_*.sql`), `src/lib/orderChannel.ts`, `src/components/orders/OrderAttributionCard.tsx` | Extract `utm_*` and click ids (`fbclid`, `gclid/gbraid/wbraid`, `ttclid`, `msclkid`, `epik`, `li_fat_id`, …) from `landing_site`, `referring_site`, `note_attributes` (keys normalized); resolve campaign by `external_id` → normalized name → product primary link; upsert on `order_id` with `source` webhook/sync/backfill; DB trigger derives `derived_channel`. | GENERIC (`lm_pid/lm_aid` are CLIENT-SPECIFIC) | See C.8. |
| Customer journey via GraphQL `customerJourneySummary` | memory `features/shopify-customer-journey.md` only — **no code found in repo** (`shopify-fetch-journey`, `_shared/shopifyJourney.ts` absent) | Documented design: true channel from first/last visit, throttle-aware, idempotent `only_missing`. | GENERIC (design) | Treat as a spec, not as reference code. |
| Order state derivation (3 orthogonal dimensions) | `src/lib/orderState.ts` (`deriveWorkflowFromTags`, `deriveFulfillment`, `deriveDelivery`, `derivePrimaryStatus`, `deriveOrderState`); DB `derive_order_workflow_from_tags` (`20260907110039_*.sql`); `_shared/orderStatus.ts` `deriveOrderStatusFromShopify`; `pl_order_workflow_status` 7-arg (`drizzle/migrations/0017_*.sql`) | Workflow (from tags + cancelled_at), Fulfillment (from `fulfillment_status`), Delivery (from `delivery_status` column or shipment) combined with precedence `annullato > rientrato > consegnato > spedito > workflow`. Four copies must stay aligned (client, edge, SQL, P/L). | Pattern GENERIC; **tag vocabulary CLIENT-SPECIFIC** | See C.4. Keel must replace hardcoded tag sets with per-tenant `state_rules`. |
| Dashboard summary RPC | `dashboard_summary()` (`20260707062526_*.sql`), `docs/team/02-dashboard.md` | Single SQL returning today/yesterday/7-days-ago "running" comparisons (same minutes of day), revenue only for confirmed, breakdown by derived workflow, exclusions (`sostituito`, "annullato per variazione", zero-total paid replacements), plus operational counters (failed webhooks, exceptions, low stock, pending returns). Tenant timezone `Europe/Rome` hardcoded. | GENERIC (pattern) / CLIENT-SPECIFIC (COD KPIs, Rome TZ) | Running-window comparisons; one RPC for the whole KPI row; shared derivation function with list. |
| Orders list: server-side filters, search, pagination | `src/components/orders/OrdersTable.tsx` (`v_orders_list`, `count:'estimated'`, retry 3 w/ backoff), `src/lib/ordersFilterQuery.ts` (`applyOrderFilters`), `src/components/orders/OrderFilters.tsx`, `orders.search_blob` (`20260518105404_*.sql`), view `v_orders_list` (`20260910140140_*.sql`) | Search box auto-detects order numbers (strips `#`, `LM-`) → exact match; otherwise trigram ILIKE on generated column `search_blob` (name+email+phone+number). Filters on payment, workflow groups (expanded to equivalent tags), tags, fulfillment (null = unfulfilled), date on `shopify_created_at`, delivery with fallbacks, origin. Filters/sort/page persisted in sessionStorage. Lists read a `security_invoker=false` view to keep GIN/trgm indexes usable under RLS. | GENERIC (RLS-view trick is Supabase-specific, but the lesson applies) | Generated search column + trigram index; order-number detection; estimated counts on big tables; filter object → query builder. |
| Bulk actions | `src/components/orders/BulkActionBar.tsx`, docs 03 §Bulk | Select page, confirm/cancel/assign in batch (max 3 parallel), toast OK/failed. | GENERIC | Bounded parallelism + per-item result toast. |
| Order origin flag (`created_from_draft`) | trigger `orders_set_created_from_draft`, `OrderBadges.tsx` | Sticky boolean set once when tag `Bozza` appears; never lowered; filter in list. | GENERIC (as "origin/source channel" field) | Monotonic flag via trigger; origin ≠ status. |
| Shopify note vs internal notes | docs 03 §5b/5c; `shopify-order-actions` `update` with `note_append` | Shopify `note` editable (append or replace) and synced; internal notes separate and never leave the platform. | GENERIC | Keep platform note and internal notes as two entities. |
| Shipment status from multiple fulfillments | `shopify-webhook/index.ts` `pickBestFulfillment`, `applyShipmentUpdate`, `mapShopifyShipmentStatus` | Chooses best fulfillment (delivered first, else most recently updated), maps Shopify `shipment_status` to internal vocabulary, fills only missing fields on existing shipment row, only upgrades status from pending/unknown (other sources own later states). `source_of_truth='shopify'`. | GENERIC | Multi-source shipment model: each source writes its own field, a resolver decides (see Elogy/Qapla memory: newest event ≤24h wins, exceptions sticky, conflicts logged). |
| Customer care cockpit + activity tracking | `docs/team/04-customer-care.md`, memory `order-activity-tracking.md`; tables `customer_care_sessions`, `user_activity_pings`, `user_activity_daily`; RPCs `operator_efficiency_metrics`, `get_user_order_activity`, `get_order_team_time` | Per-operator queue, session tracking with 5-min idle rule (ping 1/min, session = gaps ≤2 min), "orders handled" = distinct orders with operator-authored events/attempts/notes, KPIs: handled, confirmed %, avg handling time (cap 4h), throughput/h, time-on-orders. | Mostly COD-ONLY (queue, call attempts, confirm rate); activity tracking itself GENERIC | Idle-aware time tracking from pings; "handled" defined by authored events, not assignment. |
| Scheduled confirmation | `orders-apply-scheduled-confirms`, `orders.scheduled_confirm_at/_by` | Operator schedules a day; daily cron applies. | COD-ONLY (confirm step) — the "scheduled action" pattern is GENERIC | Store scheduled_at + by; cron applies; failures retried next day by not clearing the field. |
| COD confirmation queue, auto-assignment, contact attempts | `is_cod_queue_order` (`drizzle/migrations/0019`), `auto_assign_cod_order`, `cod_contact_attempts`, `src/lib/codQueue.ts`, `src/pages/ConfermaCod.tsx` | Queue predicate = COD AND open AND not shipped AND workflow = to-confirm, independent of tags; attempts with outcome/channel; auto-assign on webhook. | COD-ONLY | Keep for `addon.cod`: state-based queue predicate rather than tag-based. |
| Delivery score / recipient risk | `orders.delivery_score*`, `contacts.delivery_score*`, `risk_config`, `recipient-risk/*`, memory `constraints/recipient-risk.md` | Score 0-100 with factor breakdown; duplicate-sibling factor; risk tiers by phone identity; suggestions only. | COD-ONLY | For `addon.cod` phase 11. |
| Variation lock / tag sanitation | `_shared/variationLock.ts`, webhook `lockEnforcedTags` | Keeps replacement orders' tags clean against Shopify Flow automations. | CLIENT-SPECIFIC | Do not port (symptom of tag-as-state). |
| Mark as paid (bank transfer) | action `mark_as_paid` | Records `bank_deposit` transaction, resets tags. | GENERIC (record manual payment) / CLIENT-SPECIFIC (tag reset) | Keep "record manual payment" with payment event; no tag semantics. |
| Order create / edit dialogs with backorder, COD fee, tax flags | actions `create`, `update`; `src/lib/backorder.ts`, `src/lib/cod-fee.ts`, memory `order-creation-tax.md` | Manual order creation from back-office with stock capacity, backorder hold, seller tag, tax-included flags. | GENERIC (manual order + backorder) / CLIENT-SPECIFIC (COD fee variant id, IVA-included hack, `Vendita <Nome>` tag) | `computeBackorderItems` (qty − stock_now per line). |

---

## B. Data model (orders domain)

Column lists come from `src/integrations/supabase/types.ts` (current state) and the original `supabase/migrations/20260325075935_*.sql`.

### `orders`
Identity & source: `id uuid`, `shopify_id text UNIQUE` (authoritative upsert key), `shopify_order_number text` (stored **without** `#`/`LM-` prefix), `shopify_order_number_int`, `shopify_customer_id text`, `created_at` (locally meaningful; inherited on replacement), `shopify_created_at` (real order date; used for dashboard/P-L bucketing and list sort), `shopify_synced_at`, `updated_at`.
Customer snapshot: `customer_name`, `customer_email`, `customer_phone`, `shipping_address jsonb` (Shopify shape: address1, address2, city, province, zip, country, phone, name).
Money & payment: `total numeric(10,2)` (post-edit current total), `currency` (default `'EUR'` — tenant-specific), `payment_method enum('cod','carta','paypal')` (client-specific; Keel needs `card|wallet|bank_transfer|cod|bnpl|other`), `financial_status text` (Shopify value), `total_discounts`, `discount_codes jsonb` (normalized `[{code,amount,type,percentage?,title?}]`).
State: `status enum order_status ('nuovo','da_confermare','assegnato','confermato','non_raggiungibile','richiamare','annullato','spedito','consegnato','reso')` + later `'sostituito'` — **mostly stale; true workflow is derived from `tags text[]`**; `fulfillment_status text` (Shopify), `cancelled_at`, `confirmed_at`, `shipped_at`, `delivered_at` (unreliable: "130k fulfilled without it"), `delivery_status text` (`in_transito|in_consegna|consegnato|eccezione|rientrato|non_disponibile`, written by carrier webhooks), `delivery_source`, `delivery_updated_at`.
Lineage: `replaces_order_id`, `replaced_by_order_id`, `lineage_root_id`, `is_replacement bool`, `variation_lock_active bool` (client-specific).
Ops / COD (addon): `assigned_to`, `first_contact_at`, `contact_attempts_count`, `resolution_at`, `cod_sub_status`, `scheduled_confirm_at/_by`, `awaiting_stock_since`, `sold_by`, `delivery_score`, `delivery_score_breakdown jsonb`, `delivery_score_computed_at`, `spoki_last_*`, `elogy_id`.
Other: `notes text` (= Shopify `note`), `created_from_draft bool NOT NULL default false`, `address_validation*`, `search_blob text GENERATED ALWAYS AS lower(name||email||phone||number) STORED` + GIN trgm index.
Indexes mentioned: status, payment, assigned_to, created_at desc, trgm on search_blob, partial GIN on tags, `idx_orders_cod_queue`, functional indexes on `norm_phone_key(customer_phone)`, `norm_email_key(customer_email)`, `norm_address_key(shipping_address)`, `norm_namezip_key(...)`.

### `order_items`
`id`, `order_id`, `shopify_line_item_id text UNIQUE` (upsert key), `shopify_variant_id text`, `variant_id uuid → product_variants`, `product_title`, `variant_title` (here used to hold shoe size: client-specific), `sku`, `quantity` (= `current_quantity` when > 0), `unit_price`, `total_price`, `unit_cost` (for P/L), `created_at`.
Related: `order_item_backorders` (pending/covered/ready per variant, linked to PO), `order_discounts (order_id, discount_id?, code, discount_type, value, amount_applied)`.

### `order_events` (timeline)
`id`, `order_id`, `event_type text` (free vocabulary: `shopify_import`, `shopify_update`, `ordine_creato`, `ordine_modificato`, `ordine_confermato`, `ordine_annullato`, `ordine_sostituito`, `tag_sanificato`, `nome_cliente_aggiornato`, `pagamento_ricevuto`, `fulfillment_hold`, `stock_disponibile`, `chiamata`, `assegnazione`, `elogy_push`, `tracking_update`, …), `description text` (Italian, human), `actor_id uuid NULL` (NULL = system), `metadata jsonb` (diff payload; see C.5), `created_at`.

### `order_internal_notes`
`id`, `order_id`, `author_id`, `body text` (≤4000), `mentions uuid[] NOT NULL default '{}'` (GIN index), `created_at`, `updated_at`. Trigger `trg_notify_mentions_internal_note` → `notifications(user_id, type='mention', title, body(preview 140), severity, link_to, metadata{order_id,note_id,author_id})`.

### `contacts` (customers)
`id`, `shopify_customer_id`, `first_name`, `last_name`, `email`, `phone`, `tags text[]`, `accepts_marketing` (from `email_marketing_consent.state|sms_marketing_consent.state == 'subscribed'`, legacy fallback), `total_orders`, `total_spent`, `orders_delivered/returned/refused/cancelled` (COD stats), `delivery_score*`, `spoki_contact_id`, `last_spoki_campaign_at`, `notes`, `shopify_synced_at`, `created_at`, `updated_at`. Customer matching is NOT done via this table but via normalized keys on `orders` (see C.6). Lists read `v_contacts_list`.

### `shopify_webhook_logs` (idempotency / retry queue)
`id`, `topic text`, `shopify_id text`, `payload jsonb` (full, or `{_light:true, …}` after success for high-frequency topics), `processed bool`, `error jsonb|text` (`{message,name,code,details,hint,stack,retried_at}`), `retry_count int`, `created_at`. Retention cron: 2 days (memory `log-retention.md`). Dashboard counts `processed=false` as "failed webhooks".

### `sync_status` (cursors)
`id`, `source text` ('shopify','elogy',…), `object_type text` ('orders','products','customers','inventory','journey_backfill'), `status text` ('syncing','ok','error'), `last_synced_at`, `last_error`, `cursor_data jsonb` = `{next_url, high_water_mark, is_full_sync, query_created_at_min, query_updated_at_min, inventory_full_started_at}`, `updated_at`. Backfill-attribution keeps its state in `app_settings(key='attr_backfill_state')` instead.

### `shopify_reconciliation_runs`
`id`, `month date`, `trigger` ('cron'|'manual'), `status` ('running'|'completed'|'failed'), `candidates`, `fetched`, `updated`, `still_voided`, `not_found`, `unchanged`, `errors jsonb`, `notes`, `started_at`, `completed_at`, `duration_ms`.

### `order_attribution`
`order_id UNIQUE`, `source` ('webhook'|'sync'|'backfill_shopify'|'utm'|'click_id'|'direct'), `utm_source/medium/campaign/content/term`, `lm_pid`, `lm_aid` (client-specific), `gclid`, `landing_site`, `referring_site`, `campaign_id`, `ad_set_id`, `ad_id`, `product_id`, `derived_channel` (trigger-computed), `raw jsonb`, `captured_at`. (Memory also lists journey columns `first_visit_*`, `last_visit_*`, `moments_count`, `customer_order_index`, `journey_fetched_at` — not present in generated types; treat as planned.)

### `logistics_shipments` (one row per order)
`order_id`, `status` (internal bucket), `tracking_number`, `carrier`, `delivered_at`, `source_of_truth`, `estimated_delivery`, `exception_reason/since`, `is_locked`, plus per-source columns: `elogy_status`, `elogy_tracking_status`, `elogy_order_id`, `qapla_status`, `qapla_status_detail`, `qapla_tracking_url`, `qapla_first/last_event_at`, `missing_on_qapla*`, `gls_*` (giacenze). Pattern: each source has its own columns; a trigger recomputes the final `status`.

### Other tables touched
`order_create_failures (stage, error, shopify_status, payload, actor_id)`; `cod_contact_attempts (order_id, operator_id, attempt_number, outcome, channel, notes)` (COD); `notifications`; `profiles (user_id, display_name, email)`; `user_activity_pings / user_activity_daily / customer_care_sessions`.

### Tenant-specific assumptions baked in (must become tenant settings in Keel)
- VAT 22% included in prices; orders created with `taxes_included:true, tax_exempt:true, tax_lines:[]` (memory `order-creation-tax.md`).
- Italy-first phone normalization: `toE164` prepends `+39` to 9-10 digit numbers starting with 3 or 0; `norm_phone_key` strips `39`/`0039`.
- Order number prefix `LM-` / `#LM-` stripped in search and shown in UI (`#LM-{number}`).
- `currency default 'EUR'`, timezone `Europe/Rome` in SQL (`dashboard_summary`, cron timing).
- `payment_method` enum `cod|carta|paypal`; gateway string matching `cod|cash|contrassegno`, `paypal`, else `carta`.
- Tag vocabulary as state (full list in D).
- Address autocomplete restricted to Italy; `province` field required by Shopify IT.
- COD fee line identified by title "Commissione pagamento alla consegna"/SKU `cod-fee`, fallback variant `<variant-id>` at 3.95.
- Sizes: `variant_title` numeric digits used as "size" in duplicate detection.

---

## C. Patterns in detail

### C.1 Webhook ack + queue + retry + idempotency
Source: `supabase/functions/shopify-webhook/index.ts`, memory `tech/webhook-ack-pattern.md`, `tech/cloud-cost-optimizations.md`.

```
on POST /webhook:
  raw = await req.text()                      # never JSON-parse before HMAC
  topic = header X-Shopify-Topic; hmac = header X-Shopify-Hmac-Sha256
  if secret missing -> 500 (fail closed)
  if !HMAC_SHA256_base64(raw, secret) == hmac -> 401
  work = async:
      payload = JSON.parse(raw); ext_id = payload.id; src_updated = payload.updated_at
      # dedup: identical event already processed in last 60 s
      if exists log(ext_id, topic, processed=true, created_at > now-60s, payload.updated_at == src_updated): return
      log = insert webhook_logs(topic, ext_id, payload, processed=false)
      try:
         handler = TOPIC_HANDLERS[topic]; if handler: await handler(payload)
         update log processed=true, error=null, payload = (highFrequencyTopic ? lightStub : payload)
      catch e:
         update log processed=false, error={message,name,code,details,hint,stack[:2000]}
  EdgeRuntime.waitUntil(work)                 # background
  return 200 {ok:true, queued:true}            # ALWAYS, even if work will fail
```
Retry/replay (`handleReplay`, `?action=replay`): authorized by service key, a stored replay key, or a user JWT. Selects `processed=false AND created_at > now-7d AND retry_count < 3` oldest first (or explicit `log_ids`); optional filter to statement-timeout errors only; for each row: skip light payloads (close them as processed), rerun handler, on success mark processed, on failure `retry_count++` and store error with `retried_at`. UI (`WebhookPage`) shows failed rows with `×retry_count`, replay one/all, delete.
Handlers are idempotent upserts keyed by external id (`orders.shopify_id`, `order_items.shopify_line_item_id`, `contacts.shopify_customer_id`), so replays and out-of-order deliveries are safe. Ordering is not enforced; the no-op fingerprint and `current_*` fields make last-write-wins acceptable.
Keel mapping: pg-boss job per event, `webhook_events(tenant_id, source, topic, external_id, source_updated_at, payload, status, attempts, last_error)` with unique `(tenant_id, source, topic, external_id, source_updated_at)` instead of the 60 s heuristic.

### C.2 Nightly / monthly reconciliation
Source: `shopify-monthly-reconcile/index.ts`, `shopify-resync-by-ids/index.ts`.

```
reconcile(range [from,to)):
  run = insert reconciliation_runs(status='running')
  candidates = DB orders with external id created in range, paged 1000, hard cap 50k
  for chunk of 250 candidates:
     remote = GET /orders.json?ids=…&status=any&limit=250&fields=id,name,financial_status,fulfillment_status,cancelled_at,closed_at,tags,total_price,current_total_price
     retry up to 6 times on 429/5xx with min(15s, retryAfter + attempt*0.5s); sleep 600 ms between batches
     for each candidate c:
        o = remote[c.external_id]; if !o: not_found++; continue
        new = {status: derive(o), tags, financial, fulfillment, cancelled_at, total: current_total ?? total ?? c.total}
        new = applyLocalCancellationGuard(c, new)      # protect local terminal states
        if same(status, financial, sorted tags): unchanged++; continue
        updates.push(new)
  apply updates in parallel slices of 50
  update run (counters, errors, duration, status completed/failed)
```
Notes: `closed_at` is explicitly NOT treated as cancelled (archived fulfilled orders). Line items are never touched by reconciliation. `shopify-resync-by-ids` is the ad-hoc variant with modes and `dry=1`.
Keel: nightly job per tenant over the last N days (configurable), same guard, result row for the integrations-health page.

### C.3 Resumable sync / backfill with cursor
Source: `shopify-sync/index.ts` (`syncSingleType`, cursor helpers), `shopify-backfill-attribution/index.ts`, `shopify-backfill-items`, `shopify-backfill-phones`.

Delta sync (orders):
```
cursor = sync_status[source,'orders'].cursor_data
created_at_min = since ?? now-30d
hwm = cursor.high_water_mark ?? max(orders.shopify_synced_at|updated_at|created_at)
resume = cursor.next_url && cursor.query_created_at_min == created_at_min (and updated_at_min stored)
updated_at_min = resume ? cursor.query_updated_at_min : (since||full ? none : hwm - 2min overlap)
url = resume ? cursor.next_url : /orders.json?limit=250&status=any&created_at_min&updated_at_min
first page: if empty and !resume -> status ok, return (early exit)
loop while url && timeBudget>3s:
   page = fetch(url) (min 650 ms between calls, 429 -> sleep Retry-After>=2s and retry)
   maxUpdated = max(maxUpdated, page[*].updated_at)
   batchUpsertOrders(page)          # lineage + cancellation guard, chunked, then items upsert-then-cleanup
   save cursor {next_url, high_water_mark: maxUpdated, query_created_at_min, query_updated_at_min}
   url = Link rel=next
if finished: save cursor {next_url:null, hwm, query_*:null}
else: "paused, resume next round"
```
Secondary types: pick any type with pending `next_url` first; otherwise the one synced longest ago (>10 min). 25 s wall-clock budget per invocation (edge CPU limits).
Backfill variant (attribution): state `{created_at_min, next_url, processed, written, not_in_db, errors, pages, done}` in a settings row; 1 page per invocation; after each page it persists `next_url` and **self-invokes** via HTTP to continue; on fetch error waits 5 s then self-invokes; `stop` sets `done`. Items/phones backfills: loop while budget; candidates via RPC; stop when a round updates 0 rows (prevents tight loops when the source has no data).
Keel: `sync_runs(tenant_id, integration, object, cursor jsonb, hwm, status)`; pg-boss job re-enqueues itself with the cursor until `next_url` is null; same overlap and early-exit.

### C.4 Order state derivation (tags + financial + fulfillment + delivery)
Source: `src/lib/orderState.ts`, `_shared/orderStatus.ts`, SQL `derive_order_workflow_from_tags`, `pl_order_workflow_status(7 args)`, `customer_order_bucket_detail`, memory `features/order-status-derivation.md`, `pl-workflow-status.md`.

Four implementations exist and must agree:
1. **Client list/detail** `deriveOrderState(input)`:
```
workflow = (cancelled_at || status=='annullato') ? 'annullato' : deriveWorkflowFromTags(tags)
   deriveWorkflowFromTags: tags lower/trim
      any tag in CANCELLED_SET or startsWith 'annullato'       -> 'annullato'
      'attesa stock' present                                   -> 'da_confermare'   (awaiting stock beats confirmation)
      any tag in CONFIRMED_SET or startsWith {'già pagato','gia pagato',"gia' pagato",'variazione','elogyv2','vendita'} -> 'confermato'
      else                                                     -> 'da_confermare'  (includes "no tags")
fulfillment = fulfilled->'evaso' | partial->'parziale' | else 'non_evaso'
delivery = returnedTag ? 'rientrato'
         : orders.delivery_status valid ? that
         : deriveDelivery(shipment, fulfillment):   delivered_at->consegnato; qapla/status contains delivered->consegnato; out_for_delivery->in_consegna; return->rientrato; exception|error|failed->eccezione; transit|picked|shipped->in_transito; else non_evaso?non_disponibile:in_transito
primary = workflow=='annullato' ? 'annullato'
        : delivery=='rientrato' ? 'rientrato'
        : delivery=='consegnato' ? 'consegnato'
        : fulfillment!='non_evaso' ? 'spedito'
        : workflow
```
2. **Edge (webhook/sync/reconcile)** `deriveOrderStatusFromShopify(p)` → `orders.status`: `cancelled_at || financial_status=='voided'` → annullato; `attesa stock` → nuovo; confirmed tag/prefix → confermato; else nuovo. (`closed_at` ignored.)
3. **SQL for dashboard** `derive_order_workflow_from_tags(text[])` = rule 1 without cancelled_at (IMMUTABLE, tags only).
4. **SQL for P/L, COD queue, history** `pl_order_workflow_status(status, tags, cancelled_at, financial_status, fulfillment_status, delivery_status, delivered_at)`:
```
annullato  if cancelled_at OR status in (annullato,sostituito) OR financial in (voided,refunded) OR tag like 'annullato%' OR tag like 'rientrat%' OR 'da annullare'
consegnato if delivered_at OR delivery_status='consegnato'
confermato if status='confermato' OR fulfillment='fulfilled' OR confirmed tags (incl. 'pagato%','consegnato%','vendita%')
else da_confermare
```
Aggregation exclusions (shared by dashboard and P/L): `status='sostituito'`; tag "Annullato per variazione" (`is_excluded_from_counts`); and `total=0 AND financial='paid' AND tag 'già pagato'` (free replacements). Invariant: `total = confirmed + to_confirm + cancelled`.
Lessons for Keel: (a) one derivation function in `packages/core`, evaluated against per-tenant `state_rules` (conditions on tags, payment method, financial status, fulfillment status, priority) and reused by SQL via a materialized `canonical_status` column updated on write rather than four hand-synced copies; (b) `cancelled_at`/`voided`/`refunded` are hard overrides above any rule; (c) "awaiting stock" style holds must outrank confirmation; (d) delivery and fulfillment are separate dimensions with an explicit precedence for the primary badge; (e) replaced orders are a terminal state excluded from KPIs.

### C.5 Timeline diff computation
Source: `shopify-webhook/index.ts` ~420-460, `shopify-order-actions/index.ts` ~1379-1445, renderer `OrderTimeline.tsx`.

Webhook update diff (existing row vs mapped incoming row):
```
changes = {}
for k in [status, financial_status, fulfillment_status, cancelled_at]: if str(old[k]??'') != str(new[k]??''): changes[k] = {from, to}
if num(old.total) != num(new.total): changes.total = {from,to}
if !tagsEqual (sorted compare): changes.tags = {added: new−old, removed: old−new}
for k in [customer_name, customer_phone]: fromTo
for f in [address1,address2,city,province,zip,country]: if old.addr[f]!=new.addr[f]: changes.shipping_address[f]={from,to}
insert order_events(type = isNew ? 'shopify_import':'shopify_update', metadata = {shopify_id, source:'webhook', ...changes}, actor_id = NULL)
```
Because the no-op skip runs first, every `shopify_update` event has ≥1 changed field.
Operator edit diff: snapshot `order_items` before; after applying: name/phone from→to; address per field (trimmed); `notes {from,to,mode}`; line items keyed by variant id: `added` (new not in prev), `removed` (prev not in new), `updated` (qty differs, `{title, from, to}`); `tag_added`; `backorder` list. Description is built from which sections changed. `actor_id` = caller.
Rendering: label map per field; `FromTo` with strikethrough old value; `+`/`−` rows for tags/items; "(accodate)" badge when note appended; actor name resolved from profiles; "Sistema" only for whitelisted system event types without actor.
Keel: generic `OrderEvent.diff jsonb` with the same shape (`{field:{from,to}}`, arrays as `{added,removed,updated}`), produced by a pure `diffOrder(prev, next)` in `packages/core`, author = user|system.

### C.6 Customer history multi-field match chain
Source: `get_customer_order_history` (`20260915100905_*.sql`, bucket upgrade in `drizzle/migrations/0026/0030/0031`), key functions `20260907105050_*.sql`, memory `features/customer-order-history.md`, docs 03 §Storico cliente.

Normalized IMMUTABLE keys (indexed on `orders`):
- `norm_phone_key(p)`: digits only; NULL if `<6` digits or all same digit; strip leading `0039` (if ≥13) or `39` (if ≥11). *(Keel: generalize to libphonenumber E.164 then compare national significant number.)*
- `norm_email_key`: `lower(trim)`, NULL if empty.
- `norm_name_key`: lower, trim, collapse whitespace.
- `norm_address_key(jsonb)`: `address1|zip|city` lowered/collapsed; NULL if `len(address1)<5` or zip empty.
- `norm_namezip_key(name, addr)`: `name|zip`; NULL if either missing.

Algorithm:
```
inputs: order_id?, platform_customer_id, email, phone, name, shipping_address, limit(≤200)
seed keys: scid, email, phones = {norm(phone), norm(shipping.phone)}, addr, namezip
identified = any seed key non-null; if not -> {identified:false}
STRONG = orders matching scid | email | phone (customer or shipping) | addr    (excluding current order)
WEAK   = orders matching namezip, not in STRONG                                 (never expanded)
hop = 0
loop (max 3 hops, stop if |STRONG| > 300):
   collect key sets from STRONG ∪ {current}: scids, emails, phones (both fields), addrs, namezips (+ seed keys)
   NEW = orders matching any collected key, not current, not in STRONG
   if NEW empty: break
   STRONG += NEW
WEAK -= STRONG
result per order: matched_via = first of [scid, email, phone, address, name] that matches the SEED keys, else 'linked' (reached only transitively)
aggregates: totalCount, totalSpent (excluding voided/refunded), matchedByAll (list of criteria that hit), hops
bucket per order via customer_order_bucket_detail (priority): rientrato > sostituito > annullato(_cliente|_mancanti) > consegnato (delivered_at | delivery_status | paid tags) > shipped→(live shipment or shipped ≤30d ? in_transito : consegnato) > confermato > da_confermare
stats: counts+amounts per bucket; current order returned separately (in stats, not in list)
```
Design rationale recorded: name-only matching produced 123/128 false homonyms, so the weak key requires name+zip and is not expanded; transitive closure makes history symmetric (A↔B by id, A↔C by address ⇒ opening B shows C). UI badges: "collegato" for linked, amber warning for name match; "Primo ordine di questo cliente" when identified but 0 others.
Keel: same strategy on canonical `customers`/`orders` with `tenant_id` in every key index; expose `matched_via` and `hops`.

### C.7 Duplicate order detection
Source: `get_duplicate_sibling_orders` (`20260703123126_*.sql`), `DuplicateSiblingsBanner.tsx`, merge dialog.
```
self = order; phoneDigits = digits(customer_phone) if len ≥ 9
exclude: self, self.replaces_order_id, self.replaced_by_order_id
candidates = orders where created_at in [self.created_at − 5d, self.created_at + 5d]
             AND status != cancelled AND cancelled_at IS NULL AND financial NOT IN (voided, refunded)
             AND NOT tag 'annullato per variazione'
             AND (same platform_customer_id OR lower(email) equal OR digits(phone) == phoneDigits)
self_items = own items excluding service lines (fee/insurance/mystery-box regex)
for each candidate: join its items (also excluding service lines):
   same_variant = any (variant_id equal) OR (sku equal) OR (title equal AND numeric part of variant_title equal)
   same_product = any (lower(trim(title)) equal)
return candidates with same_product, match_type = same_variant ? 'same_variant' : 'same_product', ordered by order number desc
```
Window ±5 days, symmetric. Triggers on `orders`/`order_items` refresh the duplicate factor of the order and its siblings (for the COD score). UI shows amber banner with links and suggests merging. Keel: `findDuplicateOrders(order, window=5d)` in core (window and "service line" matcher configurable per tenant), detection generic; merge action optional.

### C.8 Attribution from UTMs / click ids (customer journey)
Source: `_shared/orderAttribution.ts`, trigger `compute_order_channel`, memory `features/marketing-attribution.md`, `shopify-customer-journey.md`, docs 03 (lineage UTM copy rules).
```
extract(payload):
   params = query params of landing_site (relative paths allowed) filtered to utm_* ∪ click-id set
   if none: params from referring_site
   note_attributes: key normalized (lower, spaces/dashes→_, strip non [a-z0-9_]) so "UTM source" → utm_source; tracked keys override
capture(order, payload, source):
   if no params and no landing/referring: return no_signal (idempotent, never writes)
   expectedPlatform: utm_source in {fb,facebook,meta,ig,instagram}→meta; {google,google_ads,googleads,adwords}→google; else fbclid→meta, gclid→google
   campaign: campaigns.external_id == utm_campaign (prefer expected platform) → else exact normalized-name match (unique) → else primary campaign linked to the bought product on that platform
   ad/ad_set: ads.external_id == utm_content (prefer platform)
   product: lm_pid (numeric = platform product id) → else campaign primary product link
   upsert order_attribution on order_id (source = webhook|sync|backfill_shopify; or utm|click_id|direct)
derived_channel (DB trigger, priority): utm_source aliases/substrings (+utm_medium organic/paid) → click id in landing URL (fbclid, gclid/gbraid/wbraid, ttclid, msclkid) → referrer host → 'direct' if landing present else 'unknown'
```
Three capture levels (webhook live, periodic sync, 180-day backfill) all upsert the same row. When an order is recreated, UTM note attributes are copied to the new order but click ids are renamed `orig_*` so Pixel/CAPI does not count a second conversion. Memory documents a richer "customer journey" source (`customerJourneySummary` GraphQL, last-visit source wins over first-visit) that is not present in the code; treat `source_name/app_id` as "creating app", never as channel.

### C.9 Multi-source shipment status (as seen from the orders side)
Source: `shopify-webhook/index.ts` `applyShipmentUpdate`, memory `features/logistics-qapla.md`, `logistics-elogy.md`, `giacenze-gls.md`.
Each source writes its own columns on the single `logistics_shipments` row (`status` from Shopify fulfillments; `elogy_status`; `qapla_status`; `gls_*`), with `source_of_truth`. Shopify fills only empty fields and only upgrades `pending/unknown`. A DB trigger recomputes final status: most recent event ≤24h wins (Qapla' over Elogy), exceptions are sticky, conflicts logged as `source_conflict`; `orders.delivery_status` is the denormalized result consumed by list filters and `deriveOrderState`. Keel: `Shipment.sources jsonb` or per-source child rows + `resolveShipmentStatus(sources, precedence)` pure function.

### C.10 List performance patterns (240k rows)
- Generated `search_blob` column + GIN trigram; single ILIKE instead of 4 ORs; order-number input detected by regex and routed to an exact `eq`.
- `count: 'estimated'` and page size 50; query retried 3× with exponential backoff; explicit error state with "Riprova".
- Lists read from a view that evaluates the RLS gate once (`security_invoker=false`) because ILIKE/`&&` are not leakproof and RLS forces per-row function evaluation; writes and detail stay on the table. Policies call `has_role()` as `(select …)`.
- After `ADD COLUMN`, views with `SELECT *` must be recreated (documented footgun).
Keel equivalent: tenant-scoped indexes `(tenant_id, …)`, RLS policy on `tenant_id = current_setting(...)` is leakproof-friendly (simple equality), still use a search column + trigram and estimated counts.

### C.11 Dashboard "running" comparisons
`dashboard_summary()` computes windows in the tenant TZ: today = [midnight, now], yesterday = [midnight−1d, now−1d], last week = [midnight−7d, now−7d]; counts/revenue by derived workflow; revenue counts only confirmed; same exclusion set as P/L; recent 8-day CTE for speed; separate targeted queries for global counters. UI re-keys at local midnight. Keel: parametrize TZ from tenant settings, replace COD counters with generic ones (pending review, on hold, exceptions).

### C.12 Operator activity / time tracking (customer care)
Source: `docs/team/04-customer-care.md`, memory `features/order-activity-tracking.md`; tables `user_activity_pings`, `user_activity_daily`, `customer_care_sessions`; RPCs `operator_efficiency_metrics(p_start,p_end)`, `get_user_order_activity`, `get_order_team_time(p_order_id)`.
```
client: every 60 s while tab visible and user not idle (>5 min without mouse/keyboard/scroll/touch) -> insert ping(user_id, at, order_id = uuid in /ordini/:id path else NULL)
logged minutes (any page): group consecutive pings with gap ≤ 2 min into sessions; minutes = Σ sessions
time on orders:            sessions over pings with order_id, split on gap > 5 min or page change; minutes = Σ ((last − first) + 1 min)
orders_viewed    = count distinct order_id in pings
orders_completed = count distinct order_id in order_events where actor_id = user and event_type in (confirmed, cancelled, modified, replaced)
"handled" order  = has ≥1 operator-authored action (event with actor_id and an operational type, or attempt, or internal note); automatic events (assignment, shopify_update, shopify_import) never count
avg handling     = mean(last action − first action) per order with ≥2 actions, capped at 4 h
throughput/h     = (confirmed + cancelled) / active hours
nightly rollup pings -> user_activity_daily for permanent history
```
GENERIC parts: idle-aware ping tracking, "handled" defined by authored events, time-on-entity metric. COD-ONLY parts: confirm rate, attempts per confirmation, call outcomes.

### C.13 Order action conventions worth generalizing
Source: `supabase/functions/shopify-order-actions/index.ts` (actions `cancel`, `confirm`, `update`, `create`, `cancel_and_create`, `merge`, `apply_discount`, `mark_as_paid`, `schedule_confirm`), `orders-apply-scheduled-confirms`, memory `features/order-create-sale.md`.
- One edge endpoint with `action` discriminator; every action resolves `callerId` and writes an `order_events` row with `actor_id` and structured `metadata`; failures that are not fatal to the operator intent (name sync to platform, restock, hold release) are recorded as their own event types (`nome_cliente_shopify_non_aggiornato`, `storno_stock_mancato`, `fulfillment_hold_release`) instead of failing the action.
- Remote-first, then local: mutate the commerce platform first, then upsert the local row by external id (`upsertLocalOrderByShopifyId`) so a webhook arriving mid-flow is idempotent.
- Creation failures are staged: `createStage ∈ {validate, seller_lookup, customer_search, shopify_post, local_insert, post_create}`; each failure row in `order_create_failures(stage, error, shopify_status, payload)`; `local_insert`/`post_create` failures return the platform order number ("order exists upstream, will arrive via webhook") with a distinct error code.
- Capacity before writing: `compute_variant_capacity(variant_ids, exclude_order_id)` → `cap = available + incoming_PO + original_qty_in_this_order`; excess becomes backorder rows; the order is held, and a stock-arrival trigger plus a 10-min safety cron release it (`stock_disponibile` event + in-app notification), confirmation stays manual.
- Scheduled actions: store `scheduled_at` + `scheduled_by`, a daily job applies due ones, failures leave the field set so they retry next run; manual confirm/cancel clear the schedule and log `programmazione_annullata`.
- Bulk operations run with bounded parallelism (3) and return `{ok, failed, firstErrors}` for a single toast; caches for list and KPI are invalidated afterwards.
- Phone normalized to E.164 before any outbound call; platform customer linked by explicit id or search by email/phone so history and segments do not break.

---

## D. Things to explicitly NOT bring into a generic core

- **Tags as the state machine.** All tag vocabularies: `Confermato`, `Momoka confermato`, `Conferma WhatsApp`, `Già/Gia/Gia' pagato`, `PAGATO`, `Variazione`, `ElogyV2`, `Vendita <Nome>`, `Carta da confermare`, `Pronto da spedire`, `Attesa stock`, `Da chiamare`, `Da lavorare`, `Richiesta modifica`, `Da confermare`, `Richiamare`, `Potenziale Double Type`, `Annullato dal cliente`, `Annullato per variazione`, `Annullato mancanti`, `Da annullare`, `Eliminato su Shopify`, `Bozza`, `Rientrato*`, `Reso al mittente`, `Spedire | non risponde`, `Unito con #X`, `Unificato in #Y`, `Unione`. In Keel these become tenant `state_rules` inputs at most; the canonical state is a column.
- **Shopify Flow / Elogy workarounds**: variation lock (`variation_lock_active`, `filterVariationLockTags`, `tag_sanificato` events), "replace all tags with `Confermato`" on confirm, `CANCEL_REMOVE_TAGS` to stop Elogy importing cancelled orders, "never add Confermato to shipped orders because Elogy re-imports".
- **Releasit / funnel COD app quirks**: `ORDER_NOT_EDITABLE` detection strings, `source_name` used to recognise Releasit, forced cancel-and-recreate for product edits (`LINE_ITEMS_UPDATE_FORBIDDEN`), fulfillment-hold API version hacks.
- **COD specifics** (go to `addon.cod` only): confirmation queue (`is_cod_queue_order`, `cod_queue_page/metrics`, `cod_contact_attempts`), auto-assignment (`auto_assign_cod_order`, `claim_cod_order`), scheduled confirms, delivery score, recipient risk, COD fee auto line (`cod-fee.ts`, variant `<variant-id>`, 3.95), "Carta da confermare → Già pagato" swap, mark-as-paid tag reset, "Spedire | …" tags, operator KPIs defined as confirm rate.
- **Italy / Lorena constants**: `+39` normalization, `0039` stripping, `Europe/Rome`, `EUR`, 22% VAT-included (`tax_exempt/taxes_included` trick), `LM-` prefix, Google Places restricted to IT, province requirement, shoe-size heuristics (`variant_title` digits, `size_num`), product code derived from SKU pattern `Name-CODE-Size`, Italian event descriptions and UI strings.
- **Vendor integrations**: Elogy, Qapla', GLS giacenze, Spoki (WhatsApp), Momoka; `elogy_id`, `spoki_*` columns, `elogy-push-order` on confirm.
- **Supabase-specific mechanics**: `EdgeRuntime.waitUntil`, 25 s wall budgets, self-invoking HTTP continuation, `security_invoker=false` views, `GRANT` smoke tests, `app_settings` as job state store, estimated counts hack. Keep the ideas (budgeted resumable jobs) but implement with pg-boss.
- **Replacement of `orders.status` by derived logic in four places**; Keel must have one canonical column + one pure function + rules preview.
- Address autocomplete/map fallbacks, release_items auto-insertion, Lovable memory conventions.

---

## E. Pure utility functions worth reusing (rewrite, keep semantics)

| Name | Path | What it does |
|---|---|---|
| `applyLocalCancellationGuard(existing, row)` | `supabase/functions/_shared/orderStatus.ts` | Enforces the three terminal-state invariants (replaced is final; cancelled+replaced_by ⇒ replaced; cancelled+zeroed never regains total / voided never reverts to pending). Mirrors DB trigger `orders_guard_cancelled_state`. |
| `deriveOrderStatusFromShopify(p)` / `normalizeTags` | same | Status from `cancelled_at`, `financial_status`, tags; `closed_at` ignored. Keep the structure, swap tag sets for rules. |
| `deriveOrderState`, `deriveFulfillment`, `deriveDelivery`, `derivePrimaryStatus` | `src/lib/orderState.ts` | Three-dimension state model + precedence; tested in `src/test/orderStateCancelled.test.ts`. |
| `buildCustomerNameUpdate(first, last, orders)`, `splitCustomerName(full)` | `supabase/functions/_shared/customerNameSync.ts` (+ `src/test/customerNameSync.test.ts`) | Diff of orders needing a name update, capped event ids (10 most recent); never blanks. |
| `extractOrderDiscounts(payload)` | `supabase/functions/_shared/orderDiscounts.ts` | Normalizes Shopify `discount_codes` + `discount_applications` (+ automatic discounts, `current_total_discounts`) into `[{code, amount, type, percentage?, title?}]`. |
| `extractAttributionParams(payload)`, `normalizeAttributionKey`, `parseUtmFromUrl` | `supabase/functions/_shared/orderAttribution.ts` | UTM/click-id extraction from landing URL, referrer and note attributes with key normalization. |
| `compute_order_channel(order_attribution)` | SQL, `supabase/migrations/20260703135317_*.sql` | Channel classification priority (utm_source aliases → utm_medium → click ids in URL → referrer host → direct/unknown); port as a TS function with a config table. |
| `mutateShopifyTags(orderId, add, remove)` | `supabase/functions/_shared/shopifyAdmin.ts` | Read-modify-write of tags with case-insensitive dedupe, PUT only if changed. (Shopify adapter helper.) |
| `shopifyGraphql(query, vars)` | same | GraphQL POST with throttle-aware retry: computes wait from `extensions.cost.throttleStatus` (deficit / restoreRate), max 3 retries, surfaces `userErrors` to caller. |
| `chunk(arr, size)` | same | Trivial chunker. |
| `withSafetyOverlap(ts, 120000)`, `trackMaxUpdatedAt(records, max)` | `supabase/functions/shopify-sync/index.ts` | HWM overlap and max-updated tracking for delta sync. |
| Link-header pagination parser (`/<([^>]+)>;\s*rel="next"/`) and 429 `Retry-After` retry | `shopify-sync/index.ts` `shopifyFetchWithPagination`, `shopify-backfill-*` | REST cursor pagination + rate-limit handling. |
| `pickBestFulfillment(fulfillments)`, `mapShopifyShipmentStatus(s)` | `supabase/functions/shopify-webhook/index.ts` | Choose delivered-or-latest fulfillment; map Shopify `shipment_status` to internal buckets. |
| `extractMarketingConsent(customer)` | `shopify-webhook/index.ts`, `shopify-sync/index.ts` | `email_marketing_consent.state|sms_marketing_consent.state == 'subscribed'` with legacy `accepts_marketing` fallback. |
| `tagsEqual(a,b)` | `shopify-webhook/index.ts` | Order-insensitive array equality. |
| Line-item fingerprint (`current_quantity` filter, cancelled-order exception, sort by id, JSON compare) | `shopify-webhook/index.ts` lines ~297-339 | Detects item changes for the no-op skip. |
| `norm_phone_key`, `norm_email_key`, `norm_name_key`, `norm_address_key`, `norm_namezip_key` | SQL, `supabase/migrations/20260907105050_*.sql` | Immutable match keys for customer identity (phone one must be generalized with libphonenumber). |
| `detectMentionTrigger(text, caret)` | `src/components/orders/InternalNotesCard.tsx` | `@query` detection before caret for mention autocomplete. |
| `notify_mentioned_users_on_internal_note()` | SQL trigger, `20260511193401_*.sql` | Fan-out notifications to mentioned users excluding author. |
| `stripOrderPrefix` / `looksLikeOrderNumber` / `expandWorkflowTags` | `src/lib/ordersFilterQuery.ts` | Search input classification and workflow-group → tag expansion (prefix must come from tenant settings). |
| `chooseCustomerOrderBucket`, `chooseShippedDetail`, `bucketFromDetail` | `src/lib/customerOrderHistory.ts` (+ `customerOrderHistory.test.ts`) | Client mirror of history bucket priority incl. 30-day "shipped ⇒ delivered" assumption. |
| `computeBackorderItems(lineItems)`, `totalBackorderUnits` | `src/lib/backorder.ts` (+ `backorder.test.ts`) | Backorder qty = requested − on-hand per line (after removing fee lines). |
| `toE164(raw)` | `supabase/functions/shopify-order-actions/index.ts` line 174 | Italy-first E.164; reuse only the shape, replace with libphonenumber + tenant default country. |
| `isCodFeeLineItem`, `ensureCodFee` | `src/lib/cod-fee.ts` | COD fee line detection/injection — addon.cod only. |
| `get_duplicate_sibling_orders(order_id)` | SQL, `20260703123126_*.sql` | Duplicate detection (see C.7). |
| `get_customer_order_history(...)` | SQL, `20260915100905_*.sql` + `drizzle/migrations/0031` | Transitive customer history (see C.6). |
| `pl_order_workflow_status(7 args)`, `derive_order_workflow_from_tags`, `is_excluded_from_counts`, `is_order_shipped` | SQL, `drizzle/migrations/0017/0018`, `20260907110039`, `20260526080040` | Aggregation-side state helpers; port as core functions over canonical columns. |

---

## Summary of the most important takeaways for Keel

1. Webhooks: verify → log → ack → process async; event log doubles as idempotency key and replay queue; handlers are idempotent upserts with a significant-field fingerprint and non-destructive child-row sync.
2. Sync: delta by `updated_at_min` with overlap, cursor persisted per page, budgeted and resumable; nightly/monthly reconciliation by id-batches with a local-terminal-state guard; backfills as budgeted self-continuing loops that stop when nothing changes.
3. State: the reference derives state from tags in four hand-synced places — the single biggest design flaw to avoid. Keep the valuable parts: hard overrides (cancelled/voided/refunded), hold-beats-confirmation, orthogonal fulfillment/delivery dimensions with explicit precedence, replaced-as-terminal, and shared exclusion rules between dashboard and P/L.
4. Timeline: every write emits an event with author and a structured `{from,to}` / `{added,removed,updated}` diff; the renderer is generic.
5. Customer history: normalized keys + bounded transitive closure, weak name match only with zip, `matched_via` surfaced to the operator.
6. Duplicates: same customer, ±5 days, open, shared product/variant; bidirectional banner; optional merge.
7. Lineage: `replaces/replaced_by/root` fields, inherit creation day and assignment for metrics, copy UTMs but neutralize click ids.
8. Attribution: capture raw signals from landing/referrer/note attributes at three levels, resolve campaign by external id → name → product link, derive channel by a priority table.
9. Everything COD (queue, assignment, score, fee, scheduled confirm) and everything Italy/Lorena/Elogy/Releasit/Flow stays out of the core.
