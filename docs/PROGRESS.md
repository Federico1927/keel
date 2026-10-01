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
| 8 | da fare | |
| 9 | da fare | |
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

## Blocchi

Nessuno. Docker daemon assente nell'ambiente cloud: usato PostgreSQL 16 di sistema (vedi DECISIONS).
