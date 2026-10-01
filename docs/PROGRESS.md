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
| 10 | da fare | |
| 11 | da fare | |
| 12 | da fare | |

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

## Blocchi

Nessuno. Docker daemon assente nell'ambiente cloud: usato PostgreSQL 16 di sistema (vedi DECISIONS).
