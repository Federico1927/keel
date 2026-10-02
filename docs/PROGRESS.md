# Progress

Stato aggiornato da Claude Code a ogni fase (CLAUDE.md §1). Alla ripresa di una sessione: rileggere `CLAUDE.md`, questo file e `docs/DECISIONS.md`, poi continuare dalla prima fase non completata.

| Fase | Stato | Note |
| --- | --- | --- |
| Studio | fatta | `docs/reference/INVENTORY.md` + note dettagliate in `docs/reference/study/` |
| 0 | fatta | Monorepo pnpm+turbo, Next 15, Drizzle, Postgres 16 di sistema (Docker non disponibile), next-intl en/it/es, Auth.js password + magic link, login in 3 lingue, lint/typecheck/test/build verdi |
| 1 | fatta | Contesto tenant da slug + appartenenza, guardie pagina/azione (ruolo × modulo), shell applicativa con navigazione filtrata, impostazioni tenant, utenti e ruoli, registro attività, audit diff-only, suite generica di isolamento RLS su ogni tabella con `tenant_id` (29 test verdi), e2e permessi |
| 2 | fatta | Enum canonici e motore `state_rules` in core (test), schema di dominio completo (35 tabelle, tutte con RLS), interfacce adapter + mock con simulazione webhook/errori, seed deterministico (15k + 6k ordini in ~40 s), pagina regole di stato con anteprima su 50 ordini |
| 3 | fatta | Lista ordini con ricerca server-side (numero esatto o trigram), filtri, conteggi per stato, paginazione; dettaglio con timeline (autore + diff), note interne con @menzioni e notifiche, storico cliente a 3 hop, duplicati, attribuzione, spedizioni; azioni cambia stato / annulla (via adapter) / assegna; pagina spedizioni con KPI, viste ferme/eccezioni, resolver multi-fonte |
| 4 | fatta | Catalogo con opzioni dinamiche, stock per location, velocità/copertura/rischio/riordino, grafico vendite 90 giorni, prezzo e stato scritti verso l'adapter; fornitori con saldi; ordini d'acquisto con transizioni, creazione precompilata dai suggerimenti, ricevimento parziale/completo che aggiorna stock, costo e backorder |
| 5 | fatta | `orderEconomics` + P/L di periodo in core con test a mano su 3 ordini (A 51,05 / B annullato / C 68,12 → risultato operativo 79,17), servizi analytics (KPI con confronto, dashboard con finestre "running", serie giornaliere, performance prodotti, coorti), dashboard reale e pagina Analisi con tab e drill-through verso gli ordini |
| 6 | fatta | `campaignMetrics`/`trafficLight`/`recommendAction`/`suggestProductsForCampaign` in core (test), servizi campagne (economia per campagna sugli ordini attribuiti e in scope, registro giornaliero data × campagna con flag dati mancanti, suggerimenti e auto-link solo ≥ 0,95), pagine `/campaigns` (periodo, filtri, semaforo, raccomandazione con stock), dettaglio (KPI, registro, prodotti collegati con rischio e riordino, pausa/riattiva via adapter con conferma, Google in sola lettura), `/campaigns/ledger` con CSV; 3 e2e |
| 7 | fatta | Catalogo campi + regole annidate E/O (zod, profondità ≤ 3, ≤ 30 condizioni) con valutatore in memoria e compilatore SQL parametrizzato che coincidono (test di parità), profilo cliente da ordini canonici, RFM (fasce, 8 fasce di valore, matrice), holdout deterministico per (segmento, cliente, salt), libreria statistica (z-test a due proporzioni); pagine clienti (lista, dettaglio, matrice RFM → segmento precompilato), costruttore segmenti con anteprima live, valutazione, membri, esportazione CSV; 3 e2e |
| 8 | fatta | Resi: idoneità (consegna o spedizione + giorni di riserva, finestra, esclusioni per tipo prodotto, override staff con nota), righe restituibili con sconto pro quota, flusso richiesto → approvato → ricevuto → ispezionato → rimborsato/cambio/buono (o rifiutato), rientro a stock per location con movimento e write-back facoltativo, propagazione all'ordine (quota resa, rimborsi, stato pagamento, stato canonico), analisi per motivo/responsabilità/esito/prodotto, motivi per tenant; sconti: lista con stato calcolato e ordini/ricavo/margine per codice, codice singolo e pool di codici unici via adapter, dettaglio con ordini; 3 e2e |
| 9 | fatta | Adapter live Shopify (Admin GraphQL, webhook REST, OAuth app pubblica + app custom, scope per modulo), Meta (campagne, insight giornalieri, pausa/riattiva, mappa errori/rate limit) e Google Ads (GAQL, refresh token, sola lettura) testati su payload registrati senza rete (20 test); importer canonico in `services/sync` (ordini, clienti, prodotti, stock, sconti, spedizioni via resolver, attribuzione UTM/click id); endpoint webhook con risposta immediata, idempotenza, elaborazione in background; sync riprendibile con cursore e budget, riconciliazione, job pg-boss schedulati; pagina Integrazioni (stato, salute, esecuzioni, registro webhook, test, resync, simulazione) e guide in 3 lingue con badge “Da verificare”; 3 e2e |
| 10 | fatta | Console `/admin` (dashboard con MRR, tenant, fatture aperte, errori integrazione, add-on venduti; lista tenant con piano, add-on, semafori integrazioni, ordini/30gg, ultimo accesso, stato pagamenti; creazione tenant con owner, regole, slot integrazioni, abbonamento di prova e fattura di attivazione; dettaglio con checklist di setup, piano, toggle add-on con nota e data, sospensione manuale, fatture, membri, audit; fatturazione con esecuzione mensile; registro attività di piattaforma), `BillingProvider` mock + Stripe test mode via REST, sospensione automatica dopo N giorni di insoluto e riattivazione al pagamento, impersonificazione con banner e audit `impersonation`; 3 e2e |
| 11 | fatta | Pacchetto `@keel/addon-cod` separato dal core: coda di conferma con esiti (confermato, non risponde, da richiamare, modificato, annullato) e tentativi, non raggiungibile dopo N, priorità (richiami scaduti → già tentati → FIFO); assegnazione automatica round-robin pesato sulle ore del giorno con calendario e assenze; delivery score 0–100 spiegato per fattore con pesi configurabili e penalità per fascia di rischio; profili destinatari con fasce e blacklist suggerita (mai azioni automatiche); pagine coda, impostazioni, scheda nell'ordine; tick job; 13 test + 3 e2e |
| 12 | fatta | `README.md` (avvio, credenziali, struttura), `docs/ARCHITECTURE.md` (diagramma pacchetti Mermaid, modello dati, flussi webhook/sync, come aggiungere adapter e add-on), `docs/EVALUATION.md` in italiano, 82 screenshot Playwright in en e it (tenant + super-admin) generati da `pnpm --filter @keel/web screenshots`, suite e2e completa verde sulla build di produzione |

## Come riprendere

```bash
pnpm install
pnpm db:bootstrap      # solo senza Docker: crea ruoli keel_admin/keel_app e i database keel, keel_test
pnpm db:migrate && pnpm db:seed
pnpm dev               # web su :3000 + job runner
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Senza Docker il cluster PostgreSQL 16 di sistema va avviato con `pg_ctlcluster 16 main start` (password dell'utente `postgres` impostata a `postgres` per il bootstrap).

## Fase 0 — dettaglio

Fatto:
- `packages/config`: `PRODUCT_NAME`, lingue, ruoli, matrice permessi (ruolo × pagina × azione), registro moduli `core.*`/`addon.*`, piani, default neutri delle impostazioni.
- `packages/db`: schema auth + tenant + audit, ruoli DB `keel_admin`/`keel_app`, RLS su `tenant_tax_rates` e `audit_logs`, `withTenant`, migrazioni Drizzle, seed piattaforma (2 tenant, 12 utenti demo), test di integrazione su database reale.
- `packages/ui`: tema Tailwind v4 (token HSL), componenti base shadcn-style scritti a mano.
- `apps/web`: Auth.js (credenziali + magic link in console), middleware di protezione, risoluzione locale da cookie, pagina login in en/it/es con selettore lingua, test di parità delle chiavi di traduzione, e2e Playwright sul login.
- `packages/jobs`: pg-boss avviabile (`pnpm --filter @keel/jobs dev`).

Manca (previsto nelle fasi successive): layout applicativo con navigazione, pagine di modulo, adapter, seed di dominio.

## Fase 1 — dettaglio

Fatto:
- `getTenantContext(slug)`: membership verificata lato server a ogni richiesta; super-admin senza membership entra come impersonificazione (banner, audit in fase 10).
- `requirePage` / `requireAction`: pagina non raggiungibile (404) se il ruolo non la prevede o il modulo è spento, anche conoscendo l'URL (test e2e).
- Audit: `recordAudit` + `diffRecords` (ignora colonne di bookkeeping); pagina registro con paginazione server-side.
- Test di isolamento generico: per ogni tabella con `tenant_id` verifica RLS attiva + policy, popolamento del seed per entrambi i tenant, nessuna lettura/aggiornamento/cancellazione incrociata, inserimento incrociato rifiutato (42501), nessuna riga senza contesto. Le tabelle senza `tenant_id` devono essere in una allowlist esplicita.
- Pagine: dashboard (segnaposto KPI), impostazioni (generali, soglie e commissioni, aliquote per paese), utenti e ruoli (invito, cambio ruolo, disattivazione), registro attività.

## Fase 2 — dettaglio

Fatto:
- `packages/core`: `ORDER_STATUSES` e gli altri enum canonici, `deriveOrderStatus` con precedenze (fatti certi → stato manuale → spedizione → regole tenant → default piattaforma), `previewRules`, normalizzazione telefono E.164 (libphonenumber, paese del tenant), email, chiavi indirizzo e nome+CAP.
- `packages/db`: tabelle integrazioni, catalogo, clienti, ordini (con `search_blob` generato + indice trigram), spedizioni multi-fonte, regole, costi, resi, sconti e pool, acquisti, backorder, campagne, metriche ads, segmenti con holdout, notifiche; migrazione `0002`.
- `packages/integrations`: interfacce `CommercePlatform`, `AdsPlatform`, `AnalyticsPlatform`, `MessagingChannel`, `WarehouseProvider`, `CarrierProvider`; mock con firma HMAC dei webhook e `FailureScript`; cifratura AES-GCM delle credenziali.
- Seed: Northwind Apparel (IT, EUR, 15.000 ordini, 120 prodotti, 3 location, 4 fornitori, 25+6 campagne, 10% contrassegno, resi 12%) e Harbor Home (US, USD, 6.000 ordini, 60 prodotti). Stagionalità, clienti ricorrenti, duplicati deliberati, spedizioni ferme, campagne in perdita e in guadagno, ordini d'acquisto in arrivo con backorder coperti.
- UI: Impostazioni → Regole di stato ordine (CRUD + anteprima).

## Fase 3 — dettaglio

Fatto:
- `packages/services`: `recomputeOrderStatus` (unico scrittore di `orders.status`), `setManualStatus` / `clearManualStatus`, `customerOrderHistory` (chiavi forti + chiusura transitiva a 3 hop, nome+CAP solo segnalato), `duplicateSiblings`, `addOrderNote` con menzioni validate e notifiche, servizio notifiche con anti-spam. Test di integrazione su database reale.
- `packages/core`: `findDuplicateOrders`, `resolveShipmentStatus` (finale batte non finale, precedenza per fonte con finestra di freschezza, eccezioni appiccicose, mai retrocessione dallo stato terminale), helper menzioni `@[Nome](uuid)`.
- Web: `/orders` (filtri in URL, chip per stato con conteggi, vista mobile), `/orders/[id]` (DetailShell, prev/next, banner duplicati, azioni con conferma), `/shipments` (tile KPI cliccabili, viste, giorni in viaggio, fonte vincente), campanella notifiche.
- Adapter factory `getCommercePlatform` / `getAdsPlatform` in modalità mock, costruiti dal catalogo del tenant.

## Fase 4 — dettaglio

Fatto:
- `packages/core/inventory`: `stockVelocity`, `reorderSuggestion` (arrotondato al pack), `variantCapacity`, `movingAverageCost`, `backorderStatus`, transizioni PO.
- `packages/services`: `variantStock` (livelli, in arrivo, venduti, velocità, rischio per variante), `receivePurchaseOrder`, `transitionPurchaseOrder`, `createPurchaseOrder`, `refreshBackorders` con notifica, `supplierBalances`, `recordSupplierPayment`. Test: ricevimento parziale poi completo verifica stock +20, costo aggiornato, movimenti registrati.
- Web: `/products` (filtri per rischio/tipo/stato), `/products/[id]` (KPI, grafico Recharts, varianti × location, PO in arrivo, movimenti, campagne collegate, modifica prezzo e stato via adapter), `/inventory` (tile, finestra 7–90 giorni, filtro location), `/purchasing` (tab per stato, badge "copre N ordini"), `/purchasing/[id]` (ricevimento con quantità per riga, location, write-back opzionale, pagamenti), `/purchasing/new` (precompilato dai suggerimenti), `/purchasing/suppliers` (saldi).

## Fase 5 — dettaglio

Fatto:
- `packages/core/finance`: `orderEconomics`, `sumEconomics`, `prorateMonthlyCost`, `previousPeriod`, `runningWindows`, `change`. Criterio di uscita verificato: il P/L di un mese su 3 ordini di test coincide con il calcolo a mano sia nella funzione pura sia leggendo dal database.
- `packages/services/analytics`: `orderEconomicsForPeriod`, `pnlForPeriod`, `kpisForPeriod` (nuovi vs ricorrenti, tassi di annullamento e reso, variazioni vs periodo precedente), `dailySeries`, `dashboardSummary`, `productPerformance`, `repurchaseCohorts`.
- Web: dashboard con KPI di oggi vs ieri/settimana scorsa alla stessa ora, coda di lavoro cliccabile, grafico 30 giorni, ordini di oggi per stato; `/analytics` con selettore periodo (preset e date), tab Panoramica / P/L (cascata + per mese) / Prodotti / Coorti; ogni numero porta alla lista ordini filtrata.

## Fase 6 — dettaglio

Fatto:
- `packages/core/campaigns`: `campaignMetrics` (profitto = margine − spesa, ROAS, ROI, CPA, CPC, conversione, divisioni sicure), `trafficLight` sulle soglie ROI del tenant, `recommendAction` (ok / pause / resume / consider_* / pause_stock / consider_stock, con motivo e consiglio di riordino) che guarda stock, merce in arrivo e riacquistabilità dei prodotti collegati, `suggestProductsForCampaign` (URL > titolo esatto > prefisso > contiene > token). Criterio di uscita verificato nei test: con stock sotto soglia e nulla in arrivo la raccomandazione è "spegni", con un PO in arrivo diventa "valuta".
- `packages/services/campaigns`: `campaignsWithEconomics` (spesa da `ad_metrics_daily`, ordini da `order_attribution` filtrati con `orderEconomics` → solo ordini non annullati e non resi), `campaignDailyLedger` (nessun rapporto salvato, ROAS nullo a spesa zero, flag `no_ads_data`/`no_order_data`), `campaignLinkSuggestions`, `linkCampaignProduct` (un solo primario), `autoLinkCampaigns`.
- Web: `/campaigns` con selettore periodo condiviso (`@/components/period-picker`, `@/server/period`), filtri piattaforma/stato, colonne spesa/ordini/ricavo/margine/profitto/ROAS/ROI/CPA, semaforo, raccomandazione, stock (+ in arrivo), riga totali, pannello "campagne da collegare" con link singolo e auto-link; `/campaigns/[id]` con KPI, registro giornaliero, prodotti collegati (rischio, giorni copertura, primario, scollega), suggerimento di riordino con link a "nuovo ordine d'acquisto" precompilato, collegamento manuale da select, pausa/riattiva con dialog di conferma che scrive prima sull'adapter Meta poi in locale + audit; Google mostra l'avviso di sola lettura. `/campaigns/ledger` + `/campaigns/ledger/export` (CSV). La lista ordini accetta `?campaign=<id>` per il drill-through delle vendite attribuite.
- e2e: lista/dettaglio/pausa/riattiva/collega/scollega come marketing, Google read-only + CSV come owner, viewer senza controlli di scrittura + drill-through.

Nota sui test e2e: il test di ricevimento ordini d'acquisto consuma un PO confermato o in transito a ogni esecuzione; dopo molte esecuzioni sullo stesso database rilanciare `pnpm db:seed`.

## Fase 7 — dettaglio

Fatto:
- `packages/core/segments`: catalogo campi (`SEGMENT_FIELDS`, con hook `registerSegmentFields` per gli add-on), schema zod delle regole `{match, conditions[]}` con gruppi annidati, `validateSegmentRules` (campo, operatore per tipo, valore, gruppo vuoto, profondità ≤ `MAX_SEGMENT_DEPTH`, foglie ≤ `MAX_SEGMENT_CONDITIONS`), `evaluateRules` in memoria, `rfmRecencyBand`/`rfmFrequencyBand`/`rfmTier`/`buildRfmMatrix`/`rulesForRfmCell`/`rulesForRfmTier`, `assignHoldout` (FNV-1a, stabile per segmento+cliente+salt), `normCdf` e `twoProportionTest`. 7 test.
- `packages/services/crm`: CTE `profileCte` (ordini in scope di vendita → conteggi, spesa, AOV, recenza, metodi di pagamento, prodotti e tipi acquistati, campione casuale stabile), `compileSegmentRules` (espressioni SQL solo dalla whitelist, valori solo come parametri, array come parametro unico), `listCustomers` (ricerca nome/email/telefono, paese, fascia RFM, consenso, segmento, ordinamenti, paginazione), `customerProfiles`, `previewSegment` (conteggio + contattabili + campione stabile), `saveSegment`, `evaluateSegment` (inserisce i nuovi con gruppo stabile, rimuove chi non corrisponde più, non sposta mai nessuno), `segmentMembers`, `customerDetail`. Criterio di uscita verificato: su un segmento annidato a 3 livelli il compilatore SQL e il valutatore puro restituiscono lo stesso insieme di clienti.
- Web: `/customers` (filtri, ordinamenti, tab), `/customers/rfm` (matrice recenza × frequenza con intensità, fasce con regola leggibile, click → `/segments/new?rules=…`), `/customers/[id]` (KPI, contatto, segmenti e gruppo, ordini con drill-through `?customer=`), `/segments` (lista con membri, holdout, ultima valutazione, azioni rivaluta/esporta/elimina), costruttore (`builder.tsx`: gruppi annidati, campi per gruppo, operatori per tipo, valori con chip, anteprima live con debounce, limiti visibili, holdout), `/segments/[id]` (stat, costruttore in modifica, membri top 50 con gruppo), `/segments/[id]/export` CSV (azione `export`, ora legata alla pagina segmenti).
- `MessagingChannel` resta interfaccia + mock: il modello dati ha già `holdout_percentage` e `segment_memberships.group_name` per le campagne future.

## Fase 8 — dettaglio

Fatto:
- `packages/core/returns`: `RETURN_TRANSITIONS`/`canTransitionReturn`, `returnEligibility` (consegna effettiva o spedizione + `returnShippingFallbackDays`, finestra `returnWindowDays`, motivi `cancelled`/`not_delivered`/`expired`), `returnableLines` (quantità al netto dei resi precedenti non rifiutati, valore unitario netto dello sconto ordine ripartito pro quota, esclusioni per `returnExcludedProductTypes` e righe accessorie), `returnedFractionBps`. `packages/core/discounts`: `generateUniqueCodes` (alfabeto senza caratteri ambigui, RNG iniettato), `discountState`, `discountAmount`, `formatDiscountValue`. 5 test.
- `packages/services/returns`: motivi per tenant (`listReturnReasons`, `saveReturnReason`, `setReturnReasonActive`), `orderReturnContext`, `createReturn` (numerazione per tenant, importo proposto, evento `return_requested`, flag fuori finestra), `transitionReturn` (validazione transizioni; su `received` rientro a stock con `inventory_movements` + `inventory_levels` e callback di write-back; su `inspected` esito e importo per riga; su chiusura importo rimborsato/buono; poi propagazione all'ordine: `returned_fraction`, `refunded_minor`, stato pagamento e `recomputeOrderStatus`), `listReturns`, `returnDetail`, `returnsAnalytics`. `packages/services/discounts`: `listDiscounts` (stato calcolato, ordini in scope di vendita, sconto erogato, ricavo netto e margine tramite `orderEconomics`), `discountDetail`, `createDiscountCode` e `createDiscountPool` (piattaforma prima tramite callback, poi righe locali con esito importato/fallito), `listDiscountPools`, `setDiscountActive`. Criterio di uscita verificato nel test: un reso percorre tutto il flusso, lo stock della location aumenta della quantità resa con un movimento `return_restock`, l'ordine passa a `returned_partial`/`returned` con rimborso registrato.
- Web: `/returns` (chip per stato con conteggi, ricerca, filtro motivo), `/returns/[id]` (stepper, importi proposto/accettato/rimborsato, righe con ispezione e rientro, storico eventi, azioni di flusso in dialog con rientro a stock per location e write-back, ispezione per riga, importo rimborso/buono, nota obbligatoria per rifiuto), `/returns/new?order=` (idoneità, righe con quantità restituibili, motivo, esito, note, override staff), `/returns/analytics` (KPI, per motivo, per responsabilità/esito, per prodotto con tasso), `/returns/reasons` (gestione motivi, link alle impostazioni per finestra/esclusioni). Link "Apri reso" nel dettaglio ordine per ordini spediti/consegnati. `/discounts` (stati, ricerca, pool con riepilogo, lista pool), `/discounts/new` (codice singolo o pool), `/discounts/[id]` (regole, KPI, ordini). Impostazioni: `returnShippingFallbackDays` e `returnExcludedProductTypes` nel tab operativo.

## Fase 9 — dettaglio

Fatto:
- `packages/core/attribution`: `extractAttribution` (UTM e click id da note attributes, landing e referrer con precedenza), `deriveChannel`, `matchCampaign` (id piattaforma → nome normalizzato, piattaforma preferita dal click id), `splitDateWindows`.
- `packages/integrations`: `HttpClient` con fetch iniettabile, retry su 429/5xx con Retry-After e mappa errori → `IntegrationError`; `fixtureFetch` per i test. `shopify/`: mapper REST (webhook) e GraphQL (orders, products, customers, locations, inventory, discounts, returns), `ShopifyCommercePlatform` (paginazione con cursore, throttling GraphQL, registrazione webhook idempotente, verifica HMAC, scritture via mutation con userErrors), OAuth app pubblica (`buildInstallUrl`, `verifyOAuthCallback`, `exchangeOAuthCode`), scope minimi per modulo, elenco topic. `meta/`: campagne, insight giornalieri a livello campagna con paginazione, pausa/riattiva, codici errore (190, 17/32/613, 10/200). `google/`: refresh token OAuth, `searchStream` GAQL, campagne e metriche, `setCampaignStatus` → `unsupported`. 20 test su fixture, zero rete. Interfaccia `CommercePlatform` estesa con `parseWebhookProduct/Customer/InventoryLevel`.
- `packages/services/sync`: `importOrder` (upsert idempotente, campi locali preservati, righe/sconti/attribuzione/spedizioni con stato per fonte + resolver, evento `imported` o `platform_update` con diff, `recomputeOrderStatus`), `importProduct/Location/InventoryLevel/Discount`, `upsertCustomer` (per id, poi per email), `recordWebhookEvent` (unicità su source/topic/id/updated_at), `processWebhookEvent` (dispatch per topic, `app/uninstalled` scollega), `retryFailedWebhooks`, `runOrdersSync` (initial/delta/reconcile con cursore in `sync_runs`, high-water mark con sovrapposizione di 2 minuti, pausa a budget e ripresa), `runCatalogSync`, `runAdsSync` (upsert per campagna+giorno), `recordHealth` (ok/degraded/error, fallimenti consecutivi), `integrationOverview`. Factory `getCommercePlatformFor`/`getAdsPlatformFor` condivisa da web e job: modalità per riga integrazione, `KEEL_INTEGRATION_MODE=mock` forza il mock ovunque. 5 test su database con il simulatore.
- `packages/jobs`: code `webhook.process`, `sync.orders` (si ri-accoda da solo se in pausa), `sync.catalog`, `sync.ads`, `scheduler.tick` con cron (delta ogni 15 min, retry webhook ogni 10 min, ads alle 06:00, riconciliazione + catalogo alle 03:00 UTC).
- Web: `POST /api/webhooks/shopify` (tenant dal dominio del negozio, verifica HMAC con il segreto del tenant, 200 immediato, elaborazione dopo la risposta: in coda con `KEEL_JOBS_QUEUE=1`, altrimenti inline), OAuth `start`/`callback`, `/integrations` (card per provider con stato, modalità, account, ultimo sync/successo/errore, scope mancanti, salute per fonte, azioni testa/risincronizza/collega/scollega e, in mock, simula webhook ordine/annullamento/firma errata; slot messaggistica/magazzino/corriere “su richiesta”; esecuzioni recenti; registro webhook con riprova e rielabora), `/integrations/guide/[provider]` in en/it/es con passi, badge “Da verificare”, scope minimi per modulo, endpoint e topic, errori comuni.

## Fase 10 — dettaglio

Fatto:
- Schema: `subscriptions` (una per tenant: piano, stato trialing/active/past_due/suspended/cancelled, provider, periodo corrente, trial, fee di attivazione) e `invoices` (numero per tenant, tipo setup/subscription/adjustment, righe, scadenza, pagata/annullata, id esterno e link hosted), entrambe con RLS (il tenant potrà leggere le proprie). Migrazione `0003`.
- `packages/core/billing`: `monthlyInvoiceLines` (piano + add-on a pagamento attivi), `setupInvoiceLines`, `paymentHealth` (ok / past_due / suspended oltre `suspendAfterDays`), `mrr`, `addMonths`. 3 test.
- `packages/services/billing`: `BillingProvider` con `MockBillingProvider` (default) e `StripeBillingProvider` (test mode, REST senza SDK: customer per tenant, invoice items, finalize, stato), scelto da `STRIPE_SECRET_KEY`; `createTenant` (tenant in prova, owner esistente o nuovo con password temporanea mostrata una volta, membership, aliquota, regole di stato predefinite, righe integrazione, abbonamento + fattura di attivazione, audit), `tenantChecklist`, `ensureSubscription`, `issueDueInvoices` (idempotente per periodo), `recordInvoicePayment`, `voidInvoice`, `refreshTenantPaymentState`/`applySuspensions` (sospende oltre la tolleranza, riattiva quando non resta nulla di scaduto, mai se la sospensione è manuale), `setTenantSuspension`, `setTenantPlan`, `setTenantAddon` (solo add-on `implemented`, con nota e data), `tenantsOverview`, `platformMetrics`, `tenantAdminDetail`, `listInvoices`. 3 test su database (ciclo completo: creazione → fattura mensile → insoluto → sospensione → pagamento → riattivazione).
- Web: guardia `requireSuperAdmin` (404 per gli utenti tenant), layout `/admin` con navigazione propria, dashboard, `/admin/tenants`, `/admin/tenants/new`, `/admin/tenants/[id]`, `/admin/billing` (filtri per stato, segna pagata/annulla, “Esegui fatturazione”), `/admin/audit`. “Apri come supporto” scrive `impersonation.started` e apre il tenant con il banner già presente nella topbar; ogni azione svolta durante l'impersonificazione è registrata con `actorType: impersonation` e `impersonatedBy` grazie a `auditActor(ctx)` usato da tutte le server action.
- Job: tick `billing` giornaliero (04:30 UTC) che emette le fatture dovute e applica le sospensioni. Seed: abbonamento attivo con storico pagato per Northwind, abbonamento scaduto con fattura aperta per Harbor Home.

## Fase 11 — dettaglio

Fatto:
- Nuovo pacchetto `packages/addon-cod` (`@keel/addon-cod`): il core non lo importa mai; lo importano `apps/web` e `packages/jobs` dietro il flag `addon.cod` (pagine `cod_queue`, `cod_settings`; 404 anche conoscendo l'URL quando l'add-on è spento). Tabelle in `packages/db/src/schema/cod.ts` (migrazione `0004`): `cod_settings`, `cod_queue_items`, `cod_attempts`, `cod_operator_capacity`, `cod_capacity_exceptions`, `cod_assignment_log`, `cod_recipient_profiles`, tutte con RLS; il test di isolamento richiede righe solo per il tenant con l'add-on.
- Logica pura (testata): `settings.ts` (schema zod con pesi 0–50 per 12 fattori, soglie, parametri di rischio), `scoring.ts` (`computeDeliveryScore`: media pesata dei fattori attivi + fattori informativi, `customerDeliveryScore` con decadimento esponenziale, `addressQuality` con validatori per paese, `penalizedScore` per fascia), `assignment.ts` (`nextOperator` round-robin pesato liscio: debito = quota · (1+N) − assegnati; `hoursFor` con assenze/ore extra; `localDay` nel fuso del tenant), `risk.ts` (`recipientKey` telefono → email, mai il nome; `buildRecipientProfile` con resi pesati per età e consegne consecutive; `classifyRecipient` con riabilitazione di una fascia e override), `queue.ts` (macchina degli esiti esplicita, priorità della coda).
- Servizi: `syncQueue` (entrano gli ordini in contrassegno in `new`/`pending_review` senza spedizione entro la finestra; escono quelli confermati/annullati; gli irraggiungibili restano finché un operatore chiude), `scoreQueueItem`/`scorePendingItems` (storico cliente a più hop, duplicati, ordini simili per CAP, annullamenti recenti, AOV del tenant, profilo di rischio), `recordAttempt` (tentativo, esito, evento `cod_attempt`, confermato → stato manuale `confirmed`, irraggiungibile → `on_hold`), `assignQueueItem`/`distributeUnassigned`/`releaseQueueItem` (log di ogni decisione, regola anti-abuso: dopo una chiamata registrata rilascia solo un admin), capacità e assenze, `recomputeRecipientProfiles`/`setRecipientOverride`/`listRiskyRecipients`, viste coda e KPI operatori.
- Web: `/cod` (viste coda/miei/non assegnati/da richiamare/non raggiungibili con conteggi, punteggio e fascia di rischio, tentativi, operatore, attesa; prendi/rilascia, registra chiamata con dialog degli esiti, ricalcola punteggi, distribuisci; KPI operatori 7 giorni), `/cod/settings` (ore per giorno e attivazione operatori, assenze e turni extra, pesi con spiegazione per fattore, soglie, parametri di rischio, destinatari a rischio con suggerimento e override motivato; chiavi mascherate), scheda “Contrassegno” nel dettaglio ordine con punteggio spiegato fattore per fattore, tentativi e pulsante esito. Job: tick ogni 10 minuti (sync coda, punteggi, distribuzione) e ricalcolo rischio notturno. Seed: capacità per tre operatori, un'assenza, elementi in coda con tentativi, profili di rischio.
- Seed generale: la copertura dei prodotti a basso stock da parte degli ordini d'acquisto in arrivo è ora strutturale (metà restano scoperti), così “prodotti in esaurimento” è garantito a prescindere dall'orario del seed.

## Fase 12 — dettaglio

Fatto:
- `README.md`: avvio in un comando (Docker o Postgres di sistema), tabella delle credenziali demo, struttura del repository, modalità (mock/live, Stripe, coda job).
- `docs/ARCHITECTURE.md`: grafo dei pacchetti e regole di dipendenza, tenancy e sicurezza, modello dati per gruppi (56 tabelle), stato canonico, economia, risolutore spedizioni, sequenza webhook, sync e riconciliazione, attribuzione, guida per aggiungere un adapter e un add-on, layout dell'app, piramide dei test.
- `docs/EVALUATION.md` (italiano): cosa funziona con la prova, cosa è mock, cosa manca, 8 debiti tecnici, tabella rischi, 10 passi verso il primo cliente pagante, percorso di valutazione in 30 minuti.
- `apps/web/scripts/screenshots.mjs`: 41 pagine × 2 lingue (login, tutte le pagine di modulo con un dettaglio ciascuna, impostazioni, add-on, console) a 1440 px, altezza limitata a 3200 px; i dettagli sono scelti dal primo link a UUID della lista corrispondente. Eseguito su database appena riseminato così la console non mostra i tenant creati dagli e2e.
- Gate finale: lint, typecheck, 447 test unitari/integrazione, build, 39 e2e. Il riseed di fase 12 a un'ora diversa ha fatto cadere due e2e (nessun prodotto "critico") e due test di isolamento (nessun profilo destinatario nel seed piccolo): entrambe le garanzie sono ora strutturali nel generatore (vedi DECISIONS "Demo guarantees must not depend on the clock").

Non fatto (documentato in EVALUATION §4): GA4, connettore MCP, scritture Shopify oltre annullo/prezzo/stato/stock/sconti, riprogettazione mobile delle tabelle larghe.

## Dopo la fase 12 — iterazione 2 (richieste di Federico)

Fatto:
- **Tag della piattaforma nell'add-on contrassegno**: vocabolario per tenant in Coda → Impostazioni (tag letti: coda / conferma / annullamento, con `*` per prefisso; tag scritti per evento: ingresso, ogni esito, non raggiungibile, sostituito); scrittura prima sulla piattaforma poi in locale con evento `tags_updated`; lettura nel sync della coda (ingresso, rientro di un ordine confermato, chiusura per tag); tag ammessi per operatore (instradamento); filtro per tag e badge in coda; seed di Northwind con il vocabolario del Control Room e regola di stato `confermato → confirmed`.
- **Modifica e annullamento pre-conferma**: dialog "Modifica ordine" nella scheda contrassegno (contatti, indirizzo, nota, righe, unione ordini dello stesso cliente); contatti modificati sul posto, righe e unioni tramite sostituzione (nuovo ordine creato sulla piattaforma e importato, vecchi annullati come `replaced`, collegati, esclusi dalle analisi); esito "Annullato" che annulla davvero sulla piattaforma; adapter `updateOrderDetails` e `createOrder` (Shopify via draft order, da verificare su account reale; mock).
- `featureFlags` per tenant in `tenant settings` con `hasFeature`.
- Migrazione `0005` (`cod_queue_items.entry_tag`, `cod_operator_capacity.allowed_tags`); 20 test addon-cod; e2e contrassegno estesi.

Attività aperte (in ordine di richiesta):
1. Come applicare modifiche a un solo tenant: documentato in ARCHITECTURE ("Changes for one tenant"); manca l'editor dei flag nella console.
2. Form resi pubblico e personalizzabile che alimenta la pagina Resi.
3. Scrittura dei resi su Shopify (ordine marcato come reso, rimborso, rientro a stock).
4. Analisi → P/L: costi fissi e di spedizione per periodo, stima e consuntivo.

## Programma di profondità — Area 1 (analisi, attribuzione, profitto)

Fatto (tutto ciò che non richiede dipendenze esterne):
- Costi di periodo con stima e consuntivo (fissi, altri, fattura spedizioni) e P/L che dichiara la fonte; regola di proratazione mensile aggiornata.
- Metriche blended (MER, nc-ROAS, CAC blended e per canale, POAS) e previsione a fine mese (dashboard e Analisi).
- LTV a 30/60/90/180/365 giorni per mese di acquisizione, canale e primo prodotto, con rientro del CAC; analisi prodotto (prodotti di ingresso, acquistati insieme con lift, primo → secondo acquisto).
- Attribuzione multi-touch con sei modelli su `touchpoints`, confronto con ultimo clic, rivendicazione della piattaforma e dichiarato; pannello dichiarato vs reale su Campagne.
- Creatività: tabelle `ad_creatives` e metriche giornaliere, raggruppamento per formato/hook/angolo, ordini reali, affaticamento.
- Alert su soglia e anomalia robusta con job orario, consegna in-app, email (adapter provider + mock) e Slack (incoming webhook, adapter reale testato su fixture).
- Metriche personalizzate con costruttore di formule sicuro e dashboard per utente.
- Seed: canali allineati ai valori canonici dell'importer, 2–6 creatività per campagna con una in affaticamento, 0–3 visite precedenti per ordine, regole di alert ed eventi, metriche e dashboard per entrambi i tenant.
- Migrazioni 0006–0007; test core 91, servizi 34, db 359 (isolamento sulle 8 nuove tabelle), e2e 42.

Resta per l'Area 1 (blocco esterno): pixel first-party (1.1), conversioni server-side (1.2), sondaggio post-acquisto (1.9), assistente AI (1.13).

## Programma di profondità — Area 2 (pianificazione scorte e acquisti)

Fatto:
- Previsione a 12 mesi per variante (stagionalità sul tipo di prodotto, livello e trend sulla variante, eventi di domanda per ambito, correzioni manuali per mese, errore WAPE sugli ultimi 3 mesi) con grafico e tabella modificabile.
- Riordino con scorta di sicurezza (livello di servizio del tenant, variabilità di domanda e lead time), punto di riordino, minimi e multipli per fornitore o per coppia fornitore-variante, data di esaurimento prevista; bozze di ordini d'acquisto generate in blocco, una per fornitore.
- Ordini d'acquisto: costi aggiuntivi (dazi, trasporto, commissioni) ripartiti per valore, quantità o peso in costo landed, che al ricevimento diventa il costo del prodotto; PDF dell'ordine; invio al fornitore con link pubblico di conferma (conferma con data o segnalazione di un problema), notifica e audit. L'email è mock: il link viene mostrato per inoltrarlo.
- Condizioni del fornitore (variabilità del lead time, acconto, giorni di saldo, minimo, multiplo, referente) modificabili.
- Analisi scorte ABC × XYZ con valore, eccessi e lenta rotazione; trasferimenti tra sedi con esecuzione scritta sulla piattaforma; piano di cassa per gli acquisti (impegnato e pianificato per mese); piano da obiettivo di ricavo; bundle con disponibilità derivata e distinte base con fabbisogno materiali.
- Correzioni trovate strada facendo: permesso di modifica di prodotti e magazzino ora verificato sulla pagina (prima bastava il permesso sugli ordini); numerazione degli ordini d'acquisto che non collide più con numeri non consecutivi; due e2e resi ripetibili senza reseed.
- Migrazione 0008 (5 tabelle nuove, tutte con RLS); test core 103, servizi 39, db 389, e2e 47.

Resta per l'Area 2: domanda per sede (le vendite non portano ancora la sede di evasione), vendite dei bundle esplose sulla velocità dei componenti, consumo dei materiali in produzione, invio reale dell'email al fornitore (serve il provider email).

## Deploy e produzione (2026-10-01)

Fatto: servizio Railway configurato dalle impostazioni (documentate in `docs/DEPLOY.md`; `railway.json` è deprecato e non viene letto dai servizi nuovi), `pnpm db:deploy` come pre-deploy, build senza variabili del database, porta da `$PORT`, Node 22 fissato; controllo di avvio (`checkRuntimeConfig`): in modalità `live` web e worker non partono senza `KEEL_JOBS_QUEUE=1`, URL del database e segreti non di sviluppo; Sentry facoltativo (solo errori, nessun dato personale) su server, browser e worker; variabili vuote di `.env.example` non diventano più password vuote in bootstrap e seed; `docs/DEPLOY.md` aggiornato.

Manca: upload delle source map a Sentry; worker su Railway (non serve in modalità mock); migrazione a `.railway/railway.ts` quando ci sarà la CLI o la GitHub Action.

## Programma di profondità — Area 3, primo blocco (portale resi e scrittura su Shopify)

Fatto (issue #4):
- Portale pubblico dei resi `/r/<negozio>` in en/it/es: ricerca dell'ordine per numero ed email o telefono con limite di 5 tentativi falliti ogni 15 minuti, sessione firmata di un'ora, scelta di righe e quantità, motivo, rimborso / cambio / buono, tracking con corrieri, foto compresse nel browser, campi aggiuntivi, IBAN per gli ordini non pagati online (cifrato, visualizzazione registrata), casella di conferma, stato dei resi precedenti, chiave di idempotenza.
- Configurazione completa per negozio (testi per lingua, logo, colore, regole, motivi offerti, campi) e motivi con etichette per lingua e codice motivo Shopify.
- Scrittura su Shopify a passi idempotenti dopo ogni cambio: richiesta, approvazione o rifiuto, rientro a stock, rimborso sulla transazione originale, chiusura, tag dell'ordine per stato; errori visibili con pulsante "Riprova" e job ogni 10 minuti. Corretto il rientro a stock che passava l'id della riga d'ordine al posto dell'articolo di magazzino.
- Spedizione di reso trattenuta quando la colpa è del cliente (configurabile).
- Corretta la chiave di cifratura di esempio in `.env.example` (34 byte invece di 32: la cifratura falliva in locale).
- Migrazione 0009 (3 tabelle nuove con RLS, colonne additive); test core 112, integrazioni 27, servizi 46, db 408, e2e 50.

Resta per l'Area 3 (issue #5): regole di idoneità avanzate, cambi con differenza da pagare, bonus sul buono, workflow automatici, segnali di frode, analisi per opzione, pagina di tracking per il cliente.

## Programma di profondità — Area 3, secondo blocco (politica, automazioni, rischio)

Fatto (issue #5, prima parte):
- Politica dei resi per negozio: finestre per paese, tipo di prodotto e tag; esclusioni per tipo, prefisso SKU, titolo e tag; vendita finale da soglia di sconto; limite di resi per cliente. Ogni riga dice perché non è restituibile, sia nel portale sia per lo staff, che può derogare con una nota.
- Rischio del cliente spiegato (tasso di reso, resi rapidi per colpa del cliente, valore reso alto), mostrato su ogni reso, con segnalazione "da rivedere" e filtro.
- Automazioni ordinate alla creazione del reso: approva, rifiuta, segnala, imposta colpa, rimborsa senza reso. Passano dal workflow normale; rifiuta e rimborsa senza reso richiedono almeno una condizione.
- Seed: politica e tre automazioni per entrambi i negozi, alcuni clienti con storico di resi reale e un reso aperto da rivedere, resi "tenuti dal cliente".
- Due test e2e resi ripetibili sullo stesso database.
- Migrazione 0010 (1 tabella con RLS, colonne additive); test core 119, servizi 50, db 414, e2e 52.

Resta per la issue #5: cambi con differenza da pagare e bonus sul buono (3.3, 3.5), analisi per opzione e costo dei resi nel P/L (3.9), pagina di tracking per il cliente (3.10), interfacce esterne per cambio immediato ed etichette (3.4, 3.7).

## Programma di profondità — Area 3, terzo blocco (cambi, buoni, cambio immediato)

Fatto (issue #5, seconda parte):
- Cambio con un'altra variante disponibile dello stesso prodotto, dal portale e dallo staff. La differenza di prezzo si paga con un link di pagamento del negozio (draft order con fattura), oppure si rimborsa se il nuovo articolo costa meno. L'ordine pagato si ricollega al reso.
- Bonus sul buono configurabile, mostrato al cliente e aggiunto al credito. Il buono diventa un codice monouso a importo fisso creato sul negozio (prima esisteva solo in Keel).
- Cambio immediato: il sostituto parte all'approvazione con un blocco sulla carta del valore della merce, rilasciato all'arrivo e addebitato dal job dopo la scadenza. Il fornitore di pagamento è dietro un'interfaccia con mock.
- Seed: cambi con variante e differenza, bonus sui buoni, impostazioni per entrambi i negozi.
- Migrazione 0011 (1 tabella con RLS, colonne additive); test core 120, integrazioni 28, servizi 55, db 420, e2e 53.

Resta per la issue #5: analisi per opzione e costo dei resi nel P/L (3.9), pagina di tracking per il cliente (3.10), interfaccia del fornitore di etichette (3.7), fornitore reale per il blocco sulla carta.

## Programma di profondità — Area 3, quarto blocco (analisi, tracking, etichette)

Fatto (issue #5, chiusa):
- Analisi resi: tasso per valore di opzione (taglia, colore); valore trattenuto con cambi e buoni; buoni emessi con bonus; ordini di cambio e importo extra pagato; costo dei resi.
- Il costo dei resi è anche una riga del P/L dentro il margine di contribuzione: etichetta e gestione per ogni reso rientrato, al netto della spedizione addebitata al cliente. I costi si configurano per negozio.
- Pagina pubblica di tracking accanto al portale: stato dell'ordine, pacchi, link del corriere, eventi e resi, con lo stesso accesso e limite di tentativi del portale.
- Etichetta di reso prepagata: emessa all'invio tramite l'interfaccia `ReturnLabelProvider` (mock), con tracking salvato sul reso e PDF dietro link firmato, per il cliente e per lo staff.
- Seed: costi dei resi, etichetta attiva su Northwind, pagina di tracking attiva per entrambi.
- Migrazione 0012 (colonne additive); test core 123, integrazioni 28, servizi 58, db 420, e2e 55.

Spostato nella issue #7 (esterni): fornitore reale per il blocco su carta, fornitore di etichette, email di stato al cliente.

## Landing page (`apps/landing`) · 2026-10-01

Fatto: nuova app statica `apps/landing` (Next.js export, Tailwind 4, next-intl) con le nove sezioni richieste in inglese (`/`) e italiano (`/it/`), hreflang, sitemap, robots, immagine Open Graph generata; prezzi e offerta fondatori in `apps/landing/src/config/pricing.ts`; screenshot reali del tenant demo Harbor Home in WebP con cornice da browser; form di contatto con webhook pubblico o `mailto:`; CTA "Book a demo" da `NEXT_PUBLIC_DEMO_URL` con fallback `mailto:`. Screenshot della landing in `docs/landing/`, istruzioni in `docs/landing/README.md`. Gate: lint, typecheck, test e build verdi. Piani del prodotto (`packages/config`) allineati ai prezzi della landing (USD, utenti illimitati, eccedenza, add-on contrassegno 199 $), con test di parità.

Manca: link di prenotazione reale e webhook del form (variabili d'ambiente da impostare in produzione); testimonianze e loghi (segnaposto commentato, niente di inventato); verifica degli scope su Vercel al primo deploy.

## Programma di profondità — Area 4, primo blocco (previsioni per cliente)

Fatto (issue #6, prima parte):
- Modello statistico per cliente, stimato sullo storico ordini di ogni negozio: MBG/NBD per frequenza di acquisto e abbandono, Gamma-Gamma per il valore degli ordini. Per ogni cliente: probabilità di essere ancora attivo, ordini attesi a 90 giorni e a 12 mesi, valore atteso per ordine, valore previsto a 12 mesi, data attesa del prossimo ordine, rischio abbandono (basso, medio, alto, con soglie nelle impostazioni).
- Verifica del modello sui dati del negozio: stima sugli ordini fino a 180 giorni fa e confronto tra acquisti previsti ed effettivi, in totale e per numero di acquisti ripetuti. Sul seed l'errore è dello 0,8% su Northwind e del −12,5% su Harbor.
- Pagina Clienti → Previsioni: ordini e ricavi attesi dai clienti esistenti, distribuzione per rischio con link alla lista e al segmento, verifica del modello, liste "clienti di valore che si stanno perdendo", "in attesa di ordine" e "valore previsto più alto", pulsante di ricalcolo.
- Quattro campi nuovi nel costruttore di segmenti (rischio abbandono, probabilità attivo, valore previsto, giorni al prossimo ordine), con la stessa semantica in SQL e in memoria.
- Lista clienti con filtro per rischio, colonna e ordinamento per valore previsto; scheda cliente con il riquadro previsioni.
- Ricalcolo ogni notte alle 03:40 UTC (job `crm`) e su richiesta, con audit.
- Seed: il generatore ora simula il ciclo di vita dei clienti (acquisizione, ritmo d'acquisto personale, abbandono) sulle stesse date d'ordine stagionali; prima nessun cliente abbandonava mai e il modello dava tutti "attivi". Il seed scrive le previsioni con lo stesso codice del job.
- Migrazione 0013 (2 tabelle con RLS); test core 137, integrazioni 28, servizi 63, db 432, e2e 57.

Aperto: il seed completo impiega tra 1 minuto e 55 secondi e 2 minuti e 50 secondi su questo ambiente, a seconda del disco; il limite è 2 minuti. Le fasi nuove pesano circa 1,5 secondi per negozio; il resto è scrittura e cancellazione dei dati precedenti, già prima di questo blocco.

Resta per la issue #6: campagne con gruppo di controllo e margine incrementale (4.4), esportazione dei segmenti verso strumenti esterni tramite adapter (4.3), segmenti aggiornati in tempo reale e sincronizzazione delle audience (4.1).

## Programma di profondità — Area 4, secondo blocco (campagne con gruppo di controllo)

Fatto (issue #6, seconda parte):
- Campagne clienti su un segmento: email, SMS, WhatsApp tramite l'interfaccia `MessagingChannel` (mock), oppure "inviata da un altro strumento" per misurare campagne spedite altrove. Bozza modificabile, invio con anteprima dei gruppi e dell'effetto minimo rilevabile, registro di esposizione per cliente.
- Il gruppo di controllo è quello del segmento (assegnazione stabile già nel modello dati); entrano solo i clienti con consenso marketing, prima di leggere la divisione.
- Risultati per intenzione di trattamento sulla finestra di attribuzione: conversione trattati e controllo con p-value, ordini, ricavi e margine incrementali con intervallo al 95%, costo di invio, margine netto e ROI, utilizzi del codice. Margine con la stessa economia del P/L.
- Pagine Segmenti → Campagne (lista con verdetto ed effetto netto, nuova, bozza, dettaglio) e collegamento "Nuova campagna" dalla scheda segmento.
- Seed: Northwind ha una campagna di riconquista con codice, inviata 35 giorni fa, con effetto reale e significativo (circa 21% contro 13% di conversione, p = 0,002), più una bozza su un segmento senza controllo; Harbor ha una campagna inviata da un altro strumento senza effetto chiaro.
- Migrazione 0014 (2 tabelle con RLS); test core 142, servizi 67, db 444, e2e 59.

Resta per la issue #6: esportazione dei segmenti verso strumenti esterni tramite adapter (4.3), segmenti aggiornati in tempo reale e sincronizzazione delle audience (4.1).

## Programma di profondità — Area 4, terzo blocco (segmenti in tempo reale, destinazioni, add-on campagne)

Fatto (issue #6, chiusa; issue #38, chiusa):
- Segmenti in tempo reale: un segmento "live" si ricontrolla ogni 10 minuti solo per i clienti i cui ordini o dati sono cambiati, e completamente ogni notte dopo le previsioni (le condizioni sul tempo cambiano senza eventi). I gruppi esistenti non si spostano mai.
- Destinazioni dei segmenti tramite l'interfaccia `AudienceDestination`: pubblico personalizzato Meta, Customer Match Google, lista di uno strumento email. Sincronizzazione per differenza (aggiunte e rimozioni), idempotente, con stato ed errore leggibile, automatica dopo ogni cambiamento del segmento o su richiesta. Le piattaforme pubblicitarie ricevono solo hash SHA-256 di email e telefono normalizzati; solo clienti con consenso marketing. Adapter solo mock: i collegamenti reali sono nella issue #7.
- Su richiesta del committente, campagne clienti e gruppi di controllo diventano l'add-on `addon.customer_campaigns` (99 $/mese, valore da confermare): senza l'add-on i segmenti non hanno campo di controllo né colonna gruppo, l'esportazione CSV e le destinazioni includono tutti i membri, le pagine delle campagne restituiscono 404. Northwind ha l'add-on, Harbor no.
- Seed: segmento "clienti ricorrenti" live con una destinazione per negozio; Harbor senza controllo e senza campagne; Northwind con una seconda campagna (inviata da un altro strumento, senza effetto chiaro).
- Migrazione 0015 (2 tabelle con RLS, una colonna con default); test core 142, integrazioni 31, servizi 70, db 456, e2e 61.

Resta: collegamenti reali per messaggistica e audience (issue #7); la landing non mostra ancora l'add-on campagne.

## Esterni (issue #7), primo blocco: pixel proprietario e conversioni lato server

Fatto:
- Pixel proprietario: endpoint pubblico di raccolta per chiave del negozio (CORS, elenco delle origini consentite, limite per IP cifrato), script per qualsiasi negozio e codice del pixel personalizzato di Shopify (Eventi dei clienti, senza app). Ogni sessione diventa un punto di contatto con canale e campagna; checkout ed email cifrate collegano i browser agli ordini, anche tra dispositivi; il job ogni 5 minuti assegna le sessioni all'ordine che hanno preceduto. L'attribuzione multi-touch le legge senza modifiche.
- Conversioni lato server: interfaccia `ConversionSink` con adapter reali per Meta Conversions API e conversioni da clic di Google Ads (testati su payload registrati, nessuna chiamata di rete) e mock di default. Id evento stabile per ordine (deduplica col pixel del browser), dati del cliente solo come hash SHA-256, regola sul consenso marketing, coda con ritentativi e registro degli invii.
- Pagina Integrazioni → Pixel e conversioni: salute del pixel, codici da copiare, impostazioni per piattaforma, esecuzione della coda, registro. Guida all'attivazione in tre lingue con i passi da verificare segnati.
- Seed: traffico del pixel degli ultimi 14 giorni su entrambi i negozi e registro delle conversioni dell'ultima settimana.
- Migrazione 0016 (5 tabelle con RLS); test core 145, integrazioni 36, servizi 75, db 486, e2e 63.

## Esterni (issue #7), secondo blocco: sondaggio post-acquisto

Fatto:
- Sondaggio a una domanda ("Come ci hai conosciuto?") ospitato da Keel su `/s/<negozio>`, raggiungibile dal link nell'email di conferma dell'ordine. Il link è firmato per ordine con il segreto del negozio: il modello email di Shopify lo calcola col filtro `hmac_sha256`, senza chiamare Keel. Una sola risposta per ordine; opzioni e testi in tre lingue, ognuna collegata a un canale, anche canali che i clic non vedono (passaparola, influencer, podcast).
- Analisi → Sondaggio: risposte, tasso di risposta, confronto tra canale dichiarato e canale dei clic, risposte libere, impostazioni e link da incollare nell'email.
- Nuovo modello di attribuzione "Misto con sondaggio": negli ordini con risposta una quota del merito, configurabile, va al canale dichiarato; il resto segue il decadimento nel tempo.
- Guida all'attivazione in tre lingue. Seed: sondaggio attivo su entrambi i negozi con risposte sul 30% degli ordini degli ultimi 120 giorni.
- Migrazione 0017 (2 tabelle con RLS); test core 149, servizi 78, db 498, e2e 65.

## Esterni (issue #7), terzo blocco: assistente AI

Fatto:
- Assistente AI nel core (decisione del committente): ogni negozio collega la propria chiave API Anthropic in Integrazioni e paga il consumo direttamente ad Anthropic. Senza chiave la pagina Assistente spiega come ottenerla e porta a Integrazioni. Guida all'attivazione in tre lingue con i passi da verificare segnati.
- Pagina Assistente con conversazioni private per utente, domande suggerite in base al ruolo e contatore di domande e token del mese.
- L'assistente risponde solo leggendo: sette strumenti sopra i servizi di analisi (KPI, conto economico, prodotti, campagne, resi, previsioni clienti, stock da riordinare), offerti solo se il ruolo dell'utente vede la pagina corrispondente. Sotto ogni risposta le citazioni: numeri, periodo, filtri e link alla pagina da cui vengono.
- Interfaccia `LlmProvider` con adapter Anthropic (SDK ufficiale, testato su risposte registrate, nessuna chiamata di rete) e modello simulato deterministico: nella demo il testo è essenziale ma i numeri e i link sono reali. "Testa connessione" verifica la chiave senza consumare token.
- Seed: chiave simulata collegata su entrambi i negozi, con una conversazione di esempio (prodotti più venduti degli ultimi 30 giorni) in italiano su Northwind e in inglese su Harbor.
- Landing allineata: l'assistente è incluso in tutti i piani ("con la tua chiave Anthropic"), tolto l'add-on AI Studio a consumo; nuova slide "Assistente AI" nel carosello dei moduli con screenshot reali (en, it), il passo "Collega" e la guida citano la chiave Anthropic, nuova domanda frequente su chi paga e cosa vede l'assistente.
- Integrazioni: quarta scheda "AI (Anthropic)" accanto a Shopify, Meta e Google, con collega, testa connessione e guida.
- Migrazione 0018 (2 tabelle con RLS); test core 153, integrazioni 45, servizi 87, db 510, e2e 70.

Resta per la issue #7: email di stato ai clienti, validazione indirizzi, pagine guida mancanti.

## Scritture verso le piattaforme e sync affidabili (issue #24)

Fatto:
- Outbox `platform_writes`: ogni scrittura verso Shopify, Meta o Google è una riga con chiave di idempotenza, scritta nella stessa transazione della modifica locale. Va al job pg-boss `platform.write` quando c'è il worker, altrimenti parte subito dopo la richiesta. Ritentativi con attesa crescente: prima il Retry-After della piattaforma, poi 30 s × 2^n fino a 1 ora, al massimo 6 tentativi. Gli errori permanenti (permessi, richiesta non valida) falliscono subito con un messaggio leggibile.
- Il tick `writes`, ogni minuto, esegue le scritture scadute e si ferma sul rate limit del fornitore.
- Doppio clic o azione ripetuta entro 10 minuti: stessa riga, una sola scrittura sulla piattaforma (test con `failNext("rate_limited")`). Un valore più recente sostituisce le scritture ancora in attesa sullo stesso oggetto.
- Migrate in coda: prezzo e stato prodotto, annullamento ordine, codice sconto singolo, stock al ricevimento dell'ordine d'acquisto e nei trasferimenti, pausa e riattivazione su Meta. Google viene rifiutato subito (sola lettura).
- Restano sincrone ma registrate nell'outbox, perché il flusso ha bisogno della risposta: tag e annullamento COD, modifiche contatto e ordine sostitutivo COD, passi del write-back resi (con chiave per reso e passo), pool di codici sconto.
- Badge "In attesa di sync" / "Sync non riuscito" con Riprova su prodotto (stato, prezzo, stock), ordine, sconto e campagna. Integrazioni → nuova scheda "Scritture verso le piattaforme" con conteggi, errori e Riprova. Come aggiungere un nuovo tipo di scrittura è spiegato in ARCHITECTURE.
- `sync_runs` con letti, modificati, conflitti, errori, durata e riepilogo, mostrati nella tabella delle esecuzioni sulla pagina Integrazioni.
- Sync del catalogo riprendibile a fasi con cursore salvato a ogni pagina; la notturna è una riconciliazione completa e alla fine azzera i livelli che la piattaforma non riporta più.
- Stock riletto subito dopo i webhook `orders/*`, `fulfillments/*` e `refunds/create` (nuovo topic registrato). Pulsante "Sincronizza ora" nella pagina Magazzino.
- Registro degli scostamenti di stock (`inventory_drift`), deduplicato: variazioni non spiegate da vendite o annullamenti, valori negativi riportati a zero, livelli non più riportati. Un livello con una scrittura Keel non ancora confermata non viene sovrascritto e conta come conflitto. Scheda "Scostamenti di stock" nella pagina Magazzino.
- Il mock commerce tiene lo stock per articolo e location partendo dai livelli del negozio: gli ordini lo scalano e le scritture lo aggiornano.
- Retention giornaliera (04:10) con finestra di piattaforma `KEEL_RETENTION_DAYS`, predefinita 14 giorni. Cancella webhook elaborati, scritture riuscite o sostituite, esecuzioni riuscite e scostamenti vecchi; webhook e scritture fallite restano finché non vengono risolti. Le code pg-boss usano la stessa finestra.
- Seed: per entrambi i negozi scritture riuscite, una fallita con errore leggibile e una in attesa dopo un rate limit, esecuzioni di riconciliazione notturna (ordini e catalogo) e tre scostamenti di stock.
- Migrazione 0019 (2 tabelle con RLS, 5 colonne con default su `sync_runs`, nessun SQL scritto a mano). Test: servizi 95 (8 nuovi), addon-cod 20, db 522, integrazioni 45, core 153, web 3; e2e `platform-writes.spec.ts` (3).

Integrazione con #22 e #23:
- La modifica ordini del core (dati di contatto, ordine sostitutivo, annullamento degli originali, sconto sull'ordine) scrive in modo sincrono ma registrato nell'outbox; il nuovo tipo è `order.discount`.
- Il costo prodotto verso Shopify (`variant.cost`) passa in coda insieme alla modifica locale, sia da modifica manuale sia da import CSV, quando il negozio ha attivato la scrittura del costo.
- La migrazione è stata rigenerata come 0022.
## Notifiche, email e attività (issue #33)

Fatto:
- Pagina Notifiche con filtri per stato e tipo, letto/da leggere per riga e "segna tutte come lette"; la campanella porta a "Vedi tutte" e mostra i testi tradotti.
- Preferenze per utente, per tipo × canale (in app, email, Slack), applicate dal server a ogni invio. Nuovi tipi: ritardo di sincronizzazione, stock critico senza ordini d'acquisto in arrivo (`stock_critical_no_po`), spedizioni in ritardo oltre la soglia (soglie nelle impostazioni del negozio), controllati ogni ora dal job `notify`. Riepilogo giornaliero via email su richiesta (job `digest`).
- Modelli email in en/it/es (invito, link di accesso, menzione, ordine al fornitore, riepilogo, notifica generica) con testo e HTML, inviati dal mailer esistente (mock in sviluppo). Lista di blocco per negozio: rimbalzi e segnalazioni bloccano tutto, le disiscrizioni la loro categoria. Link di disiscrizione firmato per destinatario verso una pagina pubblica, disiscrizione con un clic per i client di posta, webhook dei rimbalzi; pagina "Email bloccate" per titolare e amministratori.
- "Le mie menzioni": note con @menzioni su ordini, ordini d'acquisto e resi (nuovo pannello note su ordini d'acquisto e resi).
- Attività dello staff collegate a ordini, resi, ordini d'acquisto e prodotti, con assegnatario, scadenza e stato; pagina "Le mie attività" (mie, del team, non assegnate; aperte, scadute, chiuse) e scheda attività sulle pagine dei record. Regole configurabili che aprono attività sugli eventi e le chiudono quando il record va avanti; tre regole predefinite (reso ricevuto → ispeziona, ordine d'acquisto in ritardo → sollecita il fornitore, ordine in sospeso da più di 72 ore → rivedi).
- Supporto: richiesta dal pulsante Aiuto nell'intestazione con allegato, risposta dalla console in `/admin/support`, notifica all'autore; ogni azione nel registro di audit.
- Seed: regole predefinite e attività aperte e chiuse, preferenze, menzioni, notifiche dei nuovi tipi, una richiesta di supporto con risposta e una aperta con allegato, due indirizzi bloccati, su entrambi i negozi.
- Migrazioni 0019 (8 tabelle con RLS) e 0020 (due colonne con default su `notifications`); test core 165, integrazioni 47, servizi 96, db 558, e2e 6 nuovi.

Resta: firma dei webhook del provider email da verificare sul fornitore scelto; le attività sugli ordini si aprono e chiudono col job ogni 10 minuti, non all'istante.
## Costo prodotto (issue #23)

Fatto:
- Origine del costo per variante (`cost_source`: Shopify, a mano, import CSV, ordine d'acquisto) e data dell'ultimo aggiornamento, mostrate nella scheda prodotto.
- Sync Shopify: legge `inventoryItem.unitCost` e lo usa solo se Keel non ha un costo (o se quello attuale viene già da Shopify); un costo da ordine d'acquisto, a mano o importato non viene mai sovrascritto. Fixture e test del mapper aggiornati; l'adapter simulato riporta il costo unitario.
- Scheda prodotto: costo per variante e "stesso costo per tutte le varianti", con scelta sugli ordini passati (solo quelli senza costo, oppure ricalcolo di tutti). Ogni modifica scrive una riga di audit con il diff. Scrittura facoltativa del costo su Shopify (`inventoryItemUpdate`) dietro l'impostazione `costWriteBack`, spenta di default.
- Import CSV (SKU, costo, SKU fornitore facoltativo) in due passi: anteprima con righe abbinate, invariate, non trovate, ambigue e non valide, senza scrivere nulla; poi conferma, con una riga di audit per l'import. Parsing e abbinamento sono funzioni pure in `packages/core`.
- Pagina Prodotti → Qualità dati: varianti senza costo, SKU, barcode o immagine e SKU duplicati, con filtri e conteggi; conteggio nella coda di lavoro della dashboard e link dalla lista prodotti.
- Conto economico: "N ordini contengono prodotti senza costo (X% del ricavo netto)" con link alla lista ordini filtrata (nuovo filtro `missingCost=1`) e affidabilità del costo per origine sul ricavo di vendita.
- Quando una variante riceve un costo che non aveva (sync, modifica, import, ricevimento di un ordine d'acquisto) le righe d'ordine senza costo vengono completate, così il conto economico successivo le conta.
- Seed: origine del costo su tutte le varianti, un prodotto venduto senza costo, alcune varianti senza barcode, alcuni prodotti senza immagine, uno SKU duplicato.
- Migrazione 0019 (2 colonne nullable su `product_variants`); test core 161, integrazioni 47, servizi 92, db 510; e2e +4 scenari (`catalog-costs.spec.ts`).
## Modifica degli ordini nel core (issue #22)

Fatto:
- Servizio di modifica nel core (`packages/services/src/orders/edit.ts`), valido per ogni metodo di pagamento: contatti, indirizzo di spedizione e fatturazione, email, telefono e nota su qualsiasi ordine aperto non ancora evaso, scritti prima sulla piattaforma (`updateOrderDetails`) e poi in Keel, con evento `modified` (autore e diff dei campi). L'indirizzo di spedizione passa il controllo di formato (campi obbligatori, CAP per paese).
- Cambio righe e unione di ordini dello stesso cliente come annulla-e-ricrea con storia (`replaces` / `replaced_by` / `lineage_root`): il nuovo ordine eredita giorno di creazione, attribuzione, canale, assegnatario e stato del pagamento; l'ordine sostituito è uno stato finale (annullato, motivo `override:replaced`) ed è escluso da KPI, conto economico, CRM, storico cliente e duplicati, così i report contano un solo ordine. Banner della storia nel dettaglio ordine; unione proposta anche dal banner dei duplicati.
- Sconto su un ordine esistente (preimpostato o personalizzato, % o importo) tramite il nuovo `CommercePlatform.applyOrderDiscount` (mock e Shopify con l'API di modifica ordini), con evento e rimborso dovuto segnalato sugli ordini pagati.
- Slot `AddressProvider` (autocompletamento e validazione) con mock deterministico, usato dal dialogo di modifica.
- `addon.cod` chiama i servizi del core e aggiunge solo i suoi extra (tentativo di chiamata, tag della coda, passaggio della coda al nuovo ordine) tramite hook; stesso dialogo in variante COD.
- Permessi: owner, admin, operations, customer care possono modificare; marketing e viewer no (azione `edit_order`, verificata lato server). Testi in en/it/es.
- Migrazione 0019 (colonna `lineage_root_order_id`, nullable); test core 166, config 8, integrazioni 48, servizi 93, add-on COD 20, db 510; e2e `order-edit` (4) più `cod` e `orders` verdi sulla build di produzione.

Resta: provider indirizzi reale e la sua guida (issue #7); preset di sconto configurabili per negozio se richiesti.
## Correzioni: dati demo in produzione (#18), menu a tendina (#15), lingua e date

Fatto:
- #18: ogni deploy crea le righe di configurazione che mancano ai due negozi demo (portale e politica resi, motivi tradotti, pixel, conversioni, sondaggio, tag contrassegno, chiave AI simulata, costi dei resi) senza toccare ordini né righe modificate da qualcuno (`pnpm db:seed:settings`, dentro `db:deploy`). Il seed completo resta manuale (`KEEL_SEED_ON_DEPLOY=1` solo per il primo deploy o un reset voluto). La pagina del portale avvisa quando è spento; `pnpm smoke <url>` controlla salute, login e i due portali dopo il deploy.
- #15: `Select` e `Input` hanno due altezze condivise (`sm`, `default`) e il testo centrato; niente più `<select>` grezzi né altezze impostate a mano (un test lo impedisce); controllo Playwright che il testo stia nel riquadro.
- Lingua: date e numeri seguono la lingua mostrata a schermo; il selettore salva la lingua sul profilo e l'accesso la ripristina.

## Liste: azioni in blocco, viste salvate, ricerca ⌘K, export CSV (issue #25)

Fatto:
- Selezione delle righe su Ordini, Prodotti e Resi con barra delle azioni in blocco: ordini (cambia stato, annulla, assegna, tag), prodotti (stato, prezzo fisso o in percentuale, prezzo barrato, tag), resi (approva, rifiuta, ricevi con rientro a stock facoltativo, rimborsa). Al massimo 3 scritture in parallelo; riepilogo "fatti / saltati con motivo / falliti con errore"; un `batch_id` in ogni riga di audit e in ogni evento della timeline. Le azioni compaiono solo ai ruoli che le possono eseguire (matrice in `packages/config/src/lists.ts`).
- Viste salvate per Ordini, Prodotti, Resi, Clienti e Ordini d'acquisto: private o condivise con il team, si riaprono con gli stessi filtri e lo stesso ordinamento; salvare con lo stesso nome aggiorna la vista.
- Ricerca globale ⌘K / Ctrl+K nell'intestazione: ordini (numero, nome, email, telefono in formato internazionale o locale), clienti, prodotti e SKU, ordini d'acquisto, in una sola richiesta dentro la transazione del tenant; ogni risultato apre il record.
- Filtri `?product=` e `?variant=` sugli Ordini, con link dalla scheda prodotto e da Performance prodotti in Analisi.
- Export CSV della lista filtrata per Ordini, Prodotti, Clienti e Resi: fino a 5.000 righe scarica subito, oltre parte un job in background, il file compare nella pagina Export e arriva una notifica. Ogni export e ogni download nel registro di audit.
- Seed: viste salvate condivise e private sui due negozi e un export completato.
- Migrazione 0022 (tabelle `saved_views` e `list_exports` con RLS, indici trigram per la ricerca, indice su `order_lines.product_id`); test core 192, config 10, integrazioni 53, servizi 116 (+9 in `lists.test.ts`), db 571; e2e `lists.spec.ts` (6 scenari).

Resta: le scritture verso la piattaforma delle azioni in blocco passeranno dalla coda della issue #24 quando sarà unita; le azioni singole sulle schede non usano ancora i nuovi servizi di scrittura; "seleziona tutti i risultati del filtro" (oltre la pagina) non c'è; export CSV degli ordini d'acquisto e delle tabelle di analisi arrivano dai rispettivi rami.
## Stile A, tema scuro e branding (#44); profilo utente e saluto (#45)

Fatto:
- Direzione visiva A scelta dal committente: Geist (ospitato nel repository, nessun download a build o a runtime), superfici bianche, barra laterale chiara, blu `#2b59ff` (scuro `#5b7cff`), angoli di 8px, badge a pillola. Token in `packages/ui/src/tokens.css` e `tokens.ts`, importabili anche dalla landing; test automatico di contrasto WCAG AA su tutte le coppie testo/controllo nei due temi (tre colori di stato scuriti di poco per superarlo). Grafici con palette Okabe-Ito leggibile in entrambi i temi; regola di lint che blocca classi di palette e colori esadecimali in `apps/web`.
- Tema Chiaro / Scuro / Sistema salvato sul profilo e applicato dal server su `<html>`: nessun lampo del tema sbagliato al caricamento. Densità Comoda / Compatta (righe delle tabelle e padding delle schede).
- Impostazioni → Branding (owner/admin): colore del marchio regolato automaticamente per restare AA nei due temi, logo per sfondi chiari e scuri. È il colore primario dell'app per quel tenant e il predefinito di portale resi, tracking, pagina fornitori e sondaggio, che restano chiari e mantengono le loro personalizzazioni. Demo: Harbor Home ha il suo colore, Northwind il blu del prodotto.
- `/admin/styleguide`: token, componenti reali nei due temi, varianti del colore del marchio e delle densità.
- Profilo (`/t/<tenant>/profile` e `/admin/profile`, dal menu utente): nome, nome preferito, foto (ridimensionata sul server), ruolo aziendale; lingua (vuota = lingua dello spazio di lavoro), tema, densità, fuso orario; cambio password con controllo di robustezza, cambio email con conferma sul nuovo indirizzo e avviso al vecchio, "esci da tutte le altre sessioni", ultimi accessi; spazi di lavoro e ruoli. Ogni modifica nell'audit con diff, limiti di frequenza su password ed email.
- Chi non ha un nome completa il profilo prima di entrare; `displayName` (nome preferito → nome → parte dell'email prima di @) sostituisce ogni ripiego sull'email.
- Saluto in cima alla dashboard ("Buongiorno, Giulia") calcolato sul server nel fuso dell'utente, con la data di oggi e gli ordini del giorno.
- Migrazione 0019 (tabelle `tenant_branding` con RLS e `user_sign_ins` di piattaforma, colonne nullable su `users`); test core 178, servizi (account e branding) 9, db 517, web 28, e2e: nuovi `theme.spec.ts` e `profile.spec.ts`. Screenshot rifatti: tutte le pagine in chiaro (en, it) e 16 pagine principali in scuro in `docs/screenshots/<lingua>/dark/` (`THEMES=light,dark` nello script).

Resta: il fuso orario dell'utente vale per saluto, data e accessi; report e liste restano nel fuso del tenant (vedi DECISIONS). Collegamenti (token personali #21, preferenze notifiche #33) da aggiungere al profilo quando esisteranno.
## Analisi approfondita: P/L per ordine, P/L nel tempo, prodotti con ads e stock, UTM (issue #31)

Fatto:
- Dettaglio ordine: scheda "Economia dell'ordine" (vendite lorde, rimborsi, imposte, ricavo netto, costo del venduto, spedizione, commissione di pagamento stimata, margine, costi dei resi, contribuzione), uguale a `orderEconomics` dell'ordine; visibile solo ai ruoli che vedono l'analisi.
- Nuova scheda Analisi → "P/L per ordine": ogni ordine di vendita del periodo con il suo P/L, filtri (numero, metodo di pagamento, canale, costo mancante, in perdita), ordinamento, paginazione lato server, totali dei filtrati, esportazione CSV e riconciliazione al centesimo col P/L del periodo (fattura del corriere vs stima, costi dei resi per data di rientro, pubblicità, costi fissi).
- Conto economico per giorno, settimana, mese, trimestre, anno con periodi parziali segnati, grafico con costi impilati e linea del risultato operativo, tabella paginata e CSV; la somma dei periodi è il P/L del periodo al centesimo.
- Scheda Prodotti: unità, ricavo netto, costo del venduto, spesa delle campagne collegate, profitto, ROAS/ROI, semaforo, stock + in arrivo, copertura, azione di stock consigliata con pezzi da riordinare, riga "spesa non attribuita" (totale = spesa del periodo), filtri, ordinamento, paginazione, CSV.
- Scheda UTM: drill-down sorgente → mezzo → campagna → contenuto → termine con ordini, ricavi, ricavo netto, scontrino medio e quota; trend dei canali nel tempo con la stessa suddivisione per periodi; CSV.
- Widget "Qualità dei dati" nella panoramica: ordini di vendita con costi mancanti (link alla lista filtrata di #23), varianti senza costo (link a Prodotti → Qualità dati), quota di ricavo con costo noto.
- Lista ordini: nuovi filtri `product`, `attrChannel`, `utmSource`…`utmTerm` con chip rimovibili, così ogni numero porta agli ordini che lo compongono.
- Calcoli puri in `packages/core` (`pnl-periods.ts`, `product-profit.ts`, `utm-report.ts`) con test; servizi in `packages/services/src/analytics/pnl-depth.ts` con test di riconciliazione sui dati demo.
- Nessuna migrazione, nessuna modifica al seed. Test core +25, servizi +6, e2e `analytics-pnl.spec.ts` (5 scenari) più `analytics.spec.ts` aggiornato.

Resta: commissioni di pagamento effettive per ordine (#27); suddivisione per periodi nel fuso del negozio (oggi UTC come costi di periodo e spesa ads); il seed non ha `utm_term`, quindi l'ultimo livello UTM è "(nessuno)" sui dati demo.

## Blocchi

Nessuno. Docker daemon assente nell'ambiente cloud: usato PostgreSQL 16 di sistema (vedi DECISIONS).

## Acquisti in profondità (issue #29)

Fatto:
- Fornitore predefinito per variante (SKU fornitore, costo, MOQ, multiplo, tempo di consegna) dalla nuova sezione "Fornitori e confezioni" della scheda prodotto, per singola variante o per tutte le varianti del prodotto, e in blocco dalla pagina fornitori (tipo di prodotto, marca, prefisso SKU, solo varianti senza fornitore). Pianificazione e bozze automatiche usano subito fornitore e costo scelti.
- Nuovo ordine d'acquisto con editor di righe: ricerca di qualsiasi variante per SKU, barcode o titolo, righe libere (descrizione, quantità, costo), suggerimenti di riordino aggiungibili uno a uno o tutti insieme. Lo stesso editor modifica gli ordini in bozza e inviati (righe sostituite, diff nell'audit); ogni ordine si può duplicare in bozza; bozze e annullati si possono eliminare. Scheda "Storico" nel dettaglio con le voci dell'audit.
- Lista ordini d'acquisto: ricerca (numero, fornitore, SKU, descrizione, note), periodo, destinazione, fornitore, stato ed esportazione CSV con gli stessi filtri.
- Confezioni (case pack) definite dal negozio su un'opzione qualsiasi con pezzi per valore, per tutti i prodotti con quell'opzione o per uno solo; pagina "Mix opzioni" per prodotto con quota di vendite per combinazione e per valore, suggerimento di cartoni per gruppo di opzioni e pianificatore che crea la bozza d'ordine (per quota di vendite o per confezioni). Calcoli puri in `packages/core/src/packs.ts`.
- Ispezione al ricevimento: per riga arrivati, danneggiati e scartati; solo le unità buone vanno a magazzino e aggiornano il costo; i valori restano sulla riga e nell'audit. Le righe libere si ricevono senza toccare lo stock.
- Link del fornitore più sicuri: token salvato solo come hash, scadenza a 30 giorni (costante in config), revoca, reinvio con nuovo token e revoca del precedente, pagina neutra per link scaduti o revocati (nessun dato dell'ordine), registro di ogni apertura e tentativo di risposta; stato dei link nel dettaglio ordine.
- Seed: fornitore predefinito su gran parte delle varianti (un prodotto su otto senza, per la funzione in blocco), una confezione per negozio (Northwind: taglie per tutti i prodotti con l'opzione; Harbor: cartone misto su un prodotto), una bozza con una riga libera e un link fornitore scaduto con la sua apertura bloccata.
- L'avviso giornaliero "variante critica senza ordine in arrivo" arriva dal tick delle notifiche (#33), non da questa issue.
- Migrazione 0020 (3 tabelle con RLS: `case_packs`, `supplier_links`, `supplier_link_views`; 2 colonne con default su `purchase_order_lines`); test core 176, servizi `purchasing-depth` 7 (più `planning` e `purchasing` aggiornati), db 529; e2e `purchasing-depth` (6) più `inventory` e `planning` verdi sulla build di produzione.

Resta: invio reale dell'email al fornitore (oggi il link si copia a mano in modalità demo); resi al fornitore per la merce danneggiata.

## Evasione e spedizioni (issue #28)

Fatto:
- Coda "da spedire in ritardo": ordini pronti da spedire (stato canonico confermato o in evasione, nessuna spedizione) oltre una soglia in giorni lavorativi nel fuso del negozio (nuove impostazioni `lateToShipBusinessDays` e `workdays`); conteggio in dashboard, notifica giornaliera (`checkLateToShip` di #33 aggiornato) e nuova metrica `late_to_ship` per le regole di avviso (una regola per negozio nel seed). Nessuna dipendenza dal metodo di pagamento.
- Bacheca imballo/spedizione `/fulfilment`: da imballare → imballati → spediti oggi, ricerca, vista "solo in ritardo", età in giorni lavorativi, selezione con distinte in blocco e "segna imballati" in blocco (`runBatch`). "Spedisci" chiama `CommercePlatform.createFulfillment` (Shopify `fulfillmentCreate`, mock) tramite l'outbox sincrono (`fulfillment.create`): l'ordine cambia solo dopo la conferma della piattaforma, con evento "Spedito da Keel" (autore, tracking, diff) e stato ricalcolato. Distinta PDF per ordine e in blocco con il writer PDF esistente.
- Coda eccezioni di consegna e revisione dei resi al mittente (`shipment_cases`): i casi si aprono da soli dallo stato risolto (import e passaggio orario), una sola persona li prende in carico, l'istruzione (nuovo tentativo, nuovo indirizzo, punto di ritiro, reso) parte una volta sola tramite `CarrierProvider` (mock) o email al corriere (nuovo template), il caso si chiude da solo quando la spedizione riparte. Resi al mittente con azioni suggerite (rimettere a stock, rimborsare se c'è un incasso, contattare il cliente) segnate fatte o saltate; nessuna automazione sui pagamenti.
- Editor della mappatura degli stati in Impostazioni → Evasione (con orologio delle spedizioni ed email del corriere); il risolutore legge la tabella (stato canonico, eccezione, finale) a ogni import.
- Migrazione 0026 (tabella `shipment_cases` con RLS e indice unico parziale; colonne nullable `orders.packed_at`, `orders.packed_by`). Seed: arretrato di ordini pagati non spediti da 5–12 giorni, alcuni pacchi imballati, almeno 3–5 eccezioni e 2–3 resi al mittente recenti per negozio con i loro casi (uno preso in carico, uno già istruito, una revisione a metà), regola di avviso sul ritardo.
- Test: core `fulfilment.test.ts` (11, compresa la proprietà soglia/giorni lavorativi in tre fusi), integrazioni (adapter Shopify su payload registrati, mock), servizi `fulfilment.test.ts` (11: soglia in giorni lavorativi, spedizione e rifiuto della piattaforma, presa in carico esclusiva concorrente, doppio invio bloccato anche in concorrenza, chiusura automatica, mappatura); e2e `fulfilment.spec.ts` (3 scenari).

Resta: spedizioni parziali dalla bacheca; calendario delle festività per i giorni lavorativi; connettori reali dei corrieri (slot `CarrierProvider`); automazione del contrassegno sui resi al mittente (issue dell'add-on).

## Email transazionale di piattaforma con Resend (issue #51)

Fatto:
- Un solo percorso per le email: `queueEmail` (packages/services/src/email) scrive il registro `email_messages`, controlla le liste di soppressione e mette in coda il messaggio cifrato; l'invio avviene sempre fuori dalla richiesta (job pg-boss `email.send` col worker, consegna in processo dopo la risposta senza worker), con retry a backoff, chiave di idempotenza per (modello, destinatario, evento) inviata anche al provider, e le email di sicurezza mai inviate né ritentate dopo la scadenza del link.
- Adapter `EmailProvider` in packages/integrations: `ResendEmailProvider` (header di idempotenza, timeout, mappatura errori rate limit / destinatario non valido / dominio non verificato / autenticazione) e `MockEmailProvider`; Resend solo con `RESEND_API_KEY` e `KEEL_INTEGRATION_MODE=live`, altrimenti mock. Test su payload registrati, nessuna rete.
- Modelli tipizzati con testi in `email/messages/{en,it,es}.json`, HTML + testo, layout con marchio e nome da `PRODUCT_NAME`, piè di pagina con mittente legale e indirizzo di supporto, colori della direzione A con variante scura; nuovi modelli conferma/avviso cambio email e prova. Snapshot di tutti i modelli nelle tre lingue.
- Registro di consegna senza corpo né link (destinatario come hash con chiave e mascherato), webhook Resend `/api/webhooks/email` con firma Svix, risposta immediata, coda e idempotenza per id evento; bounce permanenti e reclami nella lista di soppressione di piattaforma (le email di sicurezza ignorano preferenze e reclami ma non i bounce).
- Spostati sulla coda: notifiche e menzioni, riepiloghi (uno per utente al giorno), email al fornitore, inviti, email degli avvisi, cambio email, magic link (stampato in console solo in sviluppo).
- Console `/admin/email`: stato del provider ("Email non configurata" senza chiave), conteggi degli ultimi 7 giorni, registro con filtri (stato, modello, tenant/piattaforma, destinatario), invio di prova, indirizzi soppressi, guida. Guida Resend in tre lingue (account, dominio, SPF, DKIM, DMARC con badge "Da verificare", chiave di solo invio, variabili Railway, prova) anche in Integrazioni → Guida per i super-admin. Posta di sviluppo `/dev/emails` solo in sviluppo (404 in produzione).
- Migrazione 0026 (tabella `email_messages` con RLS lettura/inserimento per tenant, tabelle di piattaforma `email_events` ed `email_address_suppressions`); seed: registro demo per i due tenant e per la piattaforma, un bounce soppresso per tenant. Test: integrations `email.test.ts` 6 (adapter, firme, eventi) e +1 su hash e maschera, 3 test email del vecchio sink rimossi da `notify.test.ts`, servizi `email.test.ts` 12 (27 snapshot) più notifiche, account e avvisi aggiornati, config +1, web +1, db isolamento verde; e2e nuovo `email.spec.ts` (3) più login, profilo, notifiche e console verdi sulla build di produzione.

Resta: verificare la guida e i payload dei webhook su un account Resend reale; collegare le email di #52 (inviti, password dimenticata) ai modelli; le campagne (#34) riusano le liste di soppressione.

## Backorder dall'inizio alla fine (issue #26)

Fatto:
- Verifica dello stock per riga su ogni nuovo ordine importato e sull'ordine sostitutivo di una modifica (#22): le unità che lo stock non copre diventano un backorder collegato alla prima riga d'ordine d'acquisto in arrivo che le copre (stato "coperto"), altrimenti restano "in attesa" e si collegano quando un ordine d'acquisto viene confermato. Regole pure in `packages/core/src/backorders.ts`.
- L'ordine va in sospeso con motivo `hold:awaiting_stock` tramite il motore di stato (fatto `awaitingStock`, nessun tag), con evento in timeline; se il negozio lo vuole (impostazione, attiva di default) parte un blocco dell'evasione su Shopify via outbox (`order.fulfillment_hold` / `order.fulfillment_release`, `CommercePlatform.holdFulfillment` / `releaseFulfillment`, mock incluso).
- Dettaglio ordine: scheda "In attesa di stock" con ordine d'acquisto, fornitore, data prevista e quantità, e azione "Annulla attesa" (con nota, evento con autore e diff, blocco tolto anche sul negozio); scheda "Verifica stock" per riga con disponibile, impegnato, in arrivo (ordine d'acquisto, stato, data).
- Scheda prodotto: griglia opzione × opzione (disponibile, +in arrivo, −impegnato per cella) su qualsiasi coppia di opzioni scelta dall'utente, le altre sommate nella cella; i totali coincidono con i livelli di stock.
- Lista ordini: viste "In attesa di stock" e "Pronti da sbloccare" (filtro `stock` in `orderListWhere`, quindi valide anche per esportazione CSV e viste salvate) con conteggi. Dashboard: riquadro con ordini in attesa di stock e prodotti più venduti sotto la soglia di stock.
- Sblocco: al ricevimento di un ordine d'acquisto, alla conferma/annullamento/modifica di un ordine d'acquisto e con il nuovo job di sicurezza ogni 10 minuti (`backorders`), gli ordini coperti dallo stock vengono sbloccati con evento, notifica `stock_available` (assegnatario o team operativo) e rimozione del blocco sul negozio. Ordini annullati, sostituiti o evasi sul negozio smettono di attendere.
- Impostazioni → operative: due interruttori (metti in sospeso gli ordini senza stock; blocca anche l'evasione sul negozio). Scope Shopify `read/write_merchant_managed_fulfillment_orders` aggiunti al modulo ordini.
- Seed: gli ordini demo in backorder sono in sospeso con i loro eventi, la variante è esaurita e su ogni negozio almeno uno attende un ordine d'acquisto in arrivo con data prevista.
- Migrazione 0026 (due indici su `backorders`, additiva). Test: core +9 (`backorders.test.ts`), integrazioni +3 (fixture Shopify e mock), servizi `backorders.test.ts` (7: sospensione → ricevimento → sblocco con notifica e blocco tolto sul mock, stock parziale, ordini non ancora riflessi nel livello, annullamento, modifica d'ordine, griglia = livelli, riquadro), e2e `backorders.spec.ts` (3) più orders, order-edit, purchasing-depth, inventory, lists, state-rules, platform-writes, tenancy, notifications verdi sulla build di produzione.

Resta: verificare su un negozio reale handle e blocchi multipli di `fulfillmentOrderHold` (API 2025-01+); il blocco su Shopify riguarda tutto il fulfillment order, non la singola riga; nessuna verifica retroattiva sugli ordini aperti già importati.
