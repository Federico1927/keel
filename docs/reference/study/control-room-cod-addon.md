> Historical document: the product was formerly called Keel.

# Control Room (Lorena Milano) — COD modules study

Source: `/home/user/lorena-control-center` (read-only). Scope: COD confirmation queue, operator assignment, delivery score, recipient risk. Everything below is taken from the migrations (`supabase/migrations/*.sql`, `drizzle/migrations/*.sql`), edge functions (`supabase/functions/*`), client code (`src/*`) and the team docs; where the docs and the code disagree, the code wins and the discrepancy is flagged.

Reading order used: `.lovable/memory/index.md`, `.lovable/memory/constraints/recipient-risk.md`, `.lovable/memory/features/{order-actions,order-status-derivation,pl-workflow-status,order-activity-tracking,customer-order-history}.md`, then `docs/team/05-conferma-cod.md`, `19-assegnazione-cod.md`, `24-delivery-score.md`, `29-rischio-destinatari.md`, then code.

Legend for classification: **COD-ONLY** = belongs in Keel's `addon.cod`; **GENERIC** = belongs in Keel core; **CLIENT-SPECIFIC** = Lorena / shoes / Italy / Elogy / Spoki, drop or re-parametrise.

---

## A. Feature inventory

| Feature | Where | What it does | Classification | Logic worth reusing |
|---|---|---|---|---|
| Queue eligibility predicate | `drizzle/migrations/0019_cod_queue_state_criterion.sql`, `0028_cod_queue_exclude_scheduled.sql` → `public.is_cod_queue_order(orders)`; client mirror `src/lib/codQueue.ts` | Single source of truth for "is this order in the confirmation queue": COD, open, not shipped, workflow state `da_confermare`, not scheduled in the future. Used by page RPC, metrics, dashboard, auto-assign, claim, sweep, and as a PostgREST computed column (`.eq("is_cod_queue_order", true)`). | COD-ONLY (the predicate) / GENERIC (the pattern: one SQL predicate reused by every reader + exposed as computed column) | Yes: a derive-once predicate shared by list, counters, assignment and client. |
| Queue page RPC | `0021_cod_queue_page_no_temp.sql`, `0028` → `cod_queue_page(p_filter_tag, p_page, p_page_size, p_sort_asc)` | Paginated queue (max 100/page), optional tag filter, special filter `Programmati`, returns `{orders:[{order, call_count, last_at}], total_count}`. Cheap predicates first on a partial index, then expensive function predicates on the residual set (MATERIALIZED CTEs). | COD-ONLY | Yes: cheap-filter-then-expensive-filter pattern; returning attempt counts alongside the page. |
| Queue metrics | `0028` → `cod_queue_metrics()` | Counts: all, assigned, per operational tag, "no operational tag", `Programmati`; average age in minutes per bucket. | COD-ONLY | Aging buckets. |
| "Shipped" predicate | `0018_pl_scheduled_pending_cod_queue_shipped.sql` → `is_order_shipped(order_id, fulfillment_status)` | `fulfilled` OR a `logistics_shipments` row exists. Used to pull shipped orders out of the queue. | GENERIC (multi-source "is shipped") | Yes. |
| Workflow status derivation | `0017_pl_workflow_status_v2.sql` → `pl_order_workflow_status(status, tags, cancelled_at, financial_status, fulfillment_status, delivery_status, delivered_at)`; `derive_order_workflow_from_tags(tags)` | Priority: annullato > consegnato > confermato > da_confermare, mixing order fields and tags. | CLIENT-SPECIFIC (tag-based) — Keel must use `state_rules` | Only the *priority ordering* idea. |
| Scheduled confirmation ("Programmati") | `shopify-order-actions` actions `schedule_confirm`/`cancel_scheduled_confirm`; edge fn `orders-apply-scheduled-confirms` (cron 15 min); trigger `trg_orders_clear_schedule_on_close` (`0029`) | Operator picks a date; order leaves the queue until 00:01 local of that day; cron confirms it automatically; cancel/confirm/replace clears the schedule. | COD-ONLY (as "call back / ship on date") | Yes: deferred action with auto-clear on terminal states. |
| Operator capacity model | `20260506214233`, `20260506214947`, `20260609083356` → tables `assignment_capacity`, `assignment_exceptions`, `assignment_log` | Per operator: active flag, hours per weekday (`daily_hours[7]`, index 1 = Sunday), allowed tags, calendar exceptions (`off` / `extra` with hours). | COD-ONLY (operator pool for calls) — model itself GENERIC | Yes, the whole model. |
| Weighted round-robin picker | `20260803075222` → `assign_next_cod_operator(p_order_tags)` | Picks the operator with the largest "debt" = expected share of today's assignments minus actual. | GENERIC algorithm, COD-ONLY use | Yes (see C.2). |
| Auto-assignment entry point | `0019` → `auto_assign_cod_order(order_id, source)` | Locks the order, checks eligibility, picks operator, writes `orders.assigned_to`, `assignment_log`, `order_events`. Called by `shopify-webhook`, `shopify-sync`, sweep, backfill. | COD-ONLY | Yes. |
| 10-minute sweep / backfill | `supabase/functions/cod-auto-assign-sweep/index.ts` | Modes `sweep` (≤500 oldest unassigned queue orders), `backfill` (≤5000), `single`. Loops calling the RPC per order. | COD-ONLY | Pattern: cron catch-up for events missed by webhooks. |
| Re-assign on tag change | `20260609083356` → trigger `trg_reassign_cod_on_tag_change` BEFORE UPDATE OF tags | If the assigned operator is not allowed to handle the order's new tags, reassign (or unassign if nobody is available). | COD-ONLY (skill routing) | Skill/queue routing idea (replace tags with "queue reason"). |
| Self-claim | `0019` → `claim_cod_order(order_id)` | Any authenticated user grabs an order in queue, even if assigned to someone else. Logged `claim_self` / `reassign_self`. | COD-ONLY | Yes. |
| Admin reassign / bulk / distribute | `20260611072406` → `admin_assign_cod_order`, `20260507051716` → `admin_assign_cod_orders_bulk`, `admin_distribute_cod_orders` | Admin single/bulk reassignment or unassignment; "distribute equally" reuses the round-robin picker. | COD-ONLY | Yes. |
| Release / transfer / escalate + anti-abuse | `20260514134710`, `20260515075647` → `_can_release_cod_order`, `release_cod_order`, `transfer_cod_order`, `escalate_cod_order` | Operator can hand back an order only before the first logged call; admin always. | COD-ONLY | Yes, the "only before first contact" rule. |
| Contact attempts | `20260325084541` → `cod_contact_attempts`; UI `src/pages/OrderDetailPage.tsx` (`registerCallMutation`), `src/components/orders/CallTimeline.tsx` | Append-only log of calls (attempt_number, channel, outcome, notes) + `order_events` row `chiamata`. | COD-ONLY | Yes (as "contact attempt" entity). |
| Outcome actions | `supabase/functions/shopify-order-actions/index.ts` actions `confirm`, `mark_to_call`, `schedule_confirm`, `cancel`, `update`, `cancel_and_create`, `merge` | Confirmation replaces tags with `Confermato`; "to call" replaces tags with `Da chiamare`; cancellation strips operational tags; modification does not change the queue state. | CLIENT-SPECIFIC implementation (Shopify tag writes); COD-ONLY semantics | The *state transitions* (see C.3), not the tag mechanics. |
| Operator KPIs | `20260604160259` → `operator_efficiency_metrics(p_start,p_end)`; `20260707202823` → `get_user_order_activity`; `src/components/cc/OperatorKpis.tsx` | Handled, confirmed, cancelled, pending, conversion rate, attempts, attempts per confirmation, average handle seconds, active minutes, throughput/hour; time-on-order from activity pings. | COD-ONLY (per-operator call KPIs) / GENERIC (activity tracking) | Yes, formulas in C.4. |
| Supervisor view | `src/components/cc/SupervisorView.tsx`; `team_assigned_cod_tickets()` (`20260508202015`) | Per operator: assigned in queue, pending, confirmed today, cancelled today, bottleneck flag (>10 pending); refresh every 30 s; expandable per-operator queue. | COD-ONLY | Simple; fine to re-implement. |
| Delivery score (order) | `20260706211136` (last full body) + patches `20260706211704`, `20260706211739` → `compute_order_delivery_score(order_id)` | 0–100 probability-of-delivery score as a weighted mean of up to 17 factors, each with raw score, weight, label, severity; stored in `orders.delivery_score` + `delivery_score_breakdown`. | COD-ONLY (as a whole); several factors GENERIC | Yes, see C.5. |
| Delivery score (customer) | `20260608083447` → `compute_customer_delivery_score(contact_id)` | Exponentially decayed delivered / (delivered+cancelled+refused) ratio per contact, half-life 180 d. | GENERIC (customer reliability) | Yes. |
| Duplicate sibling orders | `20260713183739` → `get_duplicate_sibling_orders`; `20260703123043` → `apply_duplicate_sibling_factor`; `src/components/orders/DuplicateSiblingsBanner.tsx` | Finds other orders of the same customer within ±5 days sharing a product; identity by weighted field match; bidirectional score penalty + banner. | GENERIC (duplicate detection) | Yes — this is the "duplicate orders within 5 days" required by the Keel brief. |
| Postcode delivery stats | `20260608083447` → `recompute_cap_delivery_stats()` + table `cap_delivery_stats` (weekly Monday 03:00 UTC) | Delivery rate per postcode over 365 d, min 5 orders. | GENERIC | Yes. |
| Score recompute triggers | `20260608084546` (orders / attempts / spoki), `20260703123043`, `20260706070259` (order_items, skippable) | Recompute on status/tags/payment/fulfilment changes, new attempt, new WhatsApp message, cart change; bulk-import bypass flag. | GENERIC pattern | Yes, incl. `set_config('app.skip_score_recompute','on',true)` bypass. |
| Weight editor + live preview | `src/components/impostazioni/ScoringSettingsSection.tsx`; config in `app_settings.key='scoring_weights_v1'` via `get_scoring_config()` | Sliders 0–50 per factor, lookbacks, min samples, half-life, risk tags; "preview on an order" calls the compute RPC and renders the badge. | COD-ONLY UI / GENERIC pattern | Yes. |
| Preflight "checks before proceeding" dialog | `src/components/orders/OrderPreflightDialog.tsx` | Auto-opens on open queue orders; lists critical + warning factors; dismiss per session (`sessionStorage`). | COD-ONLY | Yes. |
| Recipient risk profiles | `20260914155153`, `20260915070001..4`, `20260915100001` → `customer_risk_profile`, `risk_config`, `risk_*` functions | Phone-keyed history of refused parcels from carrier billing + carrier events; tiers clean/watch/high_risk/blacklisted; manual override; score penalty; expected value; suggestion text only. | COD-ONLY | Yes, see C.6. |
| Identity linking (phones ↔ emails) | `20260915100001` → `risk_identity_edges`, `risk_identity_groups`, `risk_rebuild_identity_groups()` | Phones sharing an email (≤5 phones per email) form a transitive group; profile totals are per group; override propagates to the group. | GENERIC (customer identity resolution) | Yes. |
| Carrier billing import | `src/lib/elogyBillingImport.ts`, `import_elogy_billing_rows()` | Browser-side whitelist of 12 columns (never the customer name), 2000-row chunks, idempotent upsert, requests recompute. | CLIENT-SPECIFIC (Elogy file format) / GENERIC (privacy-preserving chunked import) | Chunking, header validation, date parsing. |
| Carrier outcome ingestion | `20260915070001..4` → `elogy_shipment_outcomes` (generated `outcome`), `elogy_ingest_outcome_event`, `elogy_register_delivery_error` | Order-of-arrival-independent fold of events into first/last delivered/return timestamps; generated outcome `refused` / `returned_after_delivery` / `return_unverified` / `delivered`. | GENERIC shape, CLIENT-SPECIFIC statuses | The least/greatest fold and the "return before any delivery = refusal" rule. |
| Risk decision log | `20260914155153` → `risk_decision_log`, trigger `trg_orders_log_risk_decision` | Records what operators did (confirm/cancel) on watch+ recipients, with p_return/EV at decision time, to recalibrate thresholds. | COD-ONLY | Yes. |
| COD fee line item helpers | `src/lib/cod-fee.ts` | Detects the COD fee line; `ensureCodFee()` adds/removes it depending on payment method. | COD-ONLY | `ensureCodFee` (parametrise the variant id and patterns). |

---

## B. Data model

### B.1 Orders columns touched by COD modules (`public.orders`)
- `payment_method` (text; `'cod'`, `'carta'`, `'prepagato'`, …), `status` enum `order_status` = `nuovo, da_confermare, assegnato, confermato, non_raggiungibile, richiamare, annullato, spedito, consegnato, reso, sostituito`. **Only `nuovo`, `assegnato`, `confermato`, `annullato`, `sostituito` are ever written by code**; `non_raggiungibile`/`richiamare` exist in the enum and in badges/filters (`src/components/orders/OrderBadges.tsx`, `SupervisorView.tsx`) but nothing sets them.
- `tags text[]` (Shopify tags; the real state carrier in this codebase).
- `assigned_to uuid` (FK `auth.users`), `confirmed_at`, `cancelled_at`, `delivered_at`, `delivery_status` (`consegnato`, `non_disponibile`, `rientrato`, …), `fulfillment_status`, `financial_status`.
- `scheduled_confirm_at timestamptz`, `scheduled_confirm_by uuid` (`20260512111438`).
- `cod_sub_status text`, `first_contact_at`, `resolution_at`, `contact_attempts_count int` (`20260325084541`) — **dead columns**: only copied forward by `cancel_and_create`/`merge`; no trigger maintains them.
- `delivery_score smallint`, `delivery_score_breakdown jsonb`, `delivery_score_computed_at` (`20260608083018`).
- `created_from_draft boolean` (draft-origin factor), `address_validation jsonb` (Google verdict), `shipping_address jsonb` (`address1, zip, city, province, province_code, country_code, phone`).
- `shopify_customer_id`, `customer_email`, `customer_phone`, `customer_name`, `replaces_order_id`, `replaced_by_order_id`.

### B.2 Queue / assignment tables
```
assignment_capacity
  id uuid pk, user_id uuid unique, is_active bool default true,
  hours_per_day numeric (legacy 0..24), work_days int[] (legacy, 0=Sun),
  daily_hours numeric[] not null default {0,8,8,8,8,8,0}   -- index 1 = Sunday … 7 = Saturday
  allowed_tags text[] not null default {5 operational tags}
  created_at, updated_at
assignment_exceptions
  id, user_id, date date, kind text check in ('off','extra'), hours numeric, note, created_at
  unique (user_id, date)
assignment_log
  id, order_id, assigned_to uuid null, assigned_at default now(),
  source text check in ('webhook','cron','backfill','manual','auto')   -- 'auto' added 2026-06-11
  reason text   -- 'auto' | 'no_available_operator' | 'claim_self' | 'reassign_self' | 'manual_claim'
                -- | 'manual_reassign_self' | 'admin_reassign' | 'admin_unassign' | 'reassign_tag_change'
                -- | 'reassign_tag_change_no_operator' | 'released_by_<uuid>' | 'transferred_by_<uuid>' | 'escalated_by_<uuid>'
  idx (assigned_to, assigned_at), idx (order_id)
cod_contact_attempts
  id, order_id fk orders on delete cascade, operator_id uuid, attempt_number int default 1,
  channel text default 'whatsapp' (UI writes 'phone'), outcome text (UI writes 'registered'), notes, created_at
order_events (shared timeline)  event_type used here: auto_assignment, assegnazione, release, transfer,
  escalation, chiamata, ordine_confermato, ordine_da_chiamare, ordine_annullato, ordine_modificato,
  programmazione_spedizione, programmazione_annullata, fulfillment_hold_release
```
Supporting indexes: `idx_orders_cod_queue ON orders (COALESCE(shopify_created_at, created_at) DESC) WHERE payment_method='cod' AND cancelled_at IS NULL AND delivered_at IS NULL`; `idx_orders_assigned_to_created`; `idx_cod_attempts_operator_created`.

RLS: capacity/exceptions readable by admin/operations/customer_care, writable by admin; `assignment_log` readable by admin only; attempts readable/insertable by admin/operations/customer_care. All mutations go through `SECURITY DEFINER` functions.

### B.3 Delivery score tables
```
app_settings (key, value jsonb)          key 'scoring_weights_v1' = {
  weights: { customer_history 35, similar_orders 12, payment_method 8→4 in code, cod_attempts 8,
             spoki_engagement 6, cart_size_mismatch 5, cap_zone 5, address_quality 5, time_elapsed 4,
             order_value 3, cart_duplicates 3, operator_override 2 (code default 20), discount 2 (unused),
             night_order 2 (code default 3), draft_origin 4, address_validation 6,
             recent_cancellations 6, duplicate_sibling_orders 8, size_mismatch_history 10 (removed) },
  similar_orders: { lookback_days 180, min_sample_size 10, max_sample 200 },
  customer_history: { half_life_days 180, min_orders_significant 2 },
  cap_zone: { min_orders 20, difficult_threshold 0.55 },
  recent_cancellations: { lookback_days 90 }, size_mismatch_history: { lookback_days 540 },
  avg_order_value 60, operator_override_tags: [] }
cap_delivery_stats (cap text pk, total_orders, delivered, cancelled, refused, returned, delivery_rate numeric(5,4), computed_at)
contacts.delivery_score smallint, delivery_score_breakdown jsonb, delivery_score_computed_at,
         orders_delivered, orders_cancelled, orders_returned, orders_refused
orders.delivery_score_breakdown = { score, base_score?, recipient_risk_tier?, total_weight, computed_at,
  factors: [ { factor, weight, raw_score?, label, severity in (positive|neutral|warning|critical), details? } ] }
```

### B.4 Recipient risk tables
```
risk_config (key text pk, value numeric, description, updated_at, updated_by)   -- all thresholds live here
elogy_billing_shipments (order_ref pk, shopify_order_number, shipping_number, completed_at, carrier,
  last_tracking_status, last_tracking_at, shipped_at, shipping_cost, cod_cost, return_cost,
  redelivery_cost, calculated_total_cost, source_file, imported_at, updated_at)
elogy_shipment_outcomes (order_ref pk, shopify_order_number, elogy_order_id, shopify_order_id,
  last_status, last_tracking_code, last_status_at, first_event_at,
  first_delivered_at, last_delivered_at, first_return_at, last_return_at,
  outcome GENERATED ('refused'|'return_unverified'|'returned_after_delivery'|'delivered'|NULL),
  outcome_at GENERATED, events_count, delivery_error_count, last_delivery_error_at,
  api_status, final_tracking_code, final_tracking_name, final_tracking_at, api_seen_at, source)
customer_risk_profile (id, phone_normalized (E.164, unique where not null),
  email_normalized (unique where phone is null), full_name,
  orders_total, orders_delivered, orders_returned, orders_third_attempt,
  return_rate GENERATED = returned/total, wasted_cost_eur, wasted_cost_estimated_eur,
  weighted_returns int, first_order_at, last_order_at, last_return_at, last_delivery_at,
  consecutive_deliveries, risk_tier check in (clean,watch,high_risk,blacklisted),
  manual_override check in (force_clean, force_blacklist) null, override_reason (required if override),
  override_by, override_at, identity_group text, linked_phones int default 1, computed_at, updated_at)
risk_audit_log (profile_id, event in (tier_change, override_set, override_cleared), old/new tier,
  old/new override, reason, actor_id, actor_label, created_at)
risk_decision_log (order_id, profile_id, risk_tier, manual_override, orders_total, orders_returned,
  weighted_returns, p_return, expected_value_eur, score_base, score_final,
  decision in (confermato, annullato, altro), decision_detail, actor_id; unique (order_id, decision))
risk_recompute_state (singleton: requested_at, last_run_at, last_result jsonb, billing_rows,
  billing_max_completed_at, last_import_at, last_import_file, identity_edges_at)
risk_identity_edges (phone_e164, email_norm, first_order_at, last_order_at; pk both)
risk_identity_groups (phone_e164 pk, group_key, members, computed_at)
```

---

## C. Algorithms (pseudo-code)

### C.1 Queue eligibility and ordering

```
is_cod_queue_order(o):
  o.payment_method = 'cod'
  AND o.cancelled_at IS NULL
  AND o.status NOT IN ('annullato','sostituito')
  AND coalesce(o.shopify_created_at, o.created_at) >= DATE '2025-01-01'        -- client cutoff
  AND NOT is_excluded_from_counts(o.tags)       -- tag 'annullato per variazione' (replacement chain)
  AND pl_order_workflow_status(o.status, o.tags, o.cancelled_at, o.financial_status,
                               o.fulfillment_status, o.delivery_status, o.delivered_at) = 'da_confermare'
  AND NOT is_order_shipped(o.id, o.fulfillment_status)   -- fulfilled OR logistics_shipments row
  AND (o.scheduled_confirm_at IS NULL OR o.scheduled_confirm_at <= now())

pl_order_workflow_status(...):      -- priority chain
  if cancelled_at or status in (annullato,sostituito) or financial in (voided,refunded)
     or any tag like 'annullato%' / 'rientrat%' / 'da annullare'            -> 'annullato'
  elif delivered_at or delivery_status = 'consegnato'                        -> 'consegnato'
  elif status = 'confermato' or fulfillment = 'fulfilled'
       or any confirmation tag (confermato, già pagato%, variazione%, elogyv2%, vendita%, pagato%, consegnato%) -> 'confermato'
  else                                                                       -> 'da_confermare'
```
Keel mapping: replace `pl_order_workflow_status` with the canonical state (`new`/`pending_review` ⇒ in queue), the tag exclusion with `cancelled` + "replaced" flag, and the date cutoff with a tenant setting.

**Ordering.** `docs/team/05-conferma-cod.md` describes a 4-level priority (Richiesta modifica > overdue callback > 1–2 failed attempts > FIFO). **The code does not implement it.** `cod_queue_page` orders strictly by `created_at` (asc by default, desc on request), tie-break `id`; the `Programmati` view orders by `scheduled_confirm_at` asc. Priority is only approximated by the user picking a tag filter (`Richiesta modifica`, `Da lavorare`, …). Page size clamp 1..100.

Queue page algorithm (0021/0028):
```
cand = orders WHERE cheap predicates (cod, not cancelled, delivered_at null, status not in (annullato,sostituito),
                     date >= cutoff, fulfillment <> fulfilled, no logistics_shipments row, optional tag overlap,
                     scheduled filter)             -- hits partial index idx_orders_cod_queue
q    = cand WHERE NOT is_excluded_from_counts(tags) AND workflow = 'da_confermare'      -- MATERIALIZED
page = q ORDER BY sort_at, id LIMIT size OFFSET (page-1)*size
attempts = count(*), max(created_at) FROM cod_contact_attempts WHERE order_id IN page
return { orders: [{order, call_count, last_at}], total_count: count(q) }
```

### C.2 Weighted round-robin assignment

```
assign_next_cod_operator(order_tags text[] | NULL):
  today := (now() AT TIME ZONE tenant_tz)::date ; dow := extract(dow) (0 = Sunday)
  available := for each ac in assignment_capacity
      JOIN LEFT ex = assignment_exceptions (ex.user_id = ac.user_id AND ex.date = today)
      WHERE ac.is_active
        AND user still exists (auth.users.deleted_at IS NULL)        -- fix Aug 2026: dead users were always "in debt"
        AND ex.kind IS DISTINCT FROM 'off'
        AND (ex.kind = 'extra' OR ac.daily_hours[dow+1] > 0)
        AND (order_tags IS NULL OR ac.allowed_tags && order_tags)     -- skill routing
      hours_today := ex.kind='extra' AND ex.hours IS NOT NULL ? ex.hours : coalesce(ac.daily_hours[dow+1], 0)
  team_hours := Σ hours_today over available
  for each a in available:
      quota_share    := a.hours_today / team_hours                       -- NULL if team_hours = 0
      assigned_today := count(assignment_log WHERE assigned_to = a.user_id
                                              AND (assigned_at AT TIME ZONE tz)::date = today)
  N := Σ assigned_today over available
  debt(a) := quota_share * (1 + N) - assigned_today
  return argmax over available ORDER BY debt DESC, hours_today DESC, user_id ASC
```
Notes:
- `1 + N` is "the total after this assignment": the chosen operator is the one furthest below their fair share once this order is counted. Equivalent to classic smooth weighted round-robin.
- `assigned_today` counts **all** `assignment_log` rows with that `assigned_to` for the day, so manual claims, transfers and admin reassignments also consume quota; unassign rows (`assigned_to NULL`) do not.
- No per-operator cap: if only one operator is available they get everything.
- Dead-user bug fixed by the `auth.users` existence check; the FK violation used to make every assignment silently `skipped`.

```
auto_assign_cod_order(order_id, source in (webhook,cron,backfill,manual)):
  o := SELECT * FROM orders WHERE id = order_id FOR UPDATE
  if o.assigned_to IS NOT NULL: return o.assigned_to                   -- idempotent
  if financial_status in (voided, refunded): return NULL
  if NOT is_cod_queue_order(o): return NULL
  order_cod_tags := o.tags ∩ {5 operational tags} (trimmed) ; NULL if empty  -- NULL = any operator
  u := assign_next_cod_operator(order_cod_tags)
  if u IS NULL: log(order, NULL, source, 'no_available_operator'); return NULL
  UPDATE orders SET assigned_to = u, status = (status='nuovo' ? 'assegnato' : status)
  log(order, u, source, 'auto'); order_event('auto_assignment', actor NULL, "… (source)")
  return u
```
Entry points: `shopify-webhook` and `shopify-sync` call it for new/unassigned queue orders (source `webhook`); `cod-auto-assign-sweep` cron every 10 minutes (source `cron`, 500 oldest first), and the admin "Distribuisci arretrati" button (source `backfill`, 5000). Candidate query of the sweep: unassigned, status ≠ annullato, not voided/refunded, cod, not cancelled, since cutoff, not delivered, not fulfilled, `is_cod_queue_order = true`, `ORDER BY created_at ASC`.

```
trg_reassign_cod_on_tag_change (BEFORE UPDATE OF tags, WHEN tags changed):
  skip if NEW.assigned_to IS NULL, status = annullato, financial voided/refunded
  order_cod_tags := NEW.tags ∩ operational tags ; if empty: keep assignment
  allowed := assignment_capacity.allowed_tags of NEW.assigned_to
  if allowed IS NOT NULL AND allowed && order_cod_tags: keep
  u := assign_next_cod_operator(order_cod_tags)
  if u IS NULL OR u = NEW.assigned_to: NEW.assigned_to := NULL; log(NULL,'auto','reassign_tag_change_no_operator'); event
  else NEW.assigned_to := u; log(u,'auto','reassign_tag_change'); event('auto_assignment')
```

Claim / admin / transfer rules:
```
claim_cod_order(order):                         -- any authenticated user (role check dropped on 2026-07-08)
  lock; if voided/refunded or NOT is_cod_queue_order -> error 'order_not_in_cod_queue'
  if assigned_to = me -> {ok, reassigned:false, 'already_yours'}
  assigned_to := me; status nuovo->assegnato; log('manual', existing IS NULL ? 'claim_self' : 'reassign_self')
  -- no "your personal queue must be empty" constraint (removed 2026-05-21)

admin_assign_cod_order(order, user|NULL):       -- admin only
  requires order has ≥1 operational tag (older criterion, NOT is_cod_queue_order), not annullato/voided/refunded
  user must exist in assignment_capacity (any is_active)
  assigned_to := user; status: NULL & assegnato -> nuovo ; user & nuovo -> assegnato
  log('manual', user ? 'admin_reassign' : 'admin_unassign'); order_event('assegnazione', actor admin)
admin_assign_cod_orders_bulk(ids, user): loop, per-order try/catch, returns {ok, skipped}
admin_distribute_cod_orders(ids): for each id: u := assign_next_cod_operator() (no tag filter); admin_assign(id,u)

_can_release_cod_order(order):
  admin -> true
  else: orders.assigned_to = me AND count(cod_contact_attempts WHERE order_id) = 0
release_cod_order:  check; assigned_to := NULL; log('manual','released_by_<me>'); event 'release'
transfer_cod_order(order, target): check; target must have assignment_capacity.is_active = true;
                    assigned_to := target; log('transferred_by_<me>'); event 'transfer'
escalate_cod_order: check; assigned_to := NULL; log('escalated_by_<me>'); event 'escalation'
                    -- the first version also added tag 'Escalation'; the 2026-05-15 version only unassigns
```
Anti-abuse rule, precisely: once an operator has inserted **any** `cod_contact_attempts` row for the order, only an admin can release/transfer/escalate it. The UI disables the button with the message "Hai già registrato una chiamata: solo un admin può ora trasferirlo".

### C.3 Attempt / outcome state machine (as implemented)

Documented in `05-conferma-cod.md` as outcomes {confirmed, no answer, call back, cancelled, modification} with "3rd attempt → `non_raggiungibile`". **Implemented reality:**

```
Register call (OrderDetailPage.registerCallMutation):
  n := max(attempt_number) + 1 for the order (client-side read, not atomic)
  INSERT cod_contact_attempts {order_id, operator_id = me, attempt_number = n, channel 'phone', outcome 'registered'}
  INSERT order_events {event_type 'chiamata', description '(nª chiamata)', metadata {channel, attempt_number}}
  -> AFTER INSERT trigger recomputes the delivery score (factor cod_attempts: raw = max(20, 80 - 20n))
  -> after the first row the operator loses release/transfer/escalate rights
  NO state change, NO automatic 'non_raggiungibile' after 3 attempts, NO per-attempt outcome enum.
```
Outcomes are realised by order actions in `shopify-order-actions`:
```
confirm:        block if pending backorders (HTTP 409 AWAITING_STOCK); release Shopify fulfilment holds if any;
                tags := ['Confermato'] + Vendita tags  (Shopify PUT then local); status := confermato;
                confirmed_at := now(); scheduled_confirm_at/by := NULL; event 'ordine_confermato'
mark_to_call:   tags := ['Da chiamare'] (replaces everything); event 'ordine_da_chiamare'   (= "to call" / back in queue)
schedule_confirm(date): scheduled_confirm_at := 00:01 Europe/Rome of date; event 'programmazione_spedizione'
                -> order leaves the queue (is_cod_queue_order false while future) and appears under 'Programmati'
                -> cron orders-apply-scheduled-confirms (15 min): for due orders not confirmed/cancelled:
                   Shopify tags := 'Confermato', local confirm
                -> trg_orders_clear_schedule_on_close: BEFORE UPDATE when scheduled_confirm_at not null AND
                   (cancelled_at set OR status in (annullato, sostituito, confermato)) → clear schedule
cancel_scheduled_confirm: clear; event 'programmazione_annullata'
cancel:         GET Shopify order; if 404 → local-only cancel (status annullato, cancelled_at, voided, total 0,
                assigned_to NULL, tag 'Eliminato su Shopify'); else refund/cancel on Shopify;
                remove CANCEL_REMOVE_TAGS = operational tags + Confermato, Carta da confermare, Pronto da spedire,
                Attesa stock, Momoka confermato, Conferma WhatsApp; add chosen cancellation tag; event 'ordine_annullato'
update (modify):edits address/phone/items; tags unchanged unless add_confirmed_tag (then ['Confermato'] + Vendita);
                order stays in the operator's queue (rule of 2026-08-07); event 'ordine_modificato'
cancel_and_create / merge (sostituito): new order inherits assigned_to, first_contact_at, contact_attempts_count;
                old gets status 'sostituito' + tag 'Annullato per variazione' (excluded from queue and KPIs)
```
Derived operator-facing states (badges): `da_confermare` (default), `richiamare`/`non_raggiungibile` (enum only), `confermato`, `annullato`. The `Programmati` bucket is the de-facto "call back later" state.

Recommendation for Keel's `addon.cod`: implement the documented machine explicitly — `attempt.outcome ∈ {confirmed, no_answer, call_back(at), cancelled, modified}`, counter on the queue item, `unreachable` after N (tenant setting, default 3) `no_answer`, `call_back_at` as a first-class priority input — instead of inferring it from tags.

### C.4 Operator KPIs

`operator_efficiency_metrics(p_start, p_end)` (admin, `20260604160259`):
```
actions(uid, order_id, ts) := cod_contact_attempts ∪ order_events with actor and event_type in
   {chiamata, spoki_message_sent, spoki_template_sent, ordine_confermato, ordine_annullato, ordine_modificato,
    sconto_applicato, ordine_creato, ordine_sostituito, programmazione_spedizione, elogy_push}
   ∪ order_internal_notes(author)
valid_orders := distinct (uid, order_id, status) excluding financial in (voided, refunded, partially_refunded) and status sostituito
ordini_gestiti   = count(valid_orders)
confermati       = count where status = confermato ; annullati = status annullato ; in_attesa = the rest
conversion_rate  = 100 * confermati / (confermati + annullati)             -- no-answers excluded from denominator
tentativi        = count(cod_contact_attempts by operator in window)
tentativi_per_conferma = tentativi / confermati
avg_handle_seconds = avg over orders with ≥2 actions of min(max(ts) - min(ts), 4h)
active_minutes   = get_user_active_minutes (presence sessions)
throughput_per_hour = (confermati + annullati) / (active_minutes/60)
```
`get_user_order_activity(p_start,p_end)`: `order_minutes` = Σ per (user, order) session lengths built from `user_activity_pings` with a 5-minute gap rule (+1 min per session), `orders_viewed` = distinct order_id pinged, `orders_completed` = distinct orders with `ordine_confermato|annullato|modificato|sostituito` by the actor. Shown as chips "Tempo su ordini / Visti / Completati %".

Today widgets (`OperatorKpis.tsx`): my assigned queue orders split by the 5 tags (same predicate, future-scheduled excluded), confirmed today (`confirmed_at >= start of day local`), cancelled today, my attempts today. `SupervisorView.tsx`: for each `customer_care`/`operations` user → assigned (in queue), pending (assigned & status in assegnato/da_confermare/non_raggiungibile/richiamare), confirmed/cancelled today, bottleneck badge when pending > 10; refetch 30 s; row expands into that operator's `MyQueue`.

Queue health (`cod_queue_metrics`): `counts.{all, assegnati, <tag>…, 'Senza tag operativo', Programmati}`, `aging_mins.<bucket>` = round(avg(now − created_at) in minutes).

### C.5 Delivery score

**Combination.** Weighted arithmetic mean over the factors that "fire":
```
score_sum := 0 ; weight_sum := 0
for each factor f that contributes: score_sum += raw_f * w_f ; weight_sum += w_f
final := weight_sum > 0 ? clamp(round(score_sum / weight_sum), 0, 100) : 50
```
Weights are **not** normalised to 100; they are relative (sliders 0–50). A factor that is informational only (e.g. payment COD, "no cancellations", "Google validation not run", "new customer") is appended to `factors` with `weight` shown but **does not** enter either sum. Factors with raw score < current mean pull the score down proportionally to their weight.

Post-processing chain on every write:
1. `compute_order_delivery_score` writes score + breakdown.
2. `apply_duplicate_sibling_factor` (called by the triggers right after) rebuilds the mean from the stored breakdown (`raw_score` defaults to 60 for factors lacking it), replaces the `duplicate_sibling_orders` factor with the accurate product-aware one, and writes again — also for every sibling (bidirectional).
3. `trg_orders_apply_recipient_risk` (BEFORE INSERT/UPDATE OF delivery_score, delivery_score_breakdown) takes the written value as `base_score`, applies the recipient-risk penalty, appends a zero-weight `recipient_risk` factor and stores `base_score` + `recipient_risk_tier` in the breakdown. Later re-runs start again from `base_score` when the score was not changed by the writer.

**Triggers:** `trg_orders_recompute_score` AFTER INSERT OR UPDATE OF `delivery_status, financial_status, status, tags, confirmed_at, cancelled_at, created_from_draft` on orders; AFTER INSERT on `cod_contact_attempts`; AFTER INSERT on `spoki_conversations`; AFTER INSERT/UPDATE/DELETE on `order_items` (bypass with `set_config('app.skip_score_recompute','on',true)` during bulk backfills, then one recompute at the end — `backfill_order_items`). All wrapped in EXCEPTION blocks that only `RAISE NOTICE` so a scoring failure never blocks the order write. Manual: Settings → Scoring preview and the ↻ button call the RPC directly. Weekly cron Monday 03:00 UTC → `recompute_cap_delivery_stats()`.

**Customer matching** (used by several factors): sequential, index-friendly — `contacts.shopify_customer_id = order.shopify_customer_id` → `lower(email)` → phone digits (only if ≥ 9 digits). The matched contact's keys (or the order's) become `v_match_shopify_id / v_match_email / v_match_phone_digits` for history queries.

**Factors** (defaults from the live function; `w` = default weight; raw ∈ 0..100; "G" = generic, "S" = shoe/client-specific, "C" = COD-specific):

| # | factor | w | inputs | raw score | fires when | class |
|---|---|---|---|---|---|---|
| 1 | `customer_history` | 35 | `contacts.delivery_score` | = customer score (see below) | contact found and score not null | G |
| 2 | `draft_origin` | 4 | `orders.created_from_draft` | 30 (warning) | draft origin | G (Shopify draft) |
| 3 | `payment_method` | 4 | `payment_method` | 90 (positive) | prepaid (anything not cod/unknown/empty) — COD only listed, no contribution | G |
| 4 | `cod_attempts` | 8 | n = count attempts | `max(20, 80 − 20·n)`; warning if n ≥ 3 | n > 0 | C |
| 5 | `spoki_engagement` | 6 | WhatsApp messages on the order (in/out) | inbound > 0 → 85; else `max(10, 60 − 10·outbound)` | outbound > 0 | G (MessagingChannel engagement) — Spoki-specific source |
| 6 | `time_elapsed` | 4 | minutes since created | `max(20, 90 − 15·days)`; warning if > 72 h | not confirmed and status ∉ (annullato, consegnato) | C/G |
| 7 | `cart_size_mismatch` | 5 | per product title: distinct numeric sizes parsed from `variant_title` | 30 (warning) | any product with ≥ 2 sizes | S (generalise to "same product, multiple variants") |
| 8 | `cart_duplicates` | 3 | per product title: Σ quantity | 45 (neutral) | any product with qty ≥ 3 | G |
| 9 | `address_quality` | 5 | phone digits < 9; address1 missing or < 5 chars; zip missing; **IT**: zip !~ `^[0-9]{5}$`; city empty or contains ≥ 4 digits; **IT**: province/province_code missing | all ok → 85 (positive) else 15 (critical) | shipping_address not null | G with country-specific validators (IT rules are S) |
| 10 | `address_validation` | 6 | `orders.address_validation` (Google Address Validation API) | CONFIRMED → 95 (70 if replaced/spell-corrected); UNCONFIRMED_BUT_PLAUSIBLE → 45; UNCONFIRMED_AND_SUSPICIOUS → 10; other → 40; −10 per missing component, floor 5 | verdict present (else listed, weight 0) | G (optional external) |
| 11 | `cap_zone` | 5 | `cap_delivery_stats[zip]` | `round(100·delivery_rate)`; severity ≥0.75 positive, ≥0.55 neutral | sample ≥ `cap_zone.min_orders` (20) | G |
| 12 | `similar_orders` | 12 | other orders, same zip, same payment method, last 180 d, with a known outcome, newest 200 | `round(100 · delivered / sample)` (cancelled/refused count as non-delivered) | sample ≥ 10 | G |
| 13 | `order_value` | 3 | `total` vs config `avg_order_value` (60) | 40 (warning) | total > 2 × AOV (code); UI help still says >3x or <0.3x — stale; the June version computed AOV over 90 days | G (compute AOV per tenant) |
| 14 | `night_order` | 3 | local hour of creation | 35 (neutral) | hour ≥ 23 or < 6 | G |
| 15 | `operator_override` | 20 (code) / 2 (seed) | order tags ∩ `operator_override_tags` | 5 (critical) | any match | G (as "manual risk flag") |
| 16 | `recent_cancellations` | 6 | matched customer's cancelled orders in last 90 d; same-product overlap by product title | `max(5, 60 − 15·n)`, −15 more (floor 5) if any shares a product; critical ≤ 20, warning ≤ 40 | n > 0 (0 → listed as positive, no contribution) | G |
| 17 | `duplicate_sibling_orders` | 8 | `get_duplicate_sibling_orders` | none → 100 (positive, contributes); same variant → 15 (critical); same product, other variant → 40 (warning) | always (after step 2) | G |
| — | `size_mismatch_history` | 10 | see below | 10 / 25 / 30 / 90 | **removed from the live function on 2026-07-06** (variables still declared, no block); still described in docs | S |
| — | `recipient_risk` | 0 | risk tier | penalty applied to the final score, not a weighted factor | always | C |

Customer score (`compute_customer_delivery_score`, half-life default 180 d):
```
matched := orders of the contact (shopify_customer_id OR lower(email) OR phone digits ≥ 9)
bucket(o) := delivered if delivery_status='consegnato'
           | refused   if delivery_status in (non_disponibile, rientrato)
           | cancelled if status=annullato or cancelled_at or financial in (voided, refunded)
           | other (ignored)
w(o) := exp(−ln2 · age_days(o) / half_life)                       -- 1.0 today, 0.5 at 180 d, 0.25 at 360 d
if count(matched) < min_orders_significant (2): score := NULL (factor not used; label "new customer")
elif Σw(delivered+cancelled+refused) > 0: score := clamp(round(100 · Σw(delivered) / Σw(delivered+cancelled+refused)))
else score := 60
also stores counts delivered/cancelled/refused and returns (returns table, status ∉ rejected/cancelled)
```

Duplicate sibling detection (`get_duplicate_sibling_orders`, the generic piece Keel needs):
```
window := orders with created_at within ±5 days of this order, excluding this order, its replaces/replaced_by,
          cancelled (status annullato / cancelled_at / voided / refunded) and tag 'annullato per variazione'
identity_score(w) := 3·[same shopify_customer_id] + 3·[same lower(trim(email))]
                   + 3·[last 9 digits of phone equal, both ≥ 9 digits]
                   + 1·[normalised address1 equal]   -- lower, strip punctuation, collapse spaces, drop leading "<city> "
                   + 1·[same zip] + 1·[same lower(city)]
candidates := window WHERE identity_score ≥ 3
line matching (non-product lines excluded by regex commissione|contrassegno|assicuraz|box misterios|mystery box):
  same_variant := same shopify_variant_id OR same sku OR (same lower(product_title) AND same numeric size)
  same_product := same lower(product_title)
return candidates WHERE same_product, with match_type = same_variant ? 'same_variant' : 'same_product'
```

Size-vs-history factor (documented; removed from live; algorithm from `20260706205144`):
```
current_sizes := distinct 2–3 digit numbers parsed from variant_title of this order's product lines
past := variant sizes from the matched customer's non-cancelled orders in the last 540 d
dominant_size, dominant_count, history_total ; dominance := dominant_count / history_total
match := current_sizes ∩ past_sizes ≠ ∅
if not match:  history ≥ 3 and dominance ≥ 0.75 → raw 10, critical, weight w
               history ≥ 3                       → raw 25, warning,  weight 0.6·w
               else                              → raw 30, warning,  weight 0.4·w
else:          raw 90, positive, weight (history ≥ 3 ? w : 0.5·w)
```
Generic equivalent for Keel: "variant option value differs from the customer's dominant historical value for the same option name" — only meaningful for size-like options; keep behind a tenant flag.

Presentation: ≥ 75 green "Consegna probabile", 40–74 amber, < 40 red (`DeliveryScoreBadge.tsx`). Preflight dialog lists `critical` then `warning` factors (skips weight-0 factors unless critical), sorted by weight; "positive" collapsed; dismissal per order in `sessionStorage` for the session.

Admin editor (`ScoringSettingsSection.tsx`): one slider 0–50 per factor in `FACTOR_META` (16 keys: the 17 above minus `size_mismatch_history`, plus nothing for `recipient_risk`), numeric inputs for similar-orders lookback/min sample, CAP min orders, half-life, comma-separated risk tags; saves by upserting `app_settings('scoring_weights_v1')`; "Anteprima su un ordine": type order number → strip `#LM-` → look up id → `rpc('compute_order_delivery_score')` → render badge with breakdown.

### C.6 Recipient risk

Config (`risk_config`, all numeric, editable in DB; UI shows them read-only):
```
tier_watch_min_returns 1 ; tier_high_risk_min_returns 2 ; tier_blacklisted_min_returns 3
decay_recent_months 12 ; decay_recent_weight 1.0 ; decay_old_weight 0.5
redemption_consecutive_deliveries 3 ; redemption_deliveries_per_return 1
penalty_watch_multiplier 0.75 / cap 65 ; penalty_high_risk 0.45 / 40 ; penalty_blacklisted 0.10 / 10
econ_failed_order_cost_eur 11.66 ; econ_delivered_margin_eur 7.50
prob_return_baseline 0.052 ; prob_return_1 0.260 ; prob_return_2 0.365 ; prob_return_3 0.459 ; prob_return_5 0.516
estimated_return_cost_eur 3.80 ; estimated_redelivery_cost_eur 3.80
identity_link_max_phones_per_email 5
```

Identity key:
```
risk_phone_e164(p) := k = norm_phone_key(p)   -- digits only, strip 39/0039, reject <6 digits or all-same
                      len(k) in 9..10 and k ~ '^[03]' → '+39'||k ; len 11..15 → '+'||k ; else NULL   -- IT-specific
risk_email_norm(e) := lower(trim(e)) if it looks like an email
recipient key := coalesce(e164(customer_phone), e164(shipping_address.phone)) ; fallback email ; NEVER the name
identity groups: edges (phone, email) from all orders; emails used with 2..5 phones connect those phones;
  connected components by iterative min-label propagation (≤ 50 iterations); group_key = smallest phone
```

Outcome per shipment (per Shopify order number):
```
events  (elogy_shipment_outcomes.outcome, prio 2): refused → returned ; returned_after_delivery | delivered → delivered
         'refused' requires a return with no earlier delivery AND first_event_at < first_return_at
         (a return as first-ever event = 'return_unverified', ignored)
billing (elogy_billing_shipments, prio 1 = wins): 'Riconsegnato al mittente' → returned ;
         'Consegnato' | 'Reso al mittente' → delivered ; other statuses → no outcome
final outcome := DISTINCT ON (order) ORDER BY prio
wasted(order)  := billing present ? return_cost + redelivery_cost
                : (returned ? estimated_return_cost : 0) + (delivery_error_count > 0 ? estimated_redelivery_cost : 0)
wasted_estimated := the non-billing part ; third_attempt := redelivery_cost > 0 or delivery_error_count > 0
```

Profile aggregation (per identity group key; recomputed under advisory lock):
```
orders_total := shipments with an outcome ; orders_delivered ; orders_returned ; orders_third_attempt
weighted_returns := floor(Σ over returned of weight(event_at)) where
    weight := event_at ≥ as_of − 12 months ? 1.0 : 0.5
consecutive_deliveries := count(delivered with order_at > order_at of the last returned shipment)
wasted_cost_eur, wasted_cost_estimated_eur, first/last_order_at, last_return_at, last_delivery_at
one profile row per phone in the group (same totals), identity_group = group_key, linked_phones = members
profiles no longer present in the history → zeroed (override kept)
```

Classification (`risk_classify`, pure):
```
if override = force_blacklist → blacklisted ; if force_clean → clean
level := weighted_returns ≥ 3 ? 4 : ≥ 2 ? 3 : ≥ 1 ? 2 : 1          -- 1 clean, 2 watch, 3 high_risk, 4 blacklisted
needed := max(redemption_consecutive_deliveries (3), weighted_returns × redemption_deliveries_per_return (1))
if level > 1 and consecutive_deliveries ≥ needed: level −= 1          -- one-step redemption
tier := [clean, watch, high_risk, blacklisted][level]
group override := blacklist beats clean beats none across the identity group
tier change → risk_audit_log('tier_change') ; open orders of changed profiles are re-penalised
   (risk_refresh_open_orders: touch breakdown of not-confirmed, not-cancelled orders of the last 60 days)
```

Score penalty (`risk_penalized_score`, pure):
```
final := tier = clean ? base : clamp(min(round(base × multiplier[tier]), cap[tier]), 0, 100)
   watch: ×0.75 cap 65 ; high_risk: ×0.45 cap 40 ; blacklisted: ×0.10 cap 10
```

Expected value (`risk_estimate`, pure):
```
p := highest prob_return_N with N ≤ weighted_returns (else baseline)
     if the tier was lowered by redemption/override, use the tier's minimum returns instead
EV := round((1 − p) × margin − p × failed_cost, 2)                 -- e.g. tier ≥3: 0.541×7.50 − 0.459×11.66 = −1.29 €
risk_multiple := p / baseline (e.g. 0.459/0.052 = 8.8) ; break_even_p := margin / (margin + cost) = 0.391
suggest_cancel := tier = blacklisted AND (override = force_blacklist OR EV < 0)
```
`shouldSuggestCancel()` in `src/lib/recipientRisk.ts` double-checks `tier === 'blacklisted' && suggest_cancel` and the UI renders text only — no button, no automation, nothing customer-facing.

Assessment of an order (`risk_assess_recipient(customer_phone, shipping_phone, email, base_score)`): no key → `verifiable=false`; key but no profile → `has_history=false`, tier clean; email-only orders fall back to the profile of the phones linked to that email (≤5). Returns tier, counts, rates, wasted cost (real + estimated), weighted returns, consecutive deliveries, `redeemed` flag, base/final score, reason/summary text, `p_return`, EV, risk multiple, break-even, `suggest_cancel`, `data_as_of`, `linked_phones`, plus `orders_all` (all orders of the group incl. those without outcome) in `get_order_recipient_risk`.

Operations: `import_elogy_billing_rows` (admin/ops, ≤5000 rows/call, idempotent on `order_ref`, sets `requested_at`), `request_risk_recompute`, cron `*/5` → `risk_recompute_if_requested()` (runs if requested or new carrier outcomes since last run), nightly `02:40 UTC` full recompute (decay roll-over), `set_order_recipient_risk_override(order, force_clean|force_blacklist|NULL, reason ≥ 5 chars)` (admin/ops; audit; refresh open orders; schedules recompute so the group aligns), `get_orders_recipient_risk(ids ≤ 200)` for list badges, `trg_orders_log_risk_decision` writes `risk_decision_log` when a watch+ recipient's order is confirmed/cancelled/replaced.

UI rules (memory constraint): only `high_risk` and `blacklisted` get colour/badge (`AR`, `BL`); `clean`/`watch` are invisible in lists; blacklisted rows get diagonal hatching; `orders_total` (shipments with outcome) and `orders_all` are never conflated.

---

## D. Client-specific things to drop or re-parametrise

1. **Tag-driven state.** The 5 operational tags (`Da chiamare`, `Richiesta modifica`, `Da lavorare`, `Potenziale Double Type`, `Da confermare`), confirmation tags (`Confermato`, `Momoka confermato`, `Conferma WhatsApp`, `Già pagato`, `Variazione`, `ElogyV2`, `Vendita *`, `PAGATO*`), `Attesa stock`, `Escalation`, `Annullato per variazione`, `Eliminato su Shopify`, `Carta da confermare`, `Pronto da spedire`. In Keel the queue predicate must read the canonical order state (`new`/`pending_review` + `payment_method = cod`), `allowed_tags` becomes "queue reasons/skills", and the "modification requested / escalation / duplicate suspect" flags become queue-item attributes.
2. **Shopify tag writes as state transitions** (`shopify-order-actions` PUT `orders/{id}.json` with the full tag string) and the Elogy Flow that re-imports anything tagged `Confermato`. Keel writes state locally and optionally syncs a tag through the adapter.
3. **Hard-coded cutoff** `>= '2025-01-01'` in the queue predicate, sweep and metrics.
4. **Timezone** `Europe/Rome` in assignment (today/dow), scheduled confirmation (00:01 Rome), night-order factor, KPI "today". Use the tenant timezone.
5. **Italian phone normalisation**: `norm_phone_key` strips `39`/`0039`; `risk_phone_e164` adds `+39` to 9–10 digit numbers starting with 0/3. Replace with libphonenumber + tenant default country.
6. **Italian address rules** in `address_quality`: 5-digit numeric zip, mandatory province, `country_code` defaulting to `'IT'`. Make validators per country.
7. **Shoe sizes**: size parsed as the digits of `variant_title` (2–3 digits), `cart_size_mismatch` / `size_mismatch_history` wording ("paia", "scarpa"), `cart_duplicates` threshold tuned for pairs. Generalise to variant option values.
8. **Non-product line regex** `(commissione|contrassegno|assicuraz|box\s*misterios|mystery\s*box)` and the COD-fee variant id `<variant-id>` / €3.95 / title "Commissione pagamento alla consegna" (`src/lib/cod-fee.ts`). In Keel the COD fee is a tenant setting of the add-on.
9. **Spoki** (`spoki_conversations`, `spoki_engagement` factor, Spoki triggers). Keep the factor behind the generic `MessagingChannel` engagement (inbound/outbound counts per order).
10. **Elogy** billing file (12 columns, Italian statuses `Consegnato`, `Riconsegnato al mittente`, `Reso al mittente`), Elogy webhook statuses `delivered`/`return`/`delivery_error`, API codes 19 / 19.1 / 21, `elogy_webhook_logs` trigger, order ref regex `^(?:EL)?#?LM-?([0-9]+)$`. Keep only the normalised `shipment_outcome` (delivered / refused / returned_after_delivery / unverified) fed by the `CarrierProvider`/`WarehouseProvider` interfaces and a generic CSV import.
11. **Euro / fixed economics**: `econ_failed_order_cost_eur 11.66`, margin 7.50, estimated costs 3.80, `avg_order_value 60`, `it-IT` currency formatting in `recipientRisk.ts`. Per-tenant currency and `CostSetting`.
12. **Google Address Validation** factor: optional integration; keep the verdict mapping but make the provider pluggable.
13. **Single-row global config** (`app_settings.scoring_weights_v1`, `risk_config`) and Supabase `auth.uid()` / `has_role()` gates. Keel: per-tenant rows + RLS + permission matrix.
14. **Order numbers** `#LM-…` parsing in the scoring preview and billing import.
15. **`delivery_status` Italian values** (`consegnato`, `non_disponibile`, `rientrato`) used as outcome buckets in customer score, CAP stats and similar orders — map to the canonical shipment state.
16. **Dead/inconsistent pieces not to port as-is**: `cod_sub_status`, `first_contact_at`, `resolution_at`, `contact_attempts_count` (never maintained); enum values `non_raggiungibile`/`richiamare` (never written); `team_assigned_cod_tickets` and `admin_assign_cod_order` still using the old tag criterion; `size_mismatch_history` dropped from the live function but still in the docs; `order_value` help text out of sync with the code; `discount` weight in the seed with no factor.

---

## E. Pure utility functions worth reusing

SQL (IMMUTABLE / pure):
- `norm_phone_key(text)` — digits only, reject < 6 digits or repeated digit, strip country prefix (`20260907105050`). Re-implement with libphonenumber in `packages/core`, keep the "reject junk numbers" rules.
- `norm_email_key(text)`, `norm_name_key(text)`, `norm_address_key(jsonb)` (`address1|zip|city`, min 5 chars + zip), `norm_namezip_key` — the customer-history matching keys (memory `customer-order-history.md`).
- `risk_return_weight(return_at, as_of, cfg)`, `risk_level_from_returns(weighted, cfg)`, `risk_classify(weighted, consecutive, override, cfg)`, `risk_penalized_score(score, tier, cfg)`, `risk_band_probability(returns, cfg)`, `risk_estimate(tier, weighted, override, cfg)` — all config-driven and side-effect free; port 1:1 as TypeScript functions in `addon.cod` with unit tests (expected: tier 3 → EV −1.29 € with default config).
- Exponential decay `exp(-ln2 * age_days / half_life)` and the weighted-mean combination (`Σ raw·w / Σ w`, clamp 0..100, default when no weight).
- `assign_next_cod_operator` debt formula (`quota_share * (1 + N) - assigned_today`, ties by hours then id) — port as a pure `pickOperator(available[], assignedToday{}, hoursToday{})`.
- Address normalisation from `get_duplicate_sibling_orders` (lower, strip punctuation, collapse whitespace, drop leading city) and the identity-score rule (3/3/3/1/1/1, threshold 3).
- Carrier-event fold in `elogy_ingest_outcome_event`: `first_* = least(old, new)`, `last_* = greatest(old, new)`, order-of-arrival independent; generated `outcome` CASE (refusal = return with no earlier delivery and a prior tracking event).
- Min-label propagation for connected components (`risk_rebuild_identity_groups`).
- `is_excluded_from_counts(tags)` → becomes `isReplacedOrder(order)` in Keel.
- `pl_order_workflow_status` priority chain → template for the canonical-state resolver (cancelled > delivered > confirmed > pending).

TypeScript (`src/lib`):
- `elogyBillingImport.ts`: `pickBillingColumns` (whitelist before upload), `validateBillingHeaders`, `chunk(rows, size)`, `parseBillingDate` (DD/MM/YYYY HH:MM, never US-reinterpreted), `summarizeBilling` (counts by status + date range), `readBillingSheet` (CSV as raw text, XLSX with `cellDates:false`). Generic for any carrier/3PL settlement import.
- `recipientRisk.ts`: `shouldSuggestCancel` (defensive double check), `formatWastedCost` (real vs estimated split), `formatReturnsHistory`, `formatOrdersAllLine`, `formatLinkedPhonesLine`, `formatSignedEur` (typographic minus) — presentation helpers to translate and move under i18n/Intl.
- `cod-fee.ts`: `isCodFeeLineItem` (pattern list → tenant config) and `ensureCodFee(lineItems, paymentMethod, feeVariantId)` (idempotent add/remove of the fee line).
- `codQueue.ts`: `applyCodQueueFilter(query, tag)` — the "cheap predicates first, computed-column predicate last" composition for PostgREST; keep the idea when exposing a `is_in_cod_queue` computed column via Drizzle/SQL.
- `OrderPreflightDialog.tsx`: factor triage (`critical` → `warning` → `positive`, skip weight-0 non-critical, sort by weight) and per-session dismissal.

Patterns (not code) to carry over: single SQL predicate reused by list/counters/assignment/client; `FOR UPDATE` + idempotent return in assignment; append-only `assignment_log` with `source` + free-text `reason` + `order_events` mirror; triggers that recompute derived scores but swallow errors (`RAISE NOTICE`); session-level bypass flag for bulk imports; advisory lock + "mark start first, re-run if new input arrived during the run" for the risk recompute; decision log capturing the model's inputs at decision time for later threshold calibration.
