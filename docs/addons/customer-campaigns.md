# Add-on: Customer campaigns (`addon.customer_campaigns`)

Status: **v1 in development** (`packages/config/src/addon-versions.ts`). The super-admin console shows it but cannot switch it on for a new store until v1 is released. On the demo it is on for Northwind Apparel; Harbor Home shows the plain segments a store gets without it.

Brief: CLAUDE.md §8.1. Issues: #38 (campaigns and control groups are an add-on), #34 (approval, scheduling, send queue, sequences). **The larger redesign in #73** (a step-by-step wizard, templates, Mailchimp/Omnisend connectors…) is waiting for the product owner's decisions and is *not* built. This document describes the existing v1 only.

## What it does

Without the add-on, segments are plain: no control field, no groups, and exports and audiences include every member. With it:

- **Control group on segments.** A segment can keep a holdout percentage. Each customer's group (treated or control) is assigned stably from a hash of the segment and the customer, so it never changes between evaluations. Segment exports carry a group column, and ad audiences leave the control group out.
- **Campaigns** to a segment over email, SMS or WhatsApp, or "sent from another tool": the product then only records who was in each group, and the message goes out from the store's email tool via the segment export. A campaign is either one-off or an always-on **sequence**, which enrols new segment entrants as they arrive and keeps each one's permanent group.
- **Workflow.** Draft → test send to the team (never an exposure) → preview: who would receive it, who is left out and why (no consent, suppressed, over the frequency cap, open order, already in another measurement, control group), and the minimum detectable effect → submit → approval by an owner, an admin or a role with `approve_customer_campaign` (never by the author, except the owner) → schedule (a date and time in the store's time zone, or as soon as the send window allows) → send. You can reopen a campaign at any stage before it starts; approvers get notifications.
- **Send queue.** One message per campaign × customer × channel, handed to the provider with an idempotency key. It sends in batches, within the store's send window and the per-minute throttle per channel. Transient errors are retried with backoff. Suppression and consent are checked again at send time. A worker killed mid-batch resumes without sending twice. Without a worker, the queue moves on page loads.
- **Results (intention to treat).** Every exposed customer counts in their group, even when their message failed. The results compare confirmed, non-cancelled orders placed within the attribution window: conversion difference with its p-value, incremental orders, incremental margin with a 95% interval, cost, net incremental margin and ROI, plus code redemptions. A verdict badge sums it up: no control group, running, no clear effect, or a significant effect.
- **Recipients.** The campaign page lists every exposed customer with their group, message status and orders in the window, filtered by All / Treated / Control. The control group is something you can look at, not only a number.
- **Delivery.** WhatsApp campaigns go through Spoki when `addon.whatsapp_spoki` is on and connected (on the demo, its simulated account). Email and SMS go through the simulated messaging channel: no email or SMS provider is connected yet. The campaign page and form say which one applies ("Via Spoki (simulated account)", "Simulated channel").
- **Settings** (`manage_settings`): frequency cap (messages per customer per N days), send window, per-minute throttle per channel, and the measurement lock (a customer in an open measurement is not messaged by another campaign).

Permissions: marketing creates and submits campaigns. Owners and admins approve and change the settings. A viewer reads campaigns and their recipients. Operations and customer care have no access. Every page, action and job checks the add-on: without it, the pages are 404 and the job sends nothing.

## Try it on the demo

Password for every demo user: `hullwise-demo-2026` (or `HULLWISE_DEMO_PASSWORD` on a hosted demo).

1. **History.** Sign in as `marketing@northwind.demo`, open **Segments**, then the **Campaigns** tab. The demo has:
   - **Saldi di fine estate su WhatsApp -20%**: one-off, sent 20 days ago through Spoki to "Clienti ricorrenti" (20% control). The 10-day window is closed and the effect is significant.
   - **Win-back clienti ricorrenti -10%**: email, sent 35 days ago, significant effect, code BACK10.
   - **Newsletter di primavera**: sent from another tool. The control group shows it had no clear effect.
   - **Win-back automatico a 120 giorni**: an always-on WhatsApp sequence, active for 30 days on a live segment with a 15% control group, still measuring.
   - **Riattivazione alto valore -15%**: SMS, waiting for the owner's approval (the test has already been sent).
   - **Nuova collezione autunno** (starts the day after the seed) and **Anteprima collezione inverno** (ten days ahead): approved and scheduled.
   - **Benvenuto, secondo acquisto**: a draft on a segment without a control group, which shows the warning.
2. **A measured campaign.** Open "Saldi di fine estate su WhatsApp -20%":
   - the chips show the channel, the code ESTATE20 and "Via Spoki (simulated account)";
   - the effect badge and the four numbers (uplift in points with its p-value, incremental orders, incremental margin with its interval, net margin with cost and ROI);
   - treated vs control: customers, buyers, conversion, revenue and margin per customer;
   - **Recipients**: click **Control** to see the held-out customers (never messaged), then **Treated** to see the delivered messages and who ordered in the window. Names link to the customer page, where the segment's group badge is shown too;
   - on the right: delivery progress and statuses, the workflow (who created, tested, submitted, approved and scheduled it), and the method note.
3. **Scheduled and draft.** "Anteprima collezione inverno" says when it starts (inside the send window). "Benvenuto, secondo acquisto" is editable and warns that its segment has no control group.
4. **A campaign from start to finish** (two windows: marketing and owner):
   - as the owner, open **Campaigns → Settings** if you want it sent immediately: send window 0–24, frequency cap 100, measurement lock off, WhatsApp throttle 5000/min;
   - as marketing, click **New campaign**: segment "Inattivi da 120 giorni" (15% control), channel WhatsApp (the form says it goes through Spoki's simulated account), a message with `{first_name}` and `{code}`, a code, a 7-day window, then **Create draft**;
   - **Test send…** to a team phone: "1 test message sent". As the owner, the WhatsApp log shows it as "Test message";
   - **Preview and submit…**: the left-out customers by reason and the control group size, then **Submit for approval**. Marketing cannot approve their own campaign;
   - as the owner, open the campaign, click **Approve**, then **Schedule… → Send as soon as possible**. Reload: the progress bar moves and the campaign becomes "Sent". The groups table and the recipients appear, and the messages head the **WhatsApp → Conversations** list (the settings page's "Latest messages" leaves campaign sends out);
   - restore the settings afterwards (9–20, cap 3, lock on, 60/min).
5. **Without the add-on.** Sign in as `owner@harborhome.demo`. Segments have no holdout field, no Campaigns tab and no group column, and `/t/harbor-home/segments/campaigns` is a 404.
6. **Console.** As `superadmin@hullwise.demo`, the Northwind tenant's add-ons show "v1 in development" with its summary.

The tour is automated in `apps/web/e2e/addon-campaigns-tour.spec.ts` (desktop and iPhone 15).

## Mock vs live-ready

| Part | Today | Live-ready |
| --- | --- | --- |
| Email and SMS sends | `MockMessagingChannel`: records the send and returns an id. Nothing reaches customers | Needs a `MessagingChannel` adapter per provider (none built; see #73) |
| WhatsApp sends | Spoki's simulated account (with `addon.whatsapp_spoki`), logged in the WhatsApp log | Spoki adapter tested on fixtures, not yet on a live account |
| Send queue, throttle, window, retries, idempotency, suppression | Real, tested against the database | Same |
| Results and uplift | Real calculation on the store's orders (`campaignUplift` in `packages/core`) | Same |
| Demo history | Seed (deterministic). The WhatsApp campaign's response orders are inserted so its effect is significant at any reseed time. The WhatsApp campaign and the second scheduled campaign also reach a deployed demo through `ensureDemoSettings` (insert-only, once by name) | — |

## Release checklist (before v1 can be released)

- [ ] **Product decisions in #73** (wizard, templates, which email/SMS providers come first, Mailchimp/Omnisend…). v1 should not be released as the long-term UX before the owner decides; at minimum, decide whether v1 ships as is with "sent from another tool" plus WhatsApp.
- [ ] At least one real email or SMS provider behind `MessagingChannel`, or an explicit decision that v1 ships with "sent from another tool" plus WhatsApp via Spoki only. Today the email and SMS channels deliver nothing.
- [ ] Unsubscribe per channel once a real email or SMS provider exists: the link or STOP keyword in each message, and the provider's unsubscribe events feeding the shared suppression list (WhatsApp already does this through Spoki).
- [ ] Verify the statistics on a real store's volume. The minimum detectable effect shown in the preview should drive a warning when the control group is too small.
- [ ] Load test the send queue on the hosted worker: throttle per tenant and channel, many tenants sending at once.
- [ ] Consent: confirm that `accepts_marketing` from Shopify is the right consent signal per channel (email vs SMS vs WhatsApp) for EU stores.
- [ ] Flip `addon.customer_campaigns` v1 to `released` in `addon-versions.ts`. Billing (99 USD/month, `MODULES` in `packages/config`) then starts for active tenants.
