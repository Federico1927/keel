# CLAUDE.md — Brief di sviluppo autonomo: "Hullwise"

> Nome del prodotto: **Hullwise** (lo scafo gestito con saggezza: la struttura che tiene stabile un e-commerce). Rinominato il 2026-10-02 (vedi `docs/DECISIONS.md`).
> Il nome deve stare in UNA costante (`PRODUCT_NAME` in `packages/config`) così si può cambiare in un minuto.
> Alternative valutate: Backroom, Opsdeck, Quarterdeck.

---

## 0. Missione

> **PRINCIPIO GUIDA, PRIMA DI OGNI ALTRA REGOLA: Hullwise deve essere utile a qualsiasi e-commerce, a prescindere dal metodo di pagamento.** Carta, wallet, PayPal, bonifico, BNPL e contrassegno sono tutti metodi equivalenti nel core. **Il contrassegno NON è l'elemento principale:** è un add-on (`addon.cod`) attivato solo su alcuni account. Nessun modulo del core, nessuna schermata principale, nessun KPI di default e nessuna scelta di modello dati deve presupporre il contrassegno. Se una funzione ha senso solo per chi incassa alla consegna, va nell'add-on.

Costruisci da zero, in autonomia, l'MVP di una piattaforma SaaS **multi-tenant e multilingua** per la gestione operativa di e-commerce di medie dimensioni. Il prodotto è il nocciolo generico di una piattaforma esistente costruita per un solo brand (calzature, Italia, contrassegno). Deve andare bene per **la maggior parte degli e-commerce** che vendono su Shopify e fanno pubblicità su Meta e Google.

Il modello di business, che l'architettura deve supportare:
- abbonamento mensile a tier;
- fee di installazione per collegare Shopify, Meta, Google;
- **moduli add-on e integrazioni ad hoc attivabili per singolo account** (esempio: gestione contrassegno, connettori per magazzini 3PL o provider WhatsApp locali);
- una **console super-admin** per il proprietario della piattaforma, con tutti i tenant, i pagamenti, i moduli attivi e lo stato delle integrazioni.

Il committente è assente durante lo sviluppo. **Non fare domande: decidi, documenta, procedi.**

**Contesto di partenza: due codebase da studiare prima di iniziare.**

Hai accesso in sola lettura a due piattaforme che Federico ha costruito per singoli clienti. I percorsi sono in `docs/reference/SOURCES.md`; se un percorso non è compilato, cerca i repository nelle cartelle vicine a questa e annota in `DECISIONS.md` dove li hai trovati. Se non li trovi, procedi senza e segnalalo in `PROGRESS.md`.

1. **Control Room / Command Center** (e-commerce di calzature, Italia). Leggi prima `docs/team/` e `.lovable/memory/` del repository, poi il codice. L'analisi in `docs/reference/command-center-analysis.md` ti dà la mappa dei moduli.
2. **Rehaus** (e-commerce in conto vendita). Inventariane le funzionalità e cerca soluzioni generiche riusabili: gestione prodotti e magazzino, flussi operativi, dashboard, integrazioni, componenti UI.

**Cosa prendere** (logica e pattern generici, utili a qualsiasi negozio):
- webhook con risposta immediata, elaborazione in coda, retry e idempotenza; riconciliazioni notturne; backfill riprendibili;
- timeline dell'ordine con autore e diff, note interne con menzioni, storico cliente con match su più campi;
- stato della spedizione calcolato da più fonti con precedenze;
- P/L per ordine, margine e profitto per campagna, campagne collegate allo stock con azioni suggerite, registro giornaliero delle ads;
- segmenti con gruppi E/O, RFM, gruppo di controllo per misurare l'effetto delle campagne;
- acquisti, merce in arrivo, backorder collegati agli ordini d'acquisto, riordini basati su velocità e copertura;
- salute delle integrazioni, ruoli e permessi, notifiche, connettore MCP.

**Cosa NON prendere nel core:** coda di conferma, assegnazione degli operatori, delivery score e rischio destinatario sono logica da contrassegno: servono **solo** per l'add-on `addon.cod` nella fase 11. Niente tag del cliente, Elogy, Qapla', GLS, Spoki, taglie di calzature, IVA fissa, Italia come default, dominio o prefissi dei clienti.

**Regole sul codice sorgente dei clienti:** sola lettura; non copiare file `.env`, chiavi, token o dati personali; non collegarti ai loro database o alle loro API; riscrivi la logica per il modello canonico di Hullwise invece di copiare il codice, salvo utility pure e generiche. In caso di conflitto vale sempre questo file.

---

## 1. Regole di autonomia (obbligatorie)

1. **Non chiedere mai conferme.** Quando una scelta è ambigua, prendi la più semplice che non chiude l'estensibilità e scrivila in `docs/DECISIONS.md` (data, decisione, alternative scartate, motivo).
2. **Lavora per fasi** (sezione 9). A fine fase: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` devono passare. Poi commit con messaggio `phase-N: <descrizione>`.
3. **Aggiorna `docs/PROGRESS.md`** a ogni fase: cosa è fatto, cosa manca, problemi aperti. Se la sessione si interrompe, alla ripresa rileggi questo file e `PROGRESS.md` e continua dal punto in cui eri.
4. **Se resti bloccato tre volte sullo stesso problema**, documentalo in `PROGRESS.md` sotto "Blocchi", implementa un fallback o uno stub dichiarato, e passa oltre. Non fermarti.
5. **Nessuna credenziale reale.** Nessuna chiamata di rete verso Shopify, Meta o Google durante lo sviluppo. Tutto deve funzionare in **modalità mock** (sezione 6).
6. **Profondità prima dell'ampiezza dentro ogni modulo**: un modulo con lista, dettaglio, azioni principali e test vale più di tre moduli con sole liste.
7. **Codice, commenti, documentazione tecnica e nomi in inglese.** Testi dell'interfaccia solo tramite file di traduzione (sezione 5).
8. Non chiudere la sessione finché tutte le fasi non sono completate o documentate come bloccate.
9. **Ogni funzionalità completata va unita a `main` subito** (richiesta esplicita del committente, 2026-10-01). `main` viene pubblicato automaticamente su Railway, quindi:
   - prima del merge devono passare `pnpm lint && pnpm typecheck && pnpm test && pnpm build` e la suite e2e sulla build di produzione;
   - commit e push sul branch di lavoro, poi PR verso `main` con riepilogo e merge (metodo `merge`, mai force-push su `main`);
   - le migrazioni devono essere additive e compatibili con il codice già in produzione (colonne nuove nullable o con default, niente rinomina o cancellazione nello stesso merge);
   - dopo il merge, riparti dal nuovo `main` sullo stesso branch per la funzionalità successiva;
   - una funzionalità a metà non si unisce: si unisce quando è completa e verificata.
10. **Ogni richiesta del committente diventa una issue GitHub** (richiesta del 2026-10-01). Apri la issue appena arriva la richiesta, con perimetro e stato; la PR che la completa la chiude (`Closes #N` nel corpo). Le issue sono il backlog durevole: alla ripresa di una sessione, oltre a `PROGRESS.md`, leggi le issue aperte.

---

## 2. Stack (decisioni già prese, non ridiscuterle)

- **Monorepo** pnpm + Turborepo:
  - `apps/web` — Next.js 15 (App Router), TypeScript strict
  - `packages/db` — Drizzle ORM, schema, migrazioni, seed
  - `packages/core` — dominio: stati canonici, regole, calcoli (puro, testabile, senza I/O)
  - `packages/integrations` — adapter (Shopify, Meta, Google, mock) dietro interfacce comuni
  - `packages/jobs` — job in background con pg-boss
  - `packages/config` — costanti, feature flag, piani
  - `packages/ui` — componenti condivisi (Tailwind + shadcn/ui)
- **Database**: PostgreSQL 16 via `docker-compose.yml`. Row Level Security per tenant (sezione 3).
- **Auth**: Auth.js con email + password e magic link (in sviluppo il link viene stampato in console).
- **i18n**: next-intl.
- **Grafici**: Recharts.
- **Test**: Vitest (unit e integrazione con database reale in Docker), Playwright (e2e e screenshot).
- **Billing**: Stripe in test mode dietro un'interfaccia `BillingProvider`; implementazione `MockBillingProvider` di default.
- Avvio locale in un comando: `docker compose up -d && pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev`.
- **Regola di riserva se Docker non è disponibile** (per esempio in un ambiente cloud): non bloccarti. Installa PostgreSQL 16 direttamente nell'ambiente (pacchetto di sistema) oppure, se non è possibile, usa un Postgres embedded per sviluppo e test (es. `embedded-postgres` o PGlite). Lo schema, le migrazioni e le policy RLS devono restare identici: deve bastare cambiare `DATABASE_URL` per tornare a Docker. Annota la scelta in `docs/DECISIONS.md` e tieni comunque il `docker-compose.yml` nel repository per l'uso locale.
- **Ambiente cloud:** se lavori in una sessione cloud, fai commit **e push** alla fine di ogni fase, così il lavoro non si perde se la sessione si interrompe. I repository di riferimento sono su GitHub (URL in `docs/reference/SOURCES.md`): clonali in una cartella fuori da questo repository, mai dentro.

---

## 3. Multi-tenancy

- Ogni tabella di dominio ha `tenant_id uuid not null` con indice.
- RLS attiva su tutte le tabelle di dominio: le policy leggono `current_setting('app.tenant_id')`, impostato a ogni richiesta da un helper `withTenant(tenantId, fn)`. **Nessuna query di dominio fuori da `withTenant`.**
- Il ruolo super-admin usa una connessione separata con bypass esplicito, e ogni sua azione su un tenant viene scritta nell'audit log.
- **Test obbligatori di isolamento**: per ogni tabella, un test verifica che il tenant A non legga né scriva i dati del tenant B.
- Utenti: un utente può appartenere a più tenant, con ruolo per tenant: `owner`, `admin`, `operations`, `customer_care`, `marketing`, `viewer`. Permessi per pagina e per azione in una matrice in `packages/config`.
- Impostazioni per tenant: paese, valuta, fuso orario, lingua predefinita, aliquote IVA/tasse per paese, prefisso numeri ordine, soglie (stock basso, giorni copertura, ROI).

---

## 4. Modello di dominio canonico

Il punto più importante del progetto. La piattaforma originale ricavava lo stato degli ordini dai tag Shopify specifici del cliente: **qui non deve succedere.**

- **Ordine**: stato canonico interno, indipendente dalla fonte:
  `new → pending_review → confirmed → fulfilling → shipped → delivered`, più `on_hold`, `cancelled`, `returned_partial`, `returned`, `refunded`.
- **Regole di mappatura configurabili per tenant**: tabella `state_rules` con condizioni su tag, metodo di pagamento, stato finanziario, stato di evasione Shopify, e stato canonico risultante, con priorità. UI per gestirle e anteprima "su questi 50 ordini recenti la regola darebbe questo".
- **Pagamento**: metodo normalizzato (`card`, `wallet`, `bank_transfer`, `cod`, `bnpl`, `other`) e stato (`pending`, `paid`, `partially_refunded`, `refunded`, `voided`).
- Altre entità: `Customer` (match per id piattaforma, email normalizzata, telefono E.164 con libphonenumber), `Product`, `Variant` con attributi generici (non "taglia/colore" cablati: opzioni dinamiche), `InventoryLevel` per location, `Shipment` con eventi, `ReturnRequest`, `Discount`, `PurchaseOrder`, `Supplier`, `Campaign`, `AdMetricDaily`, `CampaignProductLink`, `Segment`, `OrderEvent` (timeline con autore e diff), `CostSetting`.
- **Ogni scrittura significativa genera un `OrderEvent` o un audit log** con autore (utente o sistema) e diff dei campi cambiati.
- Ogni calcolo economico (margine, profitto, ROAS) sta in `packages/core` come funzione pura, con test.

---

## 5. Multilingua

- Lingue: **en (default), it, es**. Struttura pronta per aggiungerne altre senza toccare il codice.
- Nessuna stringa visibile hardcoded nei componenti. Un test o uno script di lint fallisce se trova chiavi mancanti tra le lingue.
- Date, numeri e valute sempre con `Intl` secondo le impostazioni del tenant e dell'utente.
- Lingua scelta per utente, con fallback a quella del tenant.

---

## 6. Integrazioni

### 6.1 Architettura ad adapter

Interfacce in `packages/integrations`:
- `CommercePlatform` (ordini, clienti, prodotti, inventario, evasioni, resi, sconti, webhook)
- `AdsPlatform` (campagne, metriche giornaliere, pausa/riattivazione)
- `AnalyticsPlatform` (facoltativa, per GA4)
- `MessagingChannel`, `WarehouseProvider`, `CarrierProvider`: **solo interfacce e implementazione mock**. Sono gli slot per le integrazioni ad hoc vendute per account (esempi documentati: un 3PL, un provider WhatsApp locale). Non implementare connettori specifici.

Implementazioni:
- **Shopify**: OAuth per app pubblica e app custom con token; Admin GraphQL API; webhook (`orders/*`, `products/*`, `inventory_levels/update`, `fulfillments/*`, `returns/*`, `customers/*`, `app/uninstalled`) con verifica HMAC, risposta immediata ed elaborazione in coda, idempotenza per id evento, retry; sync iniziale storico in background riprendibile con cursore; riconciliazione notturna.
- **Meta Marketing API**: campagne, ad set, insights giornalieri (spesa, impression, click, view content, acquisti dichiarati), pausa/riattivazione con conferma dell'utente; gestione rate limit; backfill a finestre riprendibile.
- **Google Ads API**: campagne e metriche giornaliere; sola lettura nell'MVP.
- **Mock** per tutte: generano dati coerenti con il seed, simulano webhook ed errori (rate limit, token scaduto) per testare i retry.

Ogni integrazione per tenant ha: stato (`not_connected`, `connected`, `error`, `syncing`), ultimo sync riuscito, ultimo errore leggibile, pulsanti "Testa connessione" e "Risincronizza". Credenziali cifrate a riposo (AES-GCM, chiave da variabile d'ambiente).

### 6.2 Pagine guida per le integrazioni

Nell'app, sezione **Integrazioni → Guida**: una pagina per Shopify, Meta e Google con i passi per collegarle (creare l'app o il token, permessi e scope richiesti, dove incollare cosa, come verificare che funzioni, errori comuni). Tradotte nelle tre lingue.
- Scrivi i passi in base a quanto conosci delle API. **Segna con un badge "Da verificare"** ogni passo che dipende da interfacce dei fornitori che potrebbero essere cambiate.
- Elenca gli scope minimi per ogni modulo, così l'installatore sa cosa chiedere al cliente.

---

## 7. Moduli del core (tutti inclusi nel piano base)

Per ogni modulo: lista con filtri e ricerca lato server, paginazione, dettaglio, azioni principali, stati vuoti, permessi per ruolo, vista mobile usabile, test.

1. **Ordini in entrata**
   Lista e ricerca veloce (numero, nome, email, telefono), filtri per stato canonico, pagamento, canale, data, tag. Dettaglio con timeline (autore + diff), note interne con @menzioni e notifiche, storico cliente (ordini precedenti, resi, annullamenti, valore totale), azioni (cambia stato, annulla, aggiungi nota, assegna a utente) con scrittura verso Shopify dove ha senso. Rilevamento di ordini duplicati dello stesso cliente in 5 giorni.

2. **Ordini in uscita e spedizioni**
   Riepilogo evasioni da Shopify: tracking, corriere, stato, giorni in viaggio, spedizioni ferme oltre N giorni, eccezioni. Modello a più fonti per lo stato della spedizione: ogni fonte scrive il proprio campo e una funzione decide lo stato visibile con precedenze. Oggi l'unica fonte è Shopify, ma la struttura deve accoglierne altre.

3. **CRM**
   Clienti con profilo, valore, frequenza, ultimo ordine. **Costruttore di segmenti** con gruppi E/O annidati (massimo 3 livelli, 30 condizioni) su dati di ordine, prodotto, valore, recenza, frequenza, paese, tag. Matrice **RFM** con fasce. Esportazione dei segmenti in CSV. Interfaccia `MessagingChannel` predisposta per campagne future, con il concetto di **gruppo di controllo** già nel modello dati (`holdout_percentage`, assegnazione stabile per cliente).

4. **Analisi dati**
   Dashboard KPI (ricavi, ordini, AOV, tasso di annullamento e reso, nuovi e ricorrenti) con confronto tra periodi. **P/L per ordine e per periodo**: ricavo netto di tasse (aliquota per paese del tenant), costo prodotto (dall'ultimo costo d'acquisto), spedizione, commissioni di pagamento (% per metodo, configurabile), resi, spesa ads. Performance prodotti. Coorti di riacquisto mensili. Ogni numero cliccabile verso gli ordini che lo compongono.

5. **Campagne ↔ inventario**
   Collegamento campagna → uno o più prodotti (manuale, con suggerimento automatico dal nome della campagna o dagli URL degli annunci). Per campagna: spesa, ordini attribuiti (UTM e click id da Shopify), ricavi, margine, profitto, ROAS, ROI, CPA. **Il profitto conta solo gli ordini non annullati e non resi**, non tutti gli ordini piazzati. Semaforo con soglie configurabili, azione consigliata (spegni, accendi, valuta) che tiene conto dello stock dei prodotti collegati (es. "spegni: prodotto sotto la soglia di stock"), esecuzione della pausa via Meta con conferma, consiglio di riordino.

6. **Prodotti e magazzino**
   Catalogo sincronizzato con varianti a opzioni dinamiche, livelli di stock per location, velocità di vendita su finestra configurabile, giorni di copertura, rischio esaurimento, suggerimento di riordino. Modifiche base (prezzo, stato) scritte verso Shopify.

7. **Resi configurabili**
   Richieste di reso con motivi configurabili per tenant, regole (finestra in giorni, categorie escluse, condizioni), workflow con stati configurabili (richiesto, approvato, ricevuto, ispezionato, rimborsato, cambio, rifiutato), esiti (rimborso, cambio, buono), rientro a stock facoltativo per location. Sync con i resi Shopify dove disponibili. Analisi resi per prodotto e motivo.

8. **Sconti**
   Lista sincronizzata con Shopify, creazione di codici singoli e **pool di codici unici in blocco**, scadenza, limiti, utilizzi, ricavi e margine attribuiti per codice.

9. **Acquisti**
   Fornitori; ordini d'acquisto con stati (bozza, inviato, confermato, in transito, ricevuto parziale, ricevuto, annullato); merce in arrivo visibile nelle schede prodotto e nei riordini; al ricevimento aggiornamento del costo prodotto (che alimenta il P/L) e, facoltativamente, dello stock su Shopify; saldi verso i fornitori.

10. **Piattaforma**
    Notifiche in-app, pagina "salute integrazioni", impostazioni del tenant, gestione utenti e ruoli, audit log consultabile dagli owner.

11. **Assistente AI** (decisione del committente, 2026-10-01, issue #7)
    Nel core, non un add-on: ogni negozio collega la **propria chiave API Anthropic** in Integrazioni e paga il consumo direttamente ad Anthropic; senza chiave la pagina chiede di collegarla. Solo lettura, tramite strumenti sopra i servizi di analisi filtrati per ruolo; ogni risposta cita numeri, periodo, filtri e link. Interfaccia `LlmProvider` in `packages/integrations` con adapter Anthropic (SDK ufficiale) e mock deterministico.

---

## 8. Moduli add-on e console super-admin

### 8.1 Sistema di add-on

- Registro dei moduli in `packages/config`: `core.*` (sempre attivi per piano) e `addon.*` (attivabili per tenant dal super-admin).
- Feature flag verificati lato server (route, API, job) e lato client (menu, pagine). Un modulo spento non deve essere raggiungibile nemmeno conoscendo l'URL.
- **Add-on di riferimento da implementare: `addon.cod` (gestione contrassegno)**, solo dopo che il core è completo:
  - coda di conferma per gli ordini in contrassegno, con esiti (confermato, non risponde, da richiamare, annullato) e tentativi;
  - assegnazione automatica agli operatori in proporzione alle ore lavorate (round-robin pesato, calendario e assenze);
  - **delivery score 0–100** spiegato fattore per fattore (storico cliente, ordini simili, qualità indirizzo, tentativi, valore anomalo, duplicati), pesi configurabili;
  - classificazione dei destinatari a rischio (blacklist suggerita, mai azioni automatiche).
- **`addon.customer_campaigns`** (decisione del committente, 2026-10-01, issue #38): le campagne email, SMS e WhatsApp ai segmenti e tutto ciò che riguarda il gruppo di controllo (percentuale di controllo sui segmenti, gruppi trattati/controllo, misura dell'effetto) sono un add-on. Senza l'add-on i segmenti sono semplici: nessun campo di controllo, nessun gruppo, esportazione e audience con tutti i membri. Le colonne del modello dati restano (§7.3). I provider WhatsApp (es. Spoki) sono canali di questo add-on.
- Gli altri add-on (connettori 3PL, provider WhatsApp locali) compaiono nel catalogo come "Disponibile su richiesta" senza implementazione.

### 8.2 Console super-admin (`/admin`)

- Lista tenant con piano, add-on attivi, stato integrazioni, ordini/mese, ultimo accesso, stato pagamento.
- Creazione tenant con checklist di setup (dati azienda, utenti, Shopify, Meta, Google, regole di stato, costi).
- Attivazione/disattivazione add-on per tenant, con data e nota.
- **Billing**: piani a tier, fee di setup una tantum, add-on mensili; abbonamenti e fatture via `BillingProvider` (mock di default, Stripe test mode se ci sono le chiavi); stato pagamenti (in regola, scaduto, sospeso) e sospensione dell'accesso dopo N giorni di insoluto, configurabile.
- **Impersonificazione** di un tenant per supporto, con banner visibile e audit.
- Metriche di piattaforma: MRR, tenant attivi, add-on più venduti, errori di integrazione aperti.

Piani di esempio nel seed (valori modificabili da config): **Starter**, **Growth**, **Scale**, con limiti di ordini/mese e utenti.

---

## 9. Fasi di lavoro

| Fase | Contenuto | Fatto quando |
| --- | --- | --- |
| 0 | Monorepo, Docker, lint, typecheck, test runner, design system di base, i18n, auth | `pnpm dev` mostra il login in 3 lingue |
| 1 | Tenancy + RLS + ruoli + audit + test di isolamento | Test di isolamento verdi su tutte le tabelle |
| 2 | Modello canonico, regole di stato, adapter mock, **seed demo** | Il seed crea i tenant demo con i dati della sezione 10 |
| 3 | Ordini in entrata + spedizioni | Lista veloce sul seed, dettaglio con timeline |
| 4 | Prodotti, magazzino, acquisti | Il ricevimento di un ordine d'acquisto aggiorna costo e stock |
| 5 | Analisi dati + P/L | Il P/L di un mese torna con il calcolo a mano su 3 ordini di test |
| 6 | Campagne ↔ inventario | Suggerimenti coerenti con stock e soglie |
| 7 | CRM, segmenti, RFM | Un segmento annidato restituisce i clienti attesi |
| 8 | Resi + sconti | Workflow resi completo con rientro a stock |
| 9 | Adapter reali Shopify/Meta/Google + pagine guida + salute integrazioni | Test con payload registrati (fixture) verdi |
| 10 | Console super-admin, billing, add-on, impersonificazione | Un add-on spento rende la pagina irraggiungibile |
| 11 | Add-on `addon.cod` | Coda, assegnazione e score funzionanti sul tenant demo |
| 12 | Rifinitura, e2e, screenshot, documentazione finale | Sezione 11 completa |

---

## 10. Dati demo (seed)

Il committente valuterà il prodotto **solo sui dati demo**: devono essere realistici e abbondanti.

- **Tenant A — "Northwind Apparel"**: moda, UE, EUR, lingua it, ~15.000 ordini in 12 mesi, ~120 prodotti con varianti, 10% di ordini in contrassegno, add-on `cod` attivo, 3 location, 4 fornitori, 25 campagne Meta e 6 Google, resi al 12%.
- **Tenant B — "Harbor Home"**: casa e arredo, USA, USD, lingua en, ~6.000 ordini, ~60 prodotti, nessun contrassegno, nessun add-on.
- Stagionalità, clienti ricorrenti, annullamenti, prodotti in esaurimento, campagne in perdita e in guadagno, ordini d'acquisto in arrivo: ogni pagina deve avere qualcosa di interessante da mostrare.
- Utenti demo per ogni ruolo e un super-admin, con credenziali elencate nel README.
- Generatore deterministico (seed fisso) e veloce: meno di 2 minuti.

---

## 11. Consegna finale

Alla fine produci:
- `README.md`: avvio in un comando, credenziali demo, struttura del repository.
- `docs/EVALUATION.md` per il committente, in **italiano**: cosa funziona, cosa è mock, cosa manca, debiti tecnici, rischi, e i 10 passi consigliati per arrivare a un primo cliente pagante.
- `docs/ARCHITECTURE.md`: diagramma dei pacchetti (Mermaid), modello dati, flussi di sync e webhook, come aggiungere un adapter e come aggiungere un add-on.
- `docs/screenshots/`: screenshot Playwright di ogni pagina principale in en e it, sia come utente tenant sia come super-admin.
- `docs/DECISIONS.md` e `docs/PROGRESS.md` aggiornati.

---

## 12. Cosa NON fare

- Non progettare il core attorno al contrassegno: niente code di conferma, score di consegna o KPI di contrassegno fuori da `addon.cod`.
- Non integrare corrieri, 3PL o provider di messaggistica specifici (niente GLS, Elogy, Spoki o simili): solo interfacce e mock.
- Non cablare taglie, categorie di settore, una valuta, un paese, un fuso orario o un'aliquota.
- Non dedurre lo stato degli ordini da tag fissi nel codice.
- Non usare `localStorage` per dati di dominio.
- Non saltare i test di isolamento tra tenant per andare più veloce.
