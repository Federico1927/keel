# Study: REHAUS Ops Studio — what a generic Shopify back-office SaaS can reuse

Source: `/home/user/rehaus-ops-studio-533b1b8f` (read-only). Stack: React 18 + TS + Vite + Tailwind/shadcn + TanStack Query; Supabase (Postgres 15 + RLS on all 147 tables, 384 SQL functions, 183 triggers, 156 Deno edge functions, pg_cron + pg_net, Storage, Vault). Single-tenant, single Shopify store, GBP-only, UK consignment business.

Reading order followed: `README.md`, `docs/technical/00…11`, `KNOWN-ISSUES.md`, `docs/architecture.md`, `docs/app-flow-pages-and-roles.md`, `docs/design-guidelines.md`, `docs/audits/2026-06-rls.md`, `.lovable/memory/logic/*.md`; then `src/pages`, `src/components`, `src/hooks`, `src/lib` (+ tests), `src/data`, `src/contexts`, `supabase/functions` (+ `_shared`), and `supabase/migrations` (974 files) for the key SQL.

Important caveat for the reader: the project is **not multi-tenant** (one Supabase project, one store, one currency, hard-coded UK fee SKUs, a hard-coded owner e-mail in `is_super_deleter()`). Every pattern below must be re-keyed on `tenant_id` and re-expressed against Keel's canonical model; nothing should be copied as-is except the pure utilities in section E.

Classification legend: **GENERIC** = reusable in a Shopify e-commerce SaaS core; **PATTERN-ONLY** = the business is consignment-specific but the mechanism is reusable (the reusable part is named); **CLIENT-SPECIFIC** = discard.

---

## A. Feature inventory

| Feature / module | Where (paths) | What it does | Classification | Logic worth reusing |
|---|---|---|---|---|
| App shell (sidebar + topbar + mobile bottom nav + right tasks drawer) | `src/components/AppLayout.tsx`, `components/layout/{SidebarNav,TopBar,BottomNav,nav-config}.ts(x)`, `hooks/useSidebarState.ts`, `contexts/TasksPanelContext.tsx` | One ops shell; nav tree declared once in `nav-config.ts` with a `page: PageKey` per item; items hidden when `!canRead(page)`; tablet ≤1023px treated as mobile (sheet nav + bottom nav). | GENERIC | Declarative nav config keyed by permission page; parent visible if any child readable. |
| Route guard | `src/components/ProtectedRoute.tsx`, `App.tsx` (`lazyWithRetry`, legacy redirects, `ErrorBoundary` per route) | Single guard: loading spinner → pending magic-link tokens → session → forced password change → first-access password gate → portal locks → **fail-closed on zero roles** → PageKey lookup from `ROUTE_TO_PAGE`. Pages are lazy with retry + stale-chunk self-heal. | GENERIC | Decision order; fail-closed "Account not set up"; `lazyWithRetry` + `stale-module-recovery.ts`. Fix the known bug (only first path segment matched) by longest-prefix lookup. |
| Role × page permission matrix | `src/hooks/usePermissions.ts`, SQL `has_page_access()` (`migrations/20260727193749_*.sql`), `_shared/cron-auth.ts` (`gateUserPageAccess`), `components/admin/PermissionsPanel.tsx` | `admin_settings.role_permissions = { role: { pageKey: none/read/write } }`. Same JSON read by UI hook (5-min cache), by SQL `has_page_access(uid, page, level)` (RLS, RPCs) and by edge functions. Highest level across a user's roles wins; `LEGACY_KEY_MAP` for renamed keys; `PAGE_GROUPS` drives the editor UI. | GENERIC | The one-matrix-three-consumers design, `PAGE_GROUPS`→`ROUTE_TO_PAGE`→`DEFAULT_PERMISSIONS` triad, legacy-key aliasing. Store per tenant in Keel. |
| Role registry + custom roles | `role_registry` table, `add_app_role()`, `hooks/useRoleRegistry.ts`, `components/admin/RoleRegistryPanel.tsx` | Display metadata per role (label, scope internal/portal, colour token, order, built_in protected from delete by trigger). | GENERIC | Registry table + built-in protection trigger + static fallback list in the hook. Avoid the `ALTER TYPE ADD VALUE` approach (irreversible enum growth); use a text role + registry FK. |
| Multi-audience auth (staff + 3 external portals) | `contexts/AuthContext.tsx`, `pages/{Login,SellerLogin,BrandLogin,PartnerLogin}.tsx`, `_shared/portal-token.ts`, `portal-*-token`, `resolve-auth-user.ts` | One SPA serves ops + seller/brand/logistic-partner portals. HMAC deep links (`base64url(payload).base64url(sig)`, `v` discriminator, TTL 1–90 days) exchanged for Supabase magic links; first-access password gate; `findAuthUserByEmail` to avoid `generateLink` auto-creating users. | PATTERN-ONLY (portals are seller/brand-specific; the external-user-type mechanism is generic, e.g. a 3PL partner or super-admin impersonation) | Portal lock in the guard; `v`-tagged HMAC tokens; "never use generateLink as an existence probe" guard test; `loading` stays true until roles resolve (BB-4). |
| Client-side role impersonation (RoleSwitcher) | `components/layout/RoleSwitcher.tsx`, `AuthContext.setImpersonatedRole` | Founder/admin previews UI as another internal role (client only; RLS still sees the real user). | GENERIC (as "preview role"), insufficient for super-admin tenant impersonation | Keep `realRoles` vs effective roles split; persist in localStorage; auto-clear on sign-out. Keel's super-admin impersonation must be server-side with audit (Keel §8.2). |
| Orders list/detail | `src/data/orders.ts`, `pages/Orders.tsx`, `pages/OrderDetail.tsx`, `lib/order-aggregates.ts` | Server-side filtered + paginated list (`useOrders`): status `.in`, search across order name / customer name / resolved contact ids, date, amount range, `.range()`; explicit column list to avoid pulling `shopify_data`. Detail computes gross subtotal, fees, refunds in pence. | GENERIC | The data-layer hook shape (filters object → one query key → `{rows,count}`), explicit column list, contact-name search by pre-resolving ids. |
| Order ingestion (webhook + poll) | `supabase/functions/shopify-webhook-handler/index.ts`, `shopify-sync-orders/index.ts`, `register-shopify-webhooks/index.ts` | HMAC-SHA256 verified webhooks (timing-safe), log `received`→`success/error` in `shopify_sync_log`, upsert on `shopify_order_id`, auto-create contact stub, backstop fulfilment tasks, auto-revert tasks on full refund. 15-min poll with high-water mark = last successful run − 2 min; `page_url` cursor for resume. | GENERIC | HWM derived from the sync log; `Link: rel=next` cursor; chunked upsert with retry; webhook topics list (`orders/*`, `products/*`, `inventory_levels/update`). **Known bugs to avoid**: webhook always returns 200 (no retry), poll never persists its cursor so it restarts every run, errors swallowed. Keel should do: immediate 200 only after durable enqueue, then process in queue with idempotency key = webhook id. |
| Fulfilment tasks + outbound board | SQL `create_fulfillment_tasks_on_paid()`, `get_outbound_board()`, `pages/Outbound.tsx`, `pages/outbound/useOutboundBoard.ts`, `fulfill-shopify-order/index.ts` | One task per non-fee Shopify line (unique `(order_id, shopify_line_item_id)`); enum `pending→packed→held→shipped→delivered→returned`; order-level derived status computed in SQL by precedence (`returned` > all delivered > all shipped > …); Kanban/list board fed by one RPC; "fulfil" creates Shopify fulfillment per open fulfillment order, maps carriers through a whitelist, only marks local state after Shopify accepts. | GENERIC | Line-level tasks + SQL precedence rollup; batch RPC paging; carrier whitelist → "Other"; write-after-remote-ack. |
| Delivery scheduling with public confirm link | `order_deliveries` table, `buyer-delivery-action`, `send-delivery-notification`, `pages/PublicDeliveryConfirm.tsx`, `lib/time-slots.ts`, `lib/public-delivery.ts` | Per-order delivery row created when first task packed; ops propose slot → buyer confirms/reschedules via `/delivery/:token` (uuid token as bearer); `scheduling_mode rehaus_managed|carrier_managed`; `last_party_activity_at` bumped by trigger → unread markers. | PATTERN-ONLY (own-fleet delivery is niche; token-confirm flow and party-activity markers are generic) | Token page pattern; `last_party_activity_at` + `row_read_markers` for "something new happened on this row". Add token expiry (missing here). |
| Returns & refunds | `return-shopify-order/index.ts` (+ `refund-helpers.ts`), `backfill-order-refunds`, SQL `on_order_voided_delete_settlements` | Modes `return` (calculate → refund via idempotent write, tasks→returned, optional restock → listing back to Published, settlements→Returned) and `refund_only` (money-only, audit row). Validates remaining refundable. | GENERIC | Two-mode refund with `refunds/calculate.json` first; `computeRemainingRefundable`; audit row per refund; downstream money rows flipped by DB trigger on order status. |
| Inventory: per-location levels, clamp, primary warehouse | `listing_inventory_levels`, `warehouses` (`shopify_location_id`, `is_default`, `status`, `successor_warehouse_id`), `_shared/per-location.ts`, `_shared/inventory-clamp.ts`, `shopify-pull-inventory`, `derive_listing_warehouse()` | GraphQL `nodes(ids)` with `quantities(names:[available,on_hand,committed])` per location; clamp negatives to 0 and log a conflict (deduped per product); aggregate `qty/available/reserved` = sums; primary location = max on_hand, tie → default warehouse. | GENERIC | Everything. Fix the tie-break to be deterministic (location id) — live bug flips 407 listings every 15 min. |
| Inventory reconciliation vs Shopify | `reconcile-shopify-inventory/index.ts`, `inventory_reconcile_runs`, `pages/InventoryReconcile.tsx` ("zero stock but no order" review with reasons), `shopify_conflicts` | Full pull-only diff of every linked listing in batches of 250 GIDs; writes only changed columns; upserts per-location rows; deletes stale pairs; logs run summary. UI page lists Published listings with 0 stock and no sale for a human reason (sold off-platform, damaged…). | GENERIC | See §C.3. |
| Safe deletion decision on partial API responses | `shopify-pull-inventory/_deletion-decision.ts` | Never soft-delete on a throttled/partial response: empty node set → skip; missing node → single re-verify; delete only if re-verify says missing. | GENERIC | Verbatim logic. |
| Reservations | SQL `reserve_listing/release_listing/mark_listing_sold/mark_deal_won` (`migrations/20260616145206_*.sql`), `inventory_states`, `check_inventory_conflict`, `auto-release-reservations`, `.lovable/memory/logic/inventory-reservation-rpcs.md` | Atomic conditional `UPDATE … WHERE available >= qty` (raises `insufficient_stock`), delta release, append-only state ledger, latest-row conflict guard, cron expiry. | GENERIC (for holds/backorders/B2B quotes) | See §C.4. |
| Partner holds via Shopify native reserved state | `partner-holds/index.ts`, `partner_holds` | API-key partner reserves 1 unit by `inventoryMoveQuantities` available→reserved for 5–30 min; sweep expires. | PATTERN-ONLY (partner API pilot) | Using Shopify's own `reserved` quantity so storefront shows sold-out without touching on_hand. |
| Stock-take (count-only) | `pages/StockTake.tsx`, `lib/stock-take.ts`, `stock_take_sessions/lines` + freeze trigger | Scanner input → discrepancy report (missing/surplus/unknown/match) per warehouse; never writes stock; lines frozen once session closed. | GENERIC | Pure bucket maths; "report, never mutate" principle. |
| Listings/products catalogue + publish queue | `pages/Products.tsx`, `pages/ProductDetail.tsx`, `components/listings/ListingEditor.tsx`, `src/data/listings.ts`, `push-product-to-shopify`, `shopify-publish-drainer`, `shopify_publish_jobs`, SQL `enqueue_shopify_status_push()`, `_shared/pending-status-guard.ts`, `_shared/shopify-field-mapping.ts`, `shopify_field_mappings` | Writes to Shopify only through a job queue drained every minute: `kind full|status_only`, statuses `queued/running/succeeded/failed/superseded`, max 3 attempts, stuck-running reap at 20 min; a user status flip auto-enqueues a `status_only` job and supersedes older queued jobs; pull writers skip `status` while a job is pending; admin toggles which fields are pushed. | GENERIC | Whole queue design (§C.12), supersede semantics, pending-status guard, configurable field mapping with `target_kind`. |
| Publish gate (required fields) | `lib/shopify-publish-required-fields.ts`, `push-product-to-shopify/required-fields.ts`, `components/products/PrePublishDialog.tsx`, `admin_settings.shopify_publish_required_fields` | Registry of required fields stored as data; client dialog mirrors server 422 `{missing_fields}`; server authoritative. | GENERIC | Data-driven required-field registry with client/server mirror + parity test. |
| Studio-authored field protection | `_shared/studio-authored.ts`, `listings.studio_authored_fields text[]` | Columns a local actor deliberately authored are stripped from pull rows so Shopify sync does not erase them. | GENERIC | Per-row protected-column marker; never protect inventory columns. |
| Shopify write idempotency | `_shared/shopify-idempotency.ts`, `shopify_write_idempotency` | SHA-256 of `operation|entityType|entityId|stableJSON(payload)`; cached 2xx response returned on replay; 429/5xx retry with `Retry-After`. | GENERIC | Verbatim (§C.13). |
| Shopify conflicts | `shopify_conflicts`, `components/admin/ShopifyConflictPanel.tsx`, `components/products/ListingConflictsPanel.tsx` | Field-level disagreement rows with `resolution rehaus|shopify`. Live: write-only (2,383 open). | PATTERN-ONLY | Table shape is fine; needs a resolution workflow or auto-expiry or it becomes noise. |
| Shopify products pull (HWM, protected statuses) | `shopify-sync-products/index.ts` | Incremental by `updated_at_min` = last success − 2 min, per status (active/draft/archived) on different cadences; metafield→column map; protected local statuses; partial update when marker present. | GENERIC | HWM + per-status cadence + metafield map table. |
| Contacts / CRM | `pages/Contacts.tsx`, `pages/ContactDetail.tsx`, `src/data/contacts.ts`, SQL `recalculate_contact_ltv()`, `reclassify_contacts()`, `lib/contact-classification.ts` | Unified contact (buyer/seller flags), LTV & order counts recomputed by trigger excluding fee lines, nightly two-axis classification (`relationship`, `tier`) using p90 GMV thresholds and personal-email-domain heuristics, lock columns to stop auto-reclassification. | GENERIC (buyer side) / PATTERN-ONLY (seller axis) | Trigger-maintained LTV; percentile-based tier assignment; `*_locked_at` manual-override columns; `on_watch`, `suppression_tags`. |
| Global search | `hooks/useGlobalSearch.ts`, `components/GlobalSearchBar.tsx`, `lib/search-tokens.ts` | ≥2 chars, debounce, abort previous, parallel PostgREST queries per entity, tokenised AND-match for multi-column names, escaped terms, `/` shortcut. | GENERIC | Tokeniser + per-token `.or()` chaining; cast enums to text before ilike. |
| Mailbox (shared inbox) | `pages/Mailbox.tsx`, `receive-inbound-email`, `send-email`, `_shared/email-thread-routing.ts`, `inbound_email_log`, `mailbox_read_threads`, `mailbox_unread_count()`, `hooks/useMailboxUnread.ts`, `lib/email-render.ts` | Inbound via Resend webhook (Svix-verified), threads keyed `entity:id`, routing by `[REH-TAG]` subject token / hidden HTML comment / `In-Reply-To` lookup / open-threads fallback; per-user read state; cross-tab `BroadcastChannel`; DOMPurify render with `cid:` rewrite. | GENERIC | Thread routing precedence (§C.14), per-user read-thread table + unread RPC, `renderEmailHtml`. |
| Internal notes + @mentions + channels | `components/mentions/*`, `lib/mention-channels.ts`, `process-mentions/index.ts`, tables `internal_notes`, `mentions`, `notifications` | Notes on any entity (`entity_type` enum + `entity_id`), `@[Name](uuid)` storage format, sentinel UUIDs for group mentions (`@team`, `@finance`), server validates recipients are internal, writes `mentions` + `notifications` (+ opt-in email), entity→link map. | GENERIC | See §C.9. |
| Notifications + preferences | `notifications`, `user_notification_preferences`, SQL `notify_role()`, `apply_notification_preferences()` (BEFORE INSERT), `components/NotificationBell.tsx`, `lib/normalize-notification-link.ts`, `components/admin/NotificationSettingsPanel.tsx` | Role fan-out helper honouring global toggles (`admin_settings.notification_settings`) and per-user prefs; BEFORE INSERT trigger drops opted-out rows; realtime bell; legacy link rewriting + `entity_type/id` fallback link. | GENERIC | `notify_role` + preference trigger + link normaliser (§C.8-bis). |
| Tasks + task automation rules | `staff_tasks`, `task_automation_rules`, `task_automation_subscriptions`, `components/TasksPanel.tsx`, `components/EntityTasksCard.tsx`, `components/admin/TaskAutomationPanel.tsx` | Tasks linked to any entity; rules `trigger_event → title template + delay + priority`, with per-rule subscribers; triggers create tasks on stage/status events; right-hand drawer with `t` shortcut. | GENERIC | Rule table + subscriptions + templated titles with `{{placeholders}}`. |
| Saved views + sticky filters | `hooks/useStickyFilter.ts`, `components/SavedViewsBar.tsx`, `saved_views` | Filters persisted per page in sessionStorage; named views saved server-side per user+scope as JSON bucket. | GENERIC | Verbatim. |
| Dashboard widget grid | `hooks/useDashboardLayout.ts` (`SOURCE_CATALOG` with `requiredPage`), `components/dashboard/*`, `react-grid-layout`, `components/dashboard/AddWidgetDialog.tsx` | Catalogue of widget sources with default size/type and permission gate; role-specific default layouts; per-user layout persisted. | GENERIC | Widget catalogue keyed by permission; metric/list/chart/panel typing. |
| KPI maths | `lib/dashboard-kpis.ts` (funnel, median days, sell-through 30/60/90), `lib/sold-derivation.ts`, `lib/settlement-aggregates.ts`, SQL `intelligence_*`, `rollup_listing_sales()` | Pure functions over rows; sold-status derived from orders + fulfilment tasks with two sets (`SOLD_FOR_UI` ⊇ `SOLD_FOR_PAYOUT`). | GENERIC (shape) | Pure-function-per-KPI + tests; two-tier "sold" definition. **Anti-pattern to avoid**: four different revenue definitions across pages (KNOWN-ISSUES D10) — define one in `packages/core`. |
| Period filter | `components/common/PeriodFilter.tsx` | Presets 7d/30d/90d/12mo/all + custom range; `resolvePeriodRange` half-open ISO window; `periodQueryKey`. | GENERIC | Verbatim. |
| Finance hub, settlements/payouts engine | `pages/Settlements.tsx`, `SettlementDetail.tsx`, SQL `recompute_settlement_on_edit`, `lock_paid_settlement`, `calc_layered_commission_from_tiers`, `lib/settlement-formula.ts`, `lib/commission-calc.ts`, `.lovable/memory/logic/*.md` | Seller payout state machine, formula in DB trigger mirrored in TS, commission tiers frozen per row, money columns immutable after approval with audited unlock/void-and-replace RPCs. | PATTERN-ONLY (consignment payouts) | Reusable for Keel's **P/L per order** and any "computed money row": formula in one place with TS mirror + parity test; integer pence; snapshot of rates/fees at creation (`locked_commission_tiers` ≈ Keel's `CostSetting` snapshot per order); lock + GUC bypass + audit for approved rows; `trigger_event` provenance breadcrumb. |
| Xero accounting | `xero-*` functions, `_shared/xero-*.ts`, `xero_outbox`, `claim_xero_outbox_batch` | OAuth tokens in Vault, outbox with `FOR UPDATE SKIP LOCKED` claim, backoff + dead-letter, hash idempotency on journals, singleton heartbeat lock. | PATTERN-ONLY | Outbox/dispatcher skeleton (§C.11) is directly reusable for any outbound integration (Meta pause, Shopify writes, 3PL). |
| Outbound partner webhooks | `webhook_subscriptions/outbox/delivery_logs`, SQL `dispatch_webhook_event`, `claim_webhook_outbox`, `webhook-drainer/index.ts` | Row triggers emit events to active subscriptions; drainer with advisory lock, `SKIP LOCKED` claim, HMAC signature headers, `delivery_id` in body, backoff 10s→2h, max attempts → failed. | GENERIC | Verbatim design (§C.11). Good basis for Keel's integration/MCP event layer. |
| Partner REST API + API keys | `api-gateway/index.ts`, `api_keys` (SHA-256 `key_hash`, `key_prefix`, `scopes[]`, `revoked_at`, `request_count`), `api_request_logs`, `pages/ApiKeys.tsx`, `pages/ApiDocs.tsx`, `components/admin/IntegrationsPanel.tsx` | Bearer `rh_live_…`, hash lookup, scope `resource:read|write|*`, partner-safe column projection + decoration, offset pagination with `total_count`, `updated_since` cursor, per-request log. | GENERIC | See §C.7. Replace in-memory rate limit with the DB one; add `expires_at`; move to per-tenant keys. |
| Rate limiting for public endpoints | SQL `record_and_count_rate_hit()`, `rate_limit_hits`, `_shared/client-ip.ts`, `_shared/cron-auth.ts:requireRateLimit` | Insert-and-count within window per `(bucket, ip)`; real IP = `cf-connecting-ip` else **last** XFF token. | GENERIC | Verbatim; make the helper fail closed for public forms (here it fails open). |
| Cron → edge function plumbing | SQL `invoke_cron_function()` (Vault secret, `x-cron-secret`), `admin_schedule_cron`, `manage-cron-jobs`, `components/admin/{CronJobsPanel,CronRunLogsPanel}.tsx`, `_shared/cron-auth.ts` gates, `_shared/timing-safe-equal.ts` | Secrets never in `cron.job`; gates accept cron secret (timing-safe) OR literal service key OR user JWT with roles/page access; admin UI to list/create/toggle jobs. | GENERIC (translate to pg-boss in Keel) | Gate ordering (after OPTIONS, before work), never trust decoded JWT claims, anon key never a credential, service key exact compare. Lesson: pg_cron "succeeded" ≠ job succeeded; record real outcomes in a run table. |
| Retry/backoff helpers | `_shared/retry.ts` (`withRetry`, `defaultIsTransient`), `components/admin/sync-helpers.ts` (`invokeWithRetry`, `runPaginatedSync`), `lib/fetch-all.ts` | Transient classification (network, 408/429/5xx, lock/deadlock); client paginated sync driver with module-level progress surviving unmount. | GENERIC | Verbatim. |
| Error logging (client + edge) + Error Logs page | `lib/error-logger.ts`, `lib/toast.ts`, `components/ErrorBoundary.tsx`, `pages/ErrorLogs.tsx`, `hooks/useShellBadges.ts`, `error_logs` | Global `error`/`unhandledrejection` handlers, portal fetch interceptor for ≥400, boundary errors, `toast.bug()` the only logging toast, ignore-list for browser noise, 5-s dedupe, ring buffer `window.__errorLogBacklog`, release tag, bug badge in topbar, resolve workflow, heuristic fix suggestions. | GENERIC | See §C.6. |
| Alert dispatcher | `dispatch-alerts/index.ts`, `alert_dispatch_log`, `components/admin/AlertSettingsPanel.tsx` | Every 5 min scans error logs, critical notifications, cron failures, role violations, login spikes, orphan SKUs, integration disconnects, backup health; groups by signature; dedupes via `alert_dispatch_log`; Slack + email; per-source toggles. | GENERIC | See §C.8. Fix: dedupe "once ever" should be windowed; alert on absence of success (done for backups only). |
| Audit log | `audit_logs`, triggers `log_product_changes` (full-row diff), `log_user_role_change`, `log_settlement_state_change`, `log_role_permissions_change`, `lib/audit-log.ts` (`recordBulkAudit`), `components/admin/AuditLogPanel.tsx` | Generic `(actor_id, action, table_name, record_id, old_value, new_value)`; diff-only trigger; bulk client helper stamps `_batch_id`; admin panel with filters + pagination. | GENERIC | §C.2. Lesson: exclude bookkeeping columns (`inventory_synced_at`, tsvector) from the diff and never let a 15-min sync write audit rows — here it produced 17.6M rows / 9 GB and the pruner failed (`.in(id, 5000 ids)` URL overflow). |
| Status history | `listing_status_history`, `log_listing_status_change()`, `lib/status-age.ts` | Append-only `(from,to,changed_at,changed_by)`; time-in-status aggregation. | GENERIC | Verbatim as Keel's order/shipment state history + "age in status". |
| Backups | `backup-critical-tables/{index,plan,retention}.ts`, `backup_table_inventory()`, `restore-rows-from-backup`, `mirror-backup-to-gdrive`, `backup_runs`, `backup_mirror_runs`, `components/admin/BackupPanel.tsx` | Nightly CSV of every public table, one table per chained invocation (202 + background + checkpoint), keyset/range paging by PK from catalog, secret columns blanked, GFS retention 7/4/12, off-site mirror, dry-run restore that only inserts missing rows. | GENERIC | §C.10. |
| Documentation contract (in-app docs) | `docs/technical/*.md` → `scripts/tech-docs-sync.mjs` → SQL `set_tech_docs_section()` → `admin_settings.tech_docs_narrative` (CHECK constraint on shape) → `components/admin/TechDocsPanel.tsx`; nightly `generate-tech-docs` → `tech_docs_introspect()` → `tech_docs_snapshots`; operator handbook `pages/Documentation.tsx` + `documentation_overrides`; `lib/docs-section-for-route.ts` | Narrative markdown synced from repo into DB per section; nightly auto snapshot of schema/RLS counts/cron/buckets; handbook with inline-editable overrides; contextual "docs for this page" link. | GENERIC | §C.11-bis. Especially `tech_docs_introspect()` for Keel's integration-health/architecture page. |
| Google Sheet mirror | `sheet-sync-init`, `sheet-sync-drainer`, `sheet_sync_{config,mappings,queue}`, `lib/sheet-sync-fields.ts`, `pages/GoogleSheetSync.tsx` | Queue one row per changed listing, drain to a sheet by SKU with admin-ordered column mapping. | PATTERN-ONLY | Field registry + ordered mapping UI; queue-per-entity with `attempts/last_error/reason`. Lesson: bookkeeping updates must not enqueue (flood incident). |
| CSV import / migration tooling | `components/products/CsvImportModal.tsx` (parse → validate → classify create/merge/reject by SKU/item_no/lot_no → progress phases), `components/finance/ImportPayoutsCsvDialog.tsx` (aggregate + state mapping), `lib/external-analytics-csv.ts` (header aliases, malformed rows report, mapping audit), `restore-rows-from-backup` | Client-side parse with preview, per-row errors, match-by-key classification, progress reporting. | GENERIC (shape) | Header-alias normalisation, classify-before-write with `_action`, malformed-row report, import audit record. |
| Market intelligence / terminal | `pages/MarketTerminal.tsx`, `pages/ScrapeTargets.tsx`, `firecrawl-test`, `market-chat`, `market_listings`, `market_price_history`, `fx_rates`, `refresh-fx-rates`, `lib/market-pricing.ts` | Competitor scraping, price history, AI chat over market stats, FX table. | CLIENT-SPECIFIC (scraping 1stDibs) / small generic bits | `fx_rates` daily table + trigger-computed base-currency column; `niceRound25`-style price rounding. |
| AI features (valuation, enrichment, QC report, photo shoot) | `ai-*`, `enrich-product`, `generate-condition-report`, `_shared/ai-defaults.ts`, `get-prompt.ts`, `components/admin/AiPromptPanel.tsx`, `PromptInspectorPanel` | Prompts/models stored in `admin_settings` per market; prompt inspector; SSRF guard on image URLs; rate-limited per user. | PATTERN-ONLY | Prompt-as-config + inspector; `url-guard.ts`; per-user rate limit on AI endpoints. |
| Enquiry pipeline, valuations, contracts, collections, QC, settlements, store credit, migration campaign, brand/LP portals, auctions | `pages/Inbound*.tsx`, `seller-portal-action`, `generate-agreement-pdf`, `inbound_collections`, `qc-*`, `migration-*`, `BrandPortal.tsx`, `PartnerPortal.tsx` | Consignment supply chain. | CLIENT-SPECIFIC | Discard the business; keep only the generic mechanisms already listed (stage timestamps trigger, hold flag + GUC bypass, forward-only index helper, column-whitelist triggers for external writers, PDF via pdf-lib). |
| Terms acceptance with hash | `_shared/terms-hash.ts`, `terms-normalize.ts`, `consignment_inquiries.terms_*` | Server re-hashes current terms, timing-safe compares with the hash the user saw, stores version+hash+source on acceptance. | GENERIC (ToS/DPA acceptance for tenants) | Verbatim mechanism. |
| Support tickets + widget | `support_tickets`, `support_ticket_messages`, `support-ticket`, `components/SupportWidget.tsx`, `pages/SupportTickets.tsx` | In-app ticket creation from any page (incl. portals), thread with per-user read receipts, attachments bucket. | GENERIC | Simple ticket schema with `source_url`, read receipts, rate-limited public insert. |
| Onboarding checklist / tour / keyboard shortcuts | `components/OnboardingChecklist.tsx`, `hooks/useOnboardingChecklist.ts`, `user_onboarding`, `lib/keyboard-shortcuts.ts`, `hooks/useKeyboardShortcuts.tsx`, `ShortcutsHelpDialog.tsx` | Role-based first-run checklist persisted per user; `g x` go-to shortcuts, `/` search, `?` help, ignored while typing. | GENERIC | Verbatim. |
| HTML sanitisation | `lib/sanitize.ts`, `lib/email-render.ts` | DOMPurify allow-lists; plain-text extraction stripping quoted replies. | GENERIC | Verbatim. |
| Media handling | `components/ui/smart-image.tsx`, `lib/heic-convert.ts`, `lib/upload-media.ts`, `signed-upload-url` | HEIC→JPEG client conversion, extensionless URL sniffing, signed uploads with path guard. | GENERIC | `smart-image` + signed-upload path pattern. |
| Design language | `docs/design-guidelines.md`, `tailwind.config.ts`, `index.css`, `components/ui/*` | Editorial serif + sans, warm neutrals, brass accent, 8pt grid, restrained motion, record-page template, financial numbers right-aligned. | GENERIC (as a system), palette is brand-specific | See §D. |

---

## B. Data model highlights

**Conventions observed**

- Every table: `id uuid PK default gen_random_uuid()`, `created_at timestamptz default now()`, usually `updated_at` maintained by a touch trigger (~35 tables). RLS enabled on 100% of tables; five infra tables have RLS on with zero policies (deny-all except service role): `cron_state`, `rate_limit_hits`, `self_billing_counters`, `shopify_write_idempotency`, `partner_holds`.
- Soft delete is **status-based** (`listings.status='Deleted'`, `ai_images.deleted_at`, `api_keys.revoked_at`), plus a RESTRICTIVE delete policy `is_super_deleter()` on core tables. No generic `deleted_at` convention.
- Enums: 22 Postgres enums for long-lived lifecycles (`app_role`, `product_status`, `fulfillment_status`, `inventory_status`, `settlement_state`, `internal_note_entity`…), but many status columns are `text + CHECK` (publish jobs, deliveries, holds) and a few are unconstrained text (`orders.status` = raw Shopify `financial_status`, `inbound_collections.status`). Lesson for Keel: canonical states as enums or lookup tables, never raw provider strings as the primary state (this is exactly Keel §4).
- Display labels are decoupled from stored keys: `enquiry_stage_labels` table, `role_registry.label`, `stageDisplayName()`; the rule "labels change, storage keys never" (`/deals` route, `deals` PageKey).
- Configuration-as-data: `admin_settings(key text PK, value jsonb)` holds the permission matrix, required-publish fields, notification toggles, alert channels, fee percentages, prompts, macro-category→SKU-prefix map. Changes are production behaviour changes; only `role_permissions` is audited. Keel equivalent: tenant settings table + feature flags in `packages/config`, with audit on every write.
- Provenance columns: `trigger_event` (append-only `+`-joined breadcrumb on settlements), `source` on orders/enquiries/tech docs snapshots, `changed_by`/`actor_id` on history rows, `requested_by` on jobs.
- Snapshot-at-creation columns: `locked_commission_tiers jsonb`, `locked_payout`, `terms_hash/version`, `sku_history jsonb`.
- Money: `numeric` in DB with `ROUND(x,2)`; integer `*_pence` columns on Shopify balance transactions; app-side arithmetic in integer pence (`src/lib/money.ts`).
- Generated columns from the Shopify payload: `orders.line_item_count`, `total_qty`, `has_consignment_fee`, `is_consignment_fee_only`, `shipping_city/province/country`, `customer_first/last_name` (via immutable SQL helpers over `shopify_data jsonb`); `listings.cubic_ft` GENERATED; `listings.search_tsv` trigger-maintained tsvector.

**Tables worth copying (shape)**

| Table | Key columns | Notes |
|---|---|---|
| `audit_logs` | `actor_id, action, table_name, record_id, old_value jsonb, new_value jsonb, created_at` | Add `tenant_id`, index `(record_id, created_at)`, exclude noisy columns. |
| `error_logs` | `error_type, message, stack_trace, component, url, user_id, user_role, metadata jsonb, resolved, resolved_by, resolved_at` | Anon INSERT policy (public forms), staff read. |
| `notifications` | `user_id, type, title, body, link, entity_type, entity_id, read` | BEFORE INSERT preference trigger; realtime publication. |
| `user_notification_preferences` | `user_id unique, preferences jsonb` | `{type: false}` opt-out; special `mention_email`. |
| `internal_notes` / `mentions` | note: `entity_type enum, entity_id, author_id, body (1..10000), mentions uuid[] (GIN), edited_at`; mention: `note_id, mentioned_user_id, mentioned_by, entity_type, entity_id, link, snippet, notification_id, UNIQUE(note_id, mentioned_user_id)` | |
| `staff_tasks` / `task_automation_rules` / `task_automation_subscriptions` | task: `title, due_at, done, priority, related_type, related_id, assigned_to, auto, source_rule_id, visible_to_role`; rule: `trigger_event, trigger_config jsonb, task_title_template, delay_days, delay_hours, priority, enabled` | |
| `saved_views` | `user_id, scope CHECK, name, filters jsonb` | |
| `role_registry` | `slug unique, label, scope internal/portal, color_token, display_order, active, built_in` | Protect built-ins by trigger. |
| `api_keys` / `api_request_logs` | `name, key_hash, key_prefix, scopes text[], created_by, last_used_at, request_count, revoked_at` / `api_key_id, method, path, status_code, duration_ms` | Add `tenant_id`, `expires_at`. |
| `webhook_subscriptions` / `webhook_outbox` / `webhook_delivery_logs` | sub: `url, secret, events text[], active, description`; outbox: `subscription_id, event, payload, status pending/delivered/failed, attempts, max_attempts, next_attempt_at, last_status_code, last_error, delivered_at` (partial index on `next_attempt_at WHERE status='pending'`); log: `subscription_id, event, payload, status_code, response_body, attempts, success` | |
| `shopify_publish_jobs` | `listing_id, requested_by, status queued/running/succeeded/failed/superseded, kind full/status_only, publish_status, attempts, next_attempt_at, started_at, completed_at, last_error` | Generic "outbound write job" table. |
| `shopify_sync_log` | `resource, records_synced, status success/error/partial/received, error, synced_at` | Doubles as HWM store. Keel: per-tenant, per-integration run table (also feeds "integration health"). |
| `shopify_conflicts` | `product_id, field, rehaus_value, shopify_value, resolution, resolved_by, resolved_at` | |
| `shopify_write_idempotency` | `idempotency_key PK, operation, entity_type, entity_id, status_code, response_json, expires_at` | |
| `listing_inventory_levels` / `warehouses` | `(listing_id, warehouse_id) unique, on_hand, committed, available` / `name, shopify_location_id unique, is_default, status, successor_warehouse_id, logistic_partner_id` | ≈ Keel `InventoryLevel` per location. |
| `inventory_states` | append-only `product_id, status Available/Reserved/Sold/Returned, deal_id, reserved_until, note, changed_by` | |
| `fulfillment_tasks` / `fulfillment_task_skus` / `order_deliveries` | task: `order_id, listing_id, shopify_line_item_id, sku, title, quantity, status enum, tracking_number, tracking_url, carrier, shipped_at, delivered_at, returned_at, return_reason, restocked`, UNIQUE `(order_id, shopify_line_item_id)` | ≈ Keel `Shipment` + events. |
| `listing_status_history` | `listing_id, from_status, to_status, changed_at, changed_by` | ≈ Keel `OrderEvent` light. |
| `alert_dispatch_log` | `signature PK, source, last_sent_at, occurrences, last_payload` | |
| `backup_runs` / `prune_runs` | run: `started_at, finished_at, status, tier, tables jsonb, file_paths text[], total_bytes, total_rows, error_message, last_table, table_plan text[], next_index` | Checkpointed run pattern. |
| `tech_docs_snapshots` | `generated_at, generated_by, source manual/cron, auto_sections jsonb, narrative jsonb` | |
| `rate_limit_hits` | `bucket, ip, hit_at` | Prune periodically. |
| `support_tickets` | `source, source_url, type, subject, description, status, priority, submitted_by/name/email, resolved_*` | |
| `email_templates` / `email_queue` | `slug unique, name, subject, body_html, updated_by` / `template_slug, send_at, sent, cancelled, cancelled_by_stage` + partial index on pending | Add attempt counter + dead-letter (missing here). |
| `fx_rates` | `currency PK, rate_to_gbp, as_of, source` | Make base currency per tenant. |

**RLS policy shapes (live catalogue, 381 policies)**

1. Staff role policy: `USING ((SELECT has_role(auth.uid(), 'sales'::app_role)))` — one policy per role per table, `FOR ALL` for writers, `FOR SELECT` for readers (`migrations/20260702*.sql` show the wrapped scalar-subquery form; 52 hot policies were rewritten this way in the 2026-07-02 perf audit: 100–630 ms → sub-ms).
2. Grid-driven policy: `USING (public.current_user_can_page('orders','read'))` (only ~10 policies use it).
3. Ownership policy for external users: `USING (contact_id IN (SELECT id FROM contacts WHERE auth_user_id = (SELECT auth.uid())))` or `brand_id IN (SELECT brand_id FROM brand_users WHERE user_id = auth.uid())`.
4. Own-row policy: `USING ((SELECT auth.uid()) = user_id)` (notifications, saved views, prefs, read markers).
5. Column-scoped write for restricted roles done by **BEFORE UPDATE trigger** rather than policy (`enforce_brand_partner_listing_whitelist`, `enforce_photographer_field_scope`, `seller_update_inquiry_items`) because RLS cannot restrict columns.
6. RESTRICTIVE delete policy with `is_super_deleter()`.
7. Anon policies limited to specific `admin_settings` keys and public-form inserts.
8. Views use `security_invoker = true`.

Keel translation: replace `has_role(auth.uid(), role)` with `tenant_id = current_setting('app.tenant_id')::uuid AND has_role(auth.uid(), current_tenant, role)`; keep the scalar-subquery wrapping; keep column-scope triggers for restricted writers; keep SECURITY DEFINER RPCs for every write by an external user type, and **`REVOKE EXECUTE FROM PUBLIC, anon` plus `ALTER DEFAULT PRIVILEGES` in the very first migration** (Rehaus's critical finding S1: 256/303 definer functions were anon-executable because of default privileges).

---

## C. Patterns in detail (pseudo-code)

### C.1 RLS helper functions and policy templates

```sql
-- role check (SECURITY DEFINER so policies never recurse into user_roles RLS)
create function has_role(_user_id uuid, _role app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles where user_id = _user_id and role = _role);
$$;

-- grid check: founder bypass → matrix JSON → legacy key alias → custom roles → max level
create function has_page_access(_user_id uuid, _page text, _min_level text) returns boolean … as $$
  v_req := case lower(_min_level) when 'write' then 2 when 'read' then 1 else 0 end;
  if v_req = 0 then return true; end if;
  if exists (select 1 from user_roles where user_id=_user_id and role='founder') then return true; end if;
  select value into v_perms from admin_settings where key='role_permissions';
  if v_perms is null then return false; end if;                      -- fail closed
  v_legacy := case _page when 'enquiries' then 'inbound' … else null end;
  for v_role in select role::text from user_roles where user_id=_user_id loop
    v_level := v_perms -> v_role ->> _page;
    if v_level is null and v_legacy is not null then v_level := v_perms -> v_role ->> v_legacy; end if;
    if v_level is null and v_custom is not null then … custom_roles[].permissions … end if;
    v_max := greatest(v_max, level_to_int(v_level));
  end loop;
  return v_max >= v_req;
$$;
create function current_user_can_page(_page text, _lvl text) returns boolean … $$ select has_page_access(auth.uid(), _page, _lvl) $$;

-- policy templates
create policy "Staff role manage X" on X for all
  using ((select has_role((select auth.uid()), 'ops'::app_role)));           -- wrapped: evaluated once per statement
create policy "Grid read X" on X for select using (current_user_can_page('orders','read'));
create policy "External owner reads own" on X for select
  using (contact_id in (select id from contacts where auth_user_id = (select auth.uid())));
create policy "Own rows" on notifications for all using ((select auth.uid()) = user_id);
create policy "Only owner deletes" on X as restrictive for delete using (is_super_deleter());
-- every SECURITY DEFINER rpc:
revoke all on function f(...) from public, anon;  grant execute on function f(...) to authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public, anon;   -- do this once, early
```

Keel adaptation: every policy also requires `tenant_id = current_setting('app.tenant_id', true)::uuid`; `has_role` takes `(user_id, tenant_id, role)`; the matrix lives per tenant; super-admin uses a separate role/connection with bypass and an audit row per action.

### C.2 Audit trigger (diff-only) + state-change triggers + bulk client helper

```sql
create function log_row_changes() returns trigger security definer … $$
  _old := to_jsonb(OLD); _new := to_jsonb(NEW);
  for _key in select jsonb_object_keys(_new) loop
    continue when _key = any (array['updated_at','search_tsv','inventory_synced_at', …bookkeeping]);  -- Rehaus forgot this; 17.6M rows
    if _old->_key is distinct from _new->_key then
      _diff_old := _diff_old || jsonb_build_object(_key, _old->_key);
      _diff_new := _diff_new || jsonb_build_object(_key, _new->_key);
    end if;
  end loop;
  if _diff_old <> '{}' then
    insert into audit_logs(actor_id, action, table_name, record_id, old_value, new_value)
    values (auth.uid(), TG_TABLE_NAME||'.updated', TG_TABLE_NAME, NEW.id, _diff_old, _diff_new);
  end if;
  return NEW;
$$;
-- state-only triggers: log_settlement_state_change (IF OLD.state IS DISTINCT FROM NEW.state), log_user_role_change (role_assigned/role_changed/role_removed with role scope)
-- status history: log_listing_status_change → listing_status_history(from,to,changed_at,changed_by) on INSERT and UPDATE OF status
```

Client-side bulk actions (`src/lib/audit-log.ts recordBulkAudit`): one row per affected record, chunked by 200, `_batch_id`, `_summary`, `_batch_size`, `_batch_at` stamped into `old_value` so a batch can be reconstructed; failures swallowed (audit gaps never block the already-succeeded write). Keel: `OrderEvent` should carry the same `(actor, diff)` shape and a `batch_id` for bulk actions; `actor_id NULL` = system/service role (annotate the integration/job name instead).

Pruning lesson: `prune-audit-logs` deletes `.in("id", 5000 ids)` via PostgREST → 185 KB URL → 400 every night. Prune server-side (`DELETE … WHERE created_at < cutoff LIMIT … by ctid` in an RPC) and record a `prune_runs` row.

### C.3 Inventory reconciliation with Shopify (pull-only diff)

```
reconcile(tenant):
  listings := all rows with shopify_id (paged 1000)
  whByLocation := warehouses where shopify_location_id not null  → Map(locationId → {id,name,is_default})
  for batch of 250 shopify ids:
    data := gql nodes(ids: gid://shopify/Product/*) { variants(first:1){ inventoryItem{ inventoryLevels(first:10){ location{id,name}, quantities(names:[available,on_hand,committed]) } } } }
       with retry: 429 → sleep Retry-After; THROTTLED errors → backoff 2s*n (5 attempts)
    nodes := drop nulls           # null node ≠ deleted (throttle); never delete on this signal
    for node:
      perLoc := extractPerLocation(node)        # per location: clamp(available,on_hand,committed) → ≥0, totals, inventoryPolicy
      for lvl in perLoc.levels:
        if lvl.clamped: logClampConflict(product, 'qty_clamp', raw, clamped)   # one unresolved row per product, refreshed in place
        wh := whByLocation[lvl.locationId]; if !wh: unmapped.add(locationId); continue   # reconcile never creates warehouses (the 15-min pull does)
        levelRows.push({listing_id, warehouse_id: wh.id, on_hand, committed, available, updated_at})
        keptPairs.add(listing|wh)
      primary := pickPrimary(levels)            # max on_hand; tie → is_default (make deterministic!)
      updates := only columns whose value differs (qty, shopify_on_hand, available_qty, reserved_quantity, warehouse_id, location_name)
      if updates: update listings set … where id   (counts as "updated")
    upsert listing_inventory_levels(levelRows) on conflict (listing_id, warehouse_id)
    delete listing_inventory_levels rows for processed listings not in keptPairs      # Shopify no longer reports that location
    sleep 300ms
  insert shopify_sync_log(resource='reconcile', status = errors? 'partial':'success', records_synced=updated, error=first 5)
  return {checked, updated, levels_upserted, locations_unmapped, errors}
```

Run records: `inventory_reconcile_runs(scope, dry_run, rows_scanned, rows_changed, rows_skipped, aborted, abort_reason, quarantined_skus jsonb, diffs jsonb)` is the richer shape (dry-run first, diffs kept for review) even though the live function only writes the sync log. Resolution UI: `pages/InventoryReconcile.tsx` lists "Published with 0 stock and no order on file" and lets ops either record a manual sale (`NewManualOrderDialog`) or log a reason row (`inventory_reconciliations: listing_id, reason, note, resolved_by`). Precedence rule worth keeping: Shopify is authoritative for quantity and location; local reservations are preserved only when Shopify's numbers violate `available + committed ≤ on_hand` and a local reservation exists.

Keel: same algorithm against `InventoryLevel(variant_id, location_id)`, keyed per tenant, with the run row written always and a `dry_run` flag; schedule 6-hourly + nightly as Rehaus does; alert on absence of a success run.

### C.4 Reservations (holds) as the only writers of reservation state

```sql
reserve_listing(p_listing, p_qty, p_ref, p_until, p_note):
  update listings set available_qty = coalesce(available_qty,qty,0) - p_qty,
                      reserved_quantity = coalesce(reserved_quantity,0) + p_qty,
                      status = case when coalesce(available_qty,qty,0) - p_qty <= 0 then 'Reserved' else status end
   where id = p_listing and coalesce(available_qty,qty,0) >= p_qty;      -- atomic race guard
  if not found then raise 'insufficient_stock';
  insert into inventory_states(product_id,status,deal_id,reserved_until,note,changed_by) values (…,'Reserved',…,auth.uid());
release_listing: delta restore (never slam back to qty); status back to 'Published' when reserved hits 0; insert 'Available' state
check_inventory_conflict (BEFORE INSERT on inventory_states): if NEW.status='Reserved' and latest row for product is 'Reserved' for a different ref → raise
auto-release-reservations (cron 30 min): rows past reserved_until → re-check parent ref + no newer state → release_listing
mark_deal_won: conditional update where stage<>'Won' → idempotent; fan-out reserve per line in sub-transactions; ON CONFLICT DO NOTHING on money rows
```
Partner holds variant: move 1 unit `available → reserved` in Shopify (`inventoryMoveQuantities`) so the storefront shows sold-out while on_hand stays, TTL 5–30 min, one active hold per listing (partial unique index), sweep every 5 min. Known gap: a local reservation that is not pushed to Shopify is undone by the next pull; decide the authority rule explicitly.

### C.5 Fulfilment to Shopify

```
fulfill(order_id, tracking_number?, tracking_url?, carrier?, notify_customer?):
  gate requireStaff
  order := orders(shopify_order_id); tasks := fulfillment_tasks(order)
  FOs := GET /orders/{id}/fulfillment_orders.json ; open := FOs where status in (open, in_progress)
  {company, originalIfCustom} := resolveCarrier(carrier)      # whitelist → Shopify name, else "Other" + keep name in note
  for fo in open: POST /fulfillments.json { line_items_by_fulfillment_order:[{fulfillment_order_id}], tracking_info?{number,url,company}, notify_customer }
     with fetchWithRetry (429/5xx → Retry-After or 2^n ≤10s)
  ONLY IF Shopify accepted:
     orders.fulfilled_at, shopify_fulfillment_status := …; tasks → shipped, shipped_at, tracking fields
  ELSE orders.shopify_fulfillment_error := msg
  side effects: Slack ping; settlements are NOT created here (created on 'delivered')
```
Local state machine for lines: `pending → packed → (held ↔ packed) → shipped → delivered → returned`; `packed` creates the delivery row; `delivered` triggers downstream money; order-level status derived in SQL (`get_outbound_board`) by precedence. Keel: this is the multi-source shipment status model from §7.2 — each source (Shopify fulfillment, carrier, manual) writes its own columns, one SQL/`core` function derives the visible status by precedence.

### C.6 Error log capture

```
client (src/lib/error-logger.ts):
  installGlobalErrorHandlers(): window.error + unhandledrejection → logError({error_type:'js_error'|'sell_form_warning', message, stack, component})
  installPortalFetchInterceptor(): wrap fetch; on portal/public pages only, any supabase REST/functions response ≥400 → 'api_error' (skip /auth/v1, PGRST301, own insert)
  ErrorBoundary → 'boundary_error' + componentStack
  toast.bug(msg, err) → 'js_error' + metadata.source='toast.bug'   (toast.error/warning/validation never log; ESLint forbids importing sonner elsewhere)
  logError: shouldIgnore(IGNORED_PATTERNS, STACKLESS_NOISE, extension stacks, stale-chunk → reload once) → isDuplicate(5s) → merge {portal, is_portal, release} → insert error_logs → on sink failure push to window.__errorLogBacklog (ring 50)
server: 7 edge functions insert error_logs rows (e.g. seller_sweep_failed, cron_schedule_reverted)
UI: /admin/error-logs — grouped list, hide funnel + user_input types by default, resolve/unresolve, suggestFix(message, component) heuristics; topbar bug badge polls 60s, one toast per failing badge per session then a "stale" dot
```
Keel: identical pipeline plus `tenant_id` and `integration` columns; the `api_error` interceptor is the cheapest way to see silent RLS denials.

### C.7 API gateway with keys, scopes, logging (and what to change)

```
request → Authorization: Bearer <prefix>_<random>
  key_hash := sha256(raw); row := api_keys where key_hash and revoked_at is null (add: expires_at > now, tenant_id)
  rateLimit(row.id)                         # Rehaus: in-memory per isolate (not durable) → use record_and_count_rate_hit(bucket='api:'+key_id, ip=key_id, window)
  route := parse ?path=/v1/{resource}[/{id}]  (prefer real path routing)
  hasScope(scopes, resource, action): `${r}:${a}` | `${r}:write` implies read | '*'
  projection := internal key ('*' | 'internal:read') ? '*' : PARTNER_SAFE_COLUMNS ; decorate(row) adds url, cart_url, availability (sold|held|available)
  pagination: limit ≤100, offset, order created_at desc, { data, total_count, limit, offset }; `updated_since` → ascending by updated_at (delta sync)
  PATCH: allow-list of fields
  finally: insert api_request_logs(api_key_id, method, path, status_code, duration_ms); rpc increment_api_key_usage(key_id)
Admin UI: create key (show once, store prefix), scopes picker, revoke, request log; ApiDocs page generated from the route table.
```
This plus the outbound webhook outbox (§C.11) is a sound base for Keel's MCP connector / public API per tenant.

### C.8 Alert dispatch

```
every 5 min:
  settings := admin_settings[alerts_enabled, alerts_email_to, alerts_slack_channel, slack_notification_toggles]   (missing toggle = ON)
  items := []
  if toggle error_log:      unresolved error_logs in last 15 min with type in (…)   → sig `err::type::component::msg[0:120]`
  if toggle notification:   critical notification types                             → `notif::type::title::link`
  if toggle cron:           cron.job_run_details status='failed'                     → `cron::job::msg`
  role_violation: user holds external + internal role                                 → per user
  login_spike: ≥3 failed logins per email in 24h; orphan_sku: delivered line with no listing; abandon_spike per ISO week
  integration: refresh_failed_count ≥3 or stale >48h; dead_letter rows
  backup_health: failed run in 24h, stuck 'running' >1h (also reaped to failed), **no success in 26h** (once per UTC day), failed mirror
  group by signature (count); alreadySent := alert_dispatch_log where signature in (…)
  toSend := not alreadySent  → compose one grouped Slack message + one email
  upsert alert_dispatch_log(signature, source, last_sent_at, occurrences, last_payload{…deliveries})
```
Improvements Keel should make from the start: window the dedupe (e.g. re-arm after 24h or when the underlying record is resolved), include frontend `js_error/boundary_error` types, read the real HTTP outcome of jobs (in Keel, pg-boss job state), and add "no success in N hours" checks for every sync, not only backups.

**C.8-bis Notifications fan-out**

```sql
notify_role(_type,_title,_body,_link,_entity_type,_entity_id,_roles[]):
  if admin_settings.notification_settings->>_type = false then return;            -- global toggle
  for user in distinct user_roles where role = any(_roles):
     if coalesce(prefs(user)->>_type, true) then insert notifications(...)
apply_notification_preferences (BEFORE INSERT on notifications): prefs[type] = false → RETURN NULL (silently drop)
```
Client: `normalizeNotificationLink()` rewrites legacy routes and `resolveEntityLink(entity_type, entity_id)` is the fallback, so renamed routes never strand old notifications.

### C.9 Mentions

```
storage format in note body: @[Display Name](uuid)    (regex enforces uuid)
channel sentinels: 00000000-0000-0000-0000-cccccccc00XX → {label:'@finance', roles:[...]}  (can never collide with auth uuids)
client: MentionTextarea shows pretty "@Name"; on submit encodeMentionsForStorage(text, internalUsers, selectedMentions) → canonical format
        (longest-name-first matching; ambiguous names only resolved if the user picked a row; blocks submit if the user list hasn't loaded)
server process-mentions(note_id): parse → expand channels to role members (minus author) → keep only is_internal_staff(uuid)
        → update internal_notes.mentions[] → for each recipient: skip if (note_id,user) exists → insert notification{type:'mention', title, snippet, link: ENTITY_LINKS[entity_type](id)} → insert mentions row → optional email if prefs.mention_email
render: MentionRenderer splits text on the regex and renders chips (no HTML injection); channel chips in a different tone
badges: /mentions page + TasksPanel tab + realtime channel `mentions-list:<uid>`
```
Keel §7.1 asks for exactly this on orders ("note interne con @menzioni e notifiche"): reuse format, server-side validation, entity→link map, channel mentions by role.

### C.10 Backups

```
orchestrator (cron 02:30): tier := monthly if day=1 | weekly if Sunday | daily
  tables := rpc backup_table_inventory()  (pg_class + primary key columns) minus EXCLUDED_TABLES (logs/queues/caches)
  insert backup_runs{status:'running', tier, table_plan, next_index:0}; chain(step='table', run_id, 0)
step(table i): answer 202 immediately; in background:
  plan := pk.length==1 ? keyset on pk : ordered .range() over composite pk
  page 500 rows → header = columns minus EXCLUDED_COLUMNS[table] → redactRow (REDACTED_COLUMNS: secrets blanked, header kept) → csvEscape (RFC4180) → chunk
  upload Blob to backups/{tier}/{stamp}/{table}.csv; checkpoint backup_runs{last_table, next_index, tables[table]={rows,bytes}, file_paths}
  chain next table or finalize
finalize: status success, GFS retention (keep 7 daily/4 weekly/12 monthly folders that belong to a *success* run; partial leftovers deleted after 6h grace); then mirror-backup-to-gdrive (gzip per file via CompressionStream, zip, upload, same retention off-site)
restore-rows-from-backup: dry_run default true; tolerant CSV parser; filter_column IN values; upsert onConflict id ignoreDuplicates (never updates/deletes); ALLOWED_TABLES allow-list; malformed rows reported
alerts: failed run, stuck >1h, no success in 26h, mirror failed
```
Keel: per-tenant export is also a product feature (tenant data export) — the same chained exporter with a tenant filter and redaction map works for both.

### C.11 Outbox / drainer (webhooks, accounting pushes, Shopify writes)

```sql
dispatch_webhook_event(p_event, p_payload):  insert webhook_outbox(subscription_id, event, payload)
   select s.id, … from webhook_subscriptions s where s.active and p_event = any(s.events);   -- called by row triggers
claim_webhook_outbox(p_limit): update webhook_outbox set next_attempt_at = now()+15min
   where id in (select id from webhook_outbox where status='pending' and next_attempt_at<=now() order by created_at limit p_limit for update skip locked)
   returning …;
try_webhook_drainer_lock(): select pg_try_advisory_lock(hashtext('webhook-drainer'));
```
```
drainer (every minute): lock → claim 50 → load subscriptions once →
  body := {delivery_id: row.id, event, data, timestamp}; sig := HMAC-SHA256(secret, body)
  POST url with X-Signature, X-Event, X-Delivery-Id, timeout 15s
  always insert webhook_delivery_logs; success → delivered; else attempts≥max → failed, else next_attempt_at = now + BACKOFF[attempt] (10s,1m,5m,30m,2h)
  inactive/missing subscription → failed immediately
```
Xero variant adds: `ON CONFLICT (kind, source_id)` re-open with 30-s debounce, `reap_stuck` (processing > 5 min → pending), 90-s heartbeat singleton in a settings row, `dead_letter` flag at 8 attempts, exponential `min(2^attempts, 240) min`, dry-run status. In Keel use pg-boss for the queue but keep the **row-level provenance** (`attempts`, `last_error`, `last_status_code`, `delivered_at`, `dead_letter`) in a visible table so "integration health" can show it.

**C.11-bis Documentation generation**

```sql
tech_docs_introspect() (SECURITY DEFINER, STABLE): jsonb {
  schema:  information_schema.tables/columns for public (name, type, nullable),
  cron_jobs: cron.job (jobname, schedule, command),
  storage: storage.buckets (name, public),
  rls_policy_counts: pg_policies grouped by table }
set_tech_docs_section(key ~ '^[a-z0-9_]+$', markdown): upsert admin_settings.tech_docs_narrative = value || {key: md}   -- per-key merge, SECURITY INVOKER
CHECK admin_settings_tech_docs_narrative_shape: value is object AND every member is string
```
```
scripts/tech-docs-sync.mjs: MANIFEST [(section_key, docs/technical/xx.md)] → prints `SELECT set_tech_docs_section(key, $md$…$md$)` in one transaction
generate-tech-docs (nightly + "Refresh now"): introspect + role_permissions + narrative digest + static INVARIANTS/INTEGRATIONS → tech_docs_snapshots; keep last 30
TechDocsPanel: narrative sections rendered by a dependency-free markdown→blocks parser (lib/tech-docs-narrative.ts: normalizeNarrative unwraps up to 8 levels of accidental string-wrapping, flags malformed)
/documentation handbook: static SECTIONS with inline-editable overrides keyed (section_id, block_index, field_key); docsSectionForRoute(pathname) gives a contextual "Help for this page" link
```
Keel: generate the §11 `ARCHITECTURE.md` data-model section from the same introspection; show integration guides (§6.2) with the same block model and "Da verificare" badges as a block kind.

### C.12 Publish queue with supersede and pull guard (local → Shopify writes)

```sql
enqueue_shopify_status_push() AFTER UPDATE OF status on listings WHEN OLD.status IS DISTINCT FROM NEW.status:
  if auth.uid() is null or auth.role() <> 'authenticated' then return NEW;   -- service-role pull writers never enqueue (no echo loops)
  if NEW.shopify_id is null then return NEW;                                 -- first publish stays explicit
  target := case NEW.status when 'Published' then 'active' when 'Draft' then 'draft' else return end;
  update shopify_publish_jobs set status='superseded', completed_at=now() where listing_id=NEW.id and status='queued';
  insert shopify_publish_jobs(listing_id, requested_by, status, publish_status, kind) values (NEW.id, auth.uid(), 'queued', target, 'status_only');
```
```
drainer (every minute): due := status='queued' OR (status='running' AND started_at < now-20min)
  status_only fast path: up to 60 inline productUpdate(status) mutations, throttled
  full: batch of 3 → call push function with service key + job_id (bypasses user-level publish gate, keeps first-publish gate)
  attempts: nextAttempt > 3 → failed + notification to requester
pull writers (sync-products, reconcile-status, webhook): pending := listing ids with job queued/running; skip writing `status` for them (shouldSkipStatusWrite)
```
Keel §7.6/§7.8 (price/status edits written to Shopify, discount creation) should go through this exact queue, per tenant, with `kind` per operation.

### C.13 Idempotent external writes

`shopifyWriteOnce({operation, entityType, entityId, url, payload, admin})`: key = `operation:sha256(operation|entityType|entityId|stableStringify(payload))`; cache hit → return stored response without network; else POST with `Idempotency-Key` header, retry 429/5xx (Retry-After or 2^n ≤ 8s, 4 attempts), cache only 2xx (4xx must stay retryable after the user fixes the payload), swallow duplicate-key on cache insert. Table has `expires_at` (30 days). Use for Meta campaign pause, Shopify discount/draft-order/fulfilment creation, 3PL bookings.

### C.14 Inbound email threading (for Keel's customer-care timeline)

Precedence: (1) `[REH-TAG]` subject token or hidden `<!-- app:thread:TAG -->` body comment inserted on every outbound email (`applySubjectTag` keeps it after `Re:`/`Fwd:`); (2) `In-Reply-To`/`References` Message-IDs looked up against stored outbound `message_id`; (3) contact's open threads (0 → attach to contact only; 1 → that thread; N → one log row per thread). Terminal stages are excluded from "open". Inbound webhook verified with Svix; attachments stored privately and served via signed URLs.

### C.15 Cron/edge auth gate (the pattern, not the transport)

Order: OPTIONS → gate → service client → body. Gate accepts: `x-cron-secret` (timing-safe) → literal service key (exact string compare) → user JWT via `auth.getUser()` then roles / `has_page_access` RPC (fail closed on RPC error). Never decode-and-trust a JWT claim; never accept the anon key; never a spoofable header like `x-source`. Source-contract tests (`permission-matrix-sweep.test.ts`) read each function's source and assert the gate string is present — cheap drift protection worth copying for Keel's feature-flag checks on routes/jobs.

---

## D. UI patterns worth copying (describe, do not copy brand)

- **Record page template** (`components/detail/DetailPageShell.tsx`): back link + Prev/Next; eyebrow label (0.2em tracked uppercase) + serif title + one meta line; one visible primary CTA, 0–1 secondary, everything else in an Actions ▾ menu; a single wrapping chip row for status + meta chips; optional banner slot; KPI strip; sticky tab strip; tab panels. Used by Orders, Enquiries, Collections, Listings. Keel's order/product/campaign/customer pages should share one shell like this.
- **Prev/Next across the filtered list** (`hooks/useAdjacentIds.ts` + `PrevNextNav`): list page stores the current ordered id list (optionally per kanban group) in sessionStorage; detail page derives neighbours. Zero server cost.
- **List page toolbar**: search input + N `MultiSelectFilter`s (searchable when >8 options, "select all", `(No X)` null option, flip-up when near viewport bottom) + `FiltersPopover` for secondary column filters (text/select/date-range/number-range via `ColumnFilterCell`) + `SaveViewButton`/`SavedViewChips` + `ViewToggle` (board/list) + `PeriodFilter`; on mobile the same controls inside `MobileFilterSheet` (bottom sheet, "Show results" footer, active-count pill). All filter state via `useStickyFilter(pageKey, key, default)` so it survives detail→back.
- **Server-side pagination UI** (`components/common/Pagination.tsx`): "from–to of total" summary, windowed page numbers (`getPageRange` never renders an ellipsis for a single page), prev/next, "Go to page" input; 0-based page prop; sits under the table.
- **Sortable headers**: `SortableTh` 3-state (none→asc→desc→none, `cycleSort`) for per-column filter+sort tables; `SortableHeader` 2-state with a per-column default direction for numeric columns.
- **Kanban + list dual view** for pipelines (Enquiries, Outbound) with column counts from a server aggregate RPC independent of client filters, and mobile column tabs.
- **Topbar badges with failure policy**: each counter polls; first non-transient failure toasts once per session, later failures only show a red "stale" dot; transient network errors never toast.
- **Empty/loading states**: `PageSkeleton`/`TablePageSkeleton` as Suspense fallback for every lazy page; `ErrorBoundary` per route with retry; compact fallback variant for panels.
- **Dashboard**: react-grid-layout with a widget catalogue (`SOURCE_CATALOG`) typed metric/list/chart/panel, each gated by a permission page, role-specific default layouts, per-user persistence, "Add widget" dialog, per-widget settings popover.
- **Notification bell**: realtime insert channel filtered server-side by user id, grouped preference toggles inside the bell, legacy-link normalisation on click.
- **Internal notes panel**: compact mode for drawers, 15-minute edit window, author names from a strict profile hierarchy, realtime refresh filtered by entity id.
- **Tasks drawer** (`TasksPanel`): right-hand drawer toggled by `t`, "my tasks due" + mentions tabs, related-entity deep links from `(related_type, related_id)`.
- **Admin hub as tab registry** (`components/admin/admin-tabs.ts`): grouped tabs with id/label/icon/description, each mapped to a `settings_*` permission key; `getAccessibleAdminTabs` filters by `canRead`.
- **Permissions matrix editor**: role columns × grouped page rows; click cycles none→read→write with icon + colour; "founder cannot be restricted"; save upserts one JSON and invalidates the cache.
- **Keyboard shortcuts**: `/` search, `?` help dialog listing `SHORTCUTS`, `g <key>` navigation, ignored in editable fields.
- **Onboarding checklist** card on the dashboard: role-specific items, progress bar, dismiss, auto-hide when complete.
- **Error Logs page**: grouped by message, type colour, hide "user input"/funnel types by default toggle, resolve action, heuristic "suggested fix" box.
- **Confirmation dialogs for side-effect buttons** (`ConfirmDialog`) and "Push to Shopify" pre-flight dialog listing missing required fields with inline fixes.
- **Design system rules** (`docs/design-guidelines.md`): 8pt grid, max width 1440, serif H1/H2 and strategic metrics, sans for UI/tables, warm off-white base, one muted accent, understated semantic colours (no bright red/green), 200–300 ms ease-in-out motion, no exclamation marks in microcopy, numbers right-aligned and tabular in financial tables, ≥44px hit areas, HSL design tokens only (no raw `text-white`). ESLint-enforced single toast facade.
- **Mobile**: tablet portrait = mobile; sheet navigation + bottom nav; cards stack single-column; filters in bottom sheet; tables get horizontal scroll with sticky first column.

---

## E. Pure utilities worth reusing (near-verbatim, after renaming/de-branding)

| Name | Path | What it does |
|---|---|---|
| `toPence / fromPence / sumPence / subPence / formatGBP` | `src/lib/money.ts` | Integer-minor-unit money arithmetic, lenient string parsing (`£1,234.56`), half-up rounding, display formatting. Generalise to `toMinor(value, currency)` using `Intl` per tenant. |
| `calcLayeredFee / getTierBreakdown / calcModelFee` | `src/lib/commission-calc.ts` (Deno twin `_shared/commission.ts`) | Bracketed/blended percentage over tiers (`max − min + 0.01` bracket width), 2-dp rounding once. Reusable for tiered payment-provider fees or commission plans. |
| `calcNetSales / netSalesBreakdown` + `CANONICAL_DEDUCTION_FIELDS` | `src/lib/settlement-formula.ts` | Formula-as-data: ordered deduction field list, clamp at 0, per-row breakdown for an explainer UI. Model for Keel's order P/L function. |
| `getPageRange` | `src/components/common/Pagination.tsx` | Windowed page-number list with correct ellipsis rules. |
| `resolvePeriodRange / periodQueryKey / PERIOD_PRESETS` | `src/components/common/PeriodFilter.tsx` | Preset/custom period → half-open ISO window + stable query key. |
| `tokenizeSearch / inquiryOrFilterForToken / matchesInquiryClientSide` | `src/lib/search-tokens.ts` | PostgREST-safe tokeniser (max 6 tokens, strips `()*,"\`), per-token `.or()` builder, client AND-match. |
| `isFilterActive / matchesFilter / cycleSort` | `src/lib/table-filters.ts` | Column filter predicates (text/select/date-range/number-range, inclusive day bounds) and 3-state sort cycling. |
| `sanitizeHtml / htmlToPlainText` | `src/lib/sanitize.ts` | DOMPurify allow-lists; quoted-reply stripping. |
| `renderEmailHtml / stripHtml` | `src/lib/email-render.ts` | Extract `<body>`, rewrite `cid:` to attachment URLs, plain-text fallback in `<pre>`. |
| `aggregateStatusAge / formatDuration` | `src/lib/status-age.ts` | Time-in-status buckets from a history list; compact `2d 4h` formatting. |
| `clampInventory` | `supabase/functions/_shared/inventory-clamp.ts` | Negative → 0 with `clamped` and `invariant_violated` flags. |
| `extractPerLocation / pickPrimary / locationGidToLegacyId` | `_shared/per-location.ts` | Shopify GraphQL inventoryLevels → per-location rows + totals + primary (make tie-break deterministic). |
| `decideDeletions / gidToLegacyId` | `shopify-pull-inventory/_deletion-decision.ts` | Never delete on partial responses. |
| `pendingListingIds / shouldSkipStatusWrite` | `_shared/pending-status-guard.ts` | Pure guard for pull-vs-push races. |
| `stripProtectedColumns / hasProtectedColumns` | `_shared/studio-authored.ts` | Drop locally-authored columns from a pull row. |
| `buildIdempotencyKey / stableStringify / shopifyWriteOnce` | `_shared/shopify-idempotency.ts` | Deterministic idempotency key + cached write. |
| `withRetry / defaultIsTransient` | `_shared/retry.ts` | Retry wrapper with transient classification. |
| `timingSafeEqual` | `_shared/timing-safe-equal.ts` | Constant-time string compare (secrets, HMACs). |
| `resolveClientIp` | `_shared/client-ip.ts` | `cf-connecting-ip` → last XFF token → `x-real-ip`. |
| `assertPublicHttpsUrl` | `_shared/url-guard.ts` | SSRF guard (loopback, private, link-local/metadata, ULA). |
| `createLogger` | `_shared/logger.ts` | One-JSON-line structured logger with child contexts. |
| `signPortalToken / build*DeepLink` | `_shared/portal-token.ts` | base64url HMAC tokens with `exp` and `v` discriminator, TTL clamp 1–90 days. Use a dedicated secret, not the service key. |
| `findAuthUserByEmail / normalizeEmail` | `_shared/resolve-auth-user.ts` | Side-effect-free auth user lookup. |
| `applySubjectTag / appendHiddenBodyToken / extractTagFromSubjectOrBody / extractReplyHeaderIds / extractMessageId` | `_shared/email-thread-routing.ts` | Email threading primitives. |
| `hmacSign` + backoff table | `webhook-drainer/index.ts` | HMAC-SHA256 hex signature for outbound webhooks. |
| `csvEscape / tierForDate / stampFor` and `buildHeader / redactRow / pagingPlanFor / selectBackupTables` | `backup-critical-tables/{index,plan}.ts` | RFC-4180 CSV, GFS tier selection, PK-driven paging plan, column redaction. |
| `foldersToDelete / successSnapshotKeys / stampToMs` | `backup-critical-tables/retention.ts` | GFS retention over snapshot folders with grace for partials. |
| `parseCsv` (tolerant) | `restore-rows-from-backup/index.ts` | Quote-aware CSV parser that never enforces field counts. |
| `fetchAllRows` | `src/lib/fetch-all.ts` | PostgREST 1000-row paging with transient retry and a hard ceiling that throws (never silent truncation). |
| `invokeWithRetry / runPaginatedSync / timeAgo` | `src/components/admin/sync-helpers.ts` | Client-side retry for function calls; cursor-driven paginated sync driver with progress. |
| `getPageRange`-style `normalizeNotificationLink / resolveEntityLink` | `src/lib/normalize-notification-link.ts` | Legacy route rewriting + entity→route fallback. |
| `recordBulkAudit` | `src/lib/audit-log.ts` | Chunked per-record audit rows with `_batch_id`. |
| `useStickyFilter / readStickyBucket / writeStickyBucket` | `src/hooks/useStickyFilter.ts` | Session-scoped filter persistence with bucket replacement event. |
| `storeAdjacentIds / storeAdjacentIdGroups / useAdjacentIds` | `src/hooks/useAdjacentIds.ts` | Prev/next record navigation. |
| `useDebouncedCallback` | `src/hooks/useDebouncedCallback.ts` | Coalesce realtime bursts. |
| `isTypingInEditable / hasBlockingModifier / GOTO_ROUTES` | `src/lib/keyboard-shortcuts.ts` | Shortcut plumbing. |
| `clickableProps / rowActivation` | `src/lib/clickable.ts` | Keyboard-operable clickable rows/divs. |
| `buildFunnel / medianDaysBetween / sellThroughRates` | `src/lib/dashboard-kpis.ts` | Pure KPI maths over timestamp columns. |
| `grossSubtotal / sumRefundTransactions / sumShopifyFees / sumShippingLines` | `src/lib/order-aggregates.ts` | Shopify order payload aggregation in minor units. |
| `SOLD_FOR_PAYOUT ⊂ SOLD_FOR_UI`, `buildSoldSet` | `src/lib/sold-derivation.ts` | Two-tier sold definition from orders + line tasks (financial vs UI). |
| `tallyCountedLines / normaliseSku` + report builder | `src/lib/stock-take.ts` | Discrepancy buckets for physical counts. |
| `computeCubicFt / cubicFtSource` | `src/lib/volume.ts` | Volume from dims/cylinder/package (storage or shipping cost inputs). |
| `getEffectiveShippingAddress / inferPostcode` | `src/lib/shipping-address.ts` | Local override merged over provider address (empty string = unset, null = clear). Make postcode regex per country. |
| `TIME_SLOTS / normalizeLegacyTime` | `src/lib/time-slots.ts` | Canonical delivery slots + legacy normalisation (make tenant-configurable). |
| `normaliseHeader / canonicalField / parseNumber` | `src/lib/external-analytics-csv.ts` | CSV header alias matching and numeric cleaning. |
| `insertListingWithSkuRetry` + SQL `next_asset_number(prefix)` | `src/lib/sku-generator.ts`, `migrations/20260527125429_*` | Atomic prefixed sequence with unique-violation retry (`23505`). |
| `formatAssetNumber / macroForCategory / assetPrefixForMacro` | `src/lib/macro-category.ts` | Config-driven SKU prefixing. |
| `normalizeNarrative / appendixTitle` + markdown block parser | `src/lib/tech-docs-narrative.ts` | Defensive JSON-narrative normaliser and dependency-free markdown→blocks. |
| `docsSectionForRoute` | `src/lib/docs-section-for-route.ts` | Route → help section mapping. |
| `extractStructuredMentions / encodeMentionsForStorage / findTrigger` | `src/components/mentions/MentionTextarea.tsx` | Mention encoding (pure parts). |
| `isAllSelected / EMPTY_VALUE` | `src/components/ui/multi-select-filter.tsx` | Multi-select semantics for null-inclusive filters. |
| Phone input | `src/components/ui/phone-input.tsx` | `react-international-phone` wrapped in shadcn styles (Keel: default country from tenant; normalise to E.164 with libphonenumber on save). |

Test patterns worth copying (not utilities but equally reusable): parity tests between SQL/Deno/TS copies of the same predicate (`fee-predicate.test.ts` ↔ `_shared/fee-predicate_test.ts`), source-contract tests asserting gates/guards exist in source (`permission-matrix-sweep.test.ts`, `edge-generate-link-guard.test.ts`, `ProtectedRoute.fail-closed.test.ts`), query-builder mock tests asserting emitted filters (`src/data/__tests__/listings-*-filter.test.ts`), contract tests for RPC semantics (`reserve-listing.contract.test.ts`).

---

## F. Top 10 things a generic e-commerce ops SaaS should steal from Rehaus

1. **One permission matrix, three consumers.** `role → page → none/read/write` JSON read by the UI hook, by SQL `has_page_access()` inside RLS/RPCs, and by edge/job gates; `PAGE_GROUPS` drives the editor, `ROUTE_TO_PAGE` drives the guard, legacy-key aliases survive renames. Keel: same thing per tenant, plus feature flags for add-ons checked server-side the same way.
2. **Business rules in the database, mirrored as pure TS with parity tests.** Settlement formula, fee predicate, sold-derivation, cohort rules: trigger/SQL is authoritative, `src/lib` mirror lets the UI preview the same number, a test proves the two agree. Keel's `packages/core` is the mirror; keep the parity-test discipline.
3. **Pull-only sync with explicit authority rules + a protected-column marker + a pending-push guard.** Shopify wins by default; local edits reach Shopify only through a queue; locally authored fields are stripped from pulls; pull writers skip `status` while a push is queued; service-role writers never enqueue (no echo loops).
4. **Outbound write job queue with supersede, status-only fast path, bounded attempts and stuck-job reaping** (`shopify_publish_jobs` + drainer), and **idempotent external writes** (`shopify_write_idempotency`). Use for every Shopify/Meta write Keel makes.
5. **Outbox + `FOR UPDATE SKIP LOCKED` claim + advisory lock + HMAC-signed deliveries + backoff table + delivery log + dead-letter**, for partner webhooks and accounting pushes. Directly the shape of Keel's MCP/event layer and 3PL/WhatsApp add-on slots.
6. **Per-location inventory reconciliation that never deletes on uncertain evidence**: clamp negatives and log a deduped conflict, aggregate from per-location rows, diff only changed columns, delete stale pairs, write a run summary, re-verify singletons before soft-deleting.
7. **Error-log pipeline + alert dispatcher + run tables.** Global handlers, portal fetch interceptor, `toast.bug` as the only logging toast, ignore-list, ring buffer; 5-minute grouped alerts with signature dedupe; `backup_runs/prune_runs/shopify_sync_log/api_request_logs` as the evidence trail. Add what Rehaus lacked: alert on *absence of success* for every scheduled sync, and windowed dedupe.
8. **Nightly full-schema backup, one table per invocation, catalog-discovered tables, PK-aware paging, redacted secret columns, GFS retention, off-site mirror, dry-run row restore.** Reusable both as disaster recovery and as per-tenant data export.
9. **Internal notes with `@[Name](uuid)` mentions, role channels via sentinel UUIDs, server-side recipient validation, entity→link map, per-user notification preferences enforced by a BEFORE INSERT trigger, and legacy-link normalisation.** This is Keel's order-timeline/notes/mentions requirement almost verbatim.
10. **Documentation contract**: repo markdown synced per section into the DB via a constrained `set_*_section()` function, nightly introspection snapshot (tables, policies, cron, buckets), in-app operator handbook with inline overrides and a contextual help link per route; plus a KNOWN-ISSUES register with severity and evidence. Keel's `EVALUATION.md`/`ARCHITECTURE.md` and the integration-health page can be generated the same way.

Honourable mentions: `fetchAllRows` that throws instead of truncating; `useStickyFilter` + saved views; `DetailPageShell` record template; `getPageRange`; the record-page "one primary CTA" rule; the `insufficient_stock` conditional-update reservation; the terms-hash acceptance; the `trigger_event` provenance breadcrumb; the role registry with protected built-ins; and the list of mistakes to design around (anon-executable definer functions by default privilege, audit rows from bookkeeping updates, URL-length `.in()` deletes, cron "succeeded" meaning only "queued", four revenue definitions, three "internal user" definitions, enum stage names duplicated in three client files).
