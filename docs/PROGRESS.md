# Progress

Stato aggiornato da Claude Code a ogni fase (CLAUDE.md §1). Alla ripresa di una sessione: rileggere `CLAUDE.md`, questo file e `docs/DECISIONS.md`, poi continuare dalla prima fase non completata.

| Fase | Stato | Note |
| --- | --- | --- |
| Studio | fatta | `docs/reference/INVENTORY.md` + note dettagliate in `docs/reference/study/` |
| 0 | fatta | Monorepo pnpm+turbo, Next 15, Drizzle, Postgres 16 di sistema (Docker non disponibile), next-intl en/it/es, Auth.js password + magic link, login in 3 lingue, lint/typecheck/test/build verdi |
| 1 | fatta | Contesto tenant da slug + appartenenza, guardie pagina/azione (ruolo × modulo), shell applicativa con navigazione filtrata, impostazioni tenant, utenti e ruoli, registro attività, audit diff-only, suite generica di isolamento RLS su ogni tabella con `tenant_id` (29 test verdi), e2e permessi |
| 2 | fatta | Enum canonici e motore `state_rules` in core (test), schema di dominio completo (35 tabelle, tutte con RLS), interfacce adapter + mock con simulazione webhook/errori, seed deterministico (15k + 6k ordini in ~40 s), pagina regole di stato con anteprima su 50 ordini |
| 3 | fatta | Lista ordini con ricerca server-side (numero esatto o trigram), filtri, conteggi per stato, paginazione; dettaglio con timeline (autore + diff), note interne con @menzioni e notifiche, storico cliente a 3 hop, duplicati, attribuzione, spedizioni; azioni cambia stato / annulla (via adapter) / assegna; pagina spedizioni con KPI, viste ferme/eccezioni, resolver multi-fonte |
| 4 | da fare | |
| 5 | da fare | |
| 6 | da fare | |
| 7 | da fare | |
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

## Blocchi

Nessuno. Docker daemon assente nell'ambiente cloud: usato PostgreSQL 16 di sistema (vedi DECISIONS).
