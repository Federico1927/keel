# Valutazione di Keel per il committente

Documento in italiano, scritto alla fine della fase 12. Dice cosa funziona davvero, cosa è simulato, cosa manca, dove sono i debiti tecnici e i rischi, e i dieci passi che consiglio per arrivare a un primo cliente pagante. Le valutazioni sui dati demo vanno fatte con le credenziali del `README.md`.

## 1. In una frase

Keel è un MVP completo in tutte le dodici fasi previste: dieci moduli core, console super-admin con fatturazione, un add-on contrassegno isolato in un pacchetto separato, adapter reali per Shopify, Meta e Google testati su payload registrati, 447 test automatici più 39 scenari end-to-end. **Non è mai stato collegato a un negozio vero**: tutto quello che vedi gira in modalità mock, per scelta e per regola del brief.

## 2. Cosa funziona (verificato con test o e2e)

| Area | Stato | Prova |
| --- | --- | --- |
| Multi-tenancy con RLS, ruoli per tenant, audit con diff | Funziona | 311 test db, uno di isolamento per ciascuna delle 56 tabelle; e2e: utente senza permesso riceve 404 |
| Stato canonico dell'ordine con regole per tenant e anteprima su 50 ordini | Funziona | Test core su precedenze; e2e regole di stato |
| Ordini: lista veloce (trigram), filtri, dettaglio con timeline, note con @menzioni, storico cliente, duplicati, cambio stato, annullo, assegnazione | Funziona | e2e ordini |
| Spedizioni: KPI, ferme, eccezioni, risolutore multi-fonte con precedenze | Funziona (una sola fonte reale: Shopify) | Test core del risolutore |
| Prodotti, varianti a opzioni dinamiche, stock per location, velocità, copertura, riordini, prezzo e stato verso l'adapter | Funziona | e2e inventario |
| Acquisti: fornitori, ordini d'acquisto, ricevimento che aggiorna stock, costo e backorder | Funziona | e2e: il ricevimento cambia stock e costo |
| Analisi: KPI con confronto, P/L per ordine e periodo, prodotti, coorti, drill-through | Funziona | P/L a mano su 3 ordini (51,05 / annullato / 68,12 → 79,17) riprodotto dal codice |
| Campagne ↔ stock: metriche, profitto solo su ordini validi, semaforo, raccomandazioni con stock, pausa via adapter con conferma, registro giornaliero con CSV | Funziona | Test core, e2e campagne |
| CRM: profili, costruttore segmenti annidato, RFM, holdout stabile, export CSV | Funziona | Test di parità valutatore in memoria vs SQL compilato; e2e |
| Resi configurabili con rientro a stock e propagazione all'ordine; sconti singoli e pool | Funziona | e2e resi e sconti |
| Modifica ordini nel core, per ogni metodo di pagamento: contatti, indirizzi (con controllo di formato e suggerimenti), nota, cambio righe e unione come sostituzione collegata (i report contano un solo ordine), sconto su ordine esistente | Funziona | Test servizi, e2e su Harbor Home senza add-on |
| Integrazioni: stato, salute, esecuzioni, registro webhook, test connessione, risincronizzazione, guide in 3 lingue | Funziona | e2e integrazioni |
| Console `/admin`: tenant, creazione con checklist, add-on con nota, fatturazione mensile, sospensione per insoluto, impersonificazione con banner e audit | Funziona | e2e console: add-on spento → pagina irraggiungibile |
| Add-on contrassegno: coda con esiti, assegnazione pesata, delivery score spiegato, destinatari a rischio; tag Shopify letti e scritti secondo il vocabolario del tenant; modifica pre-conferma tramite i servizi del core con tentativo di chiamata e passaggio della coda, annullo sulla piattaforma | Funziona sul tenant demo | 20 test, e2e coda e modifica |
| Assistente AI nel core: domande in linguaggio naturale, risposte con numeri, periodo, filtri e link ai report; solo lettura e strumenti filtrati per ruolo; gira sulla chiave Anthropic del negozio (quarta scheda in Integrazioni) | Funziona (modello simulato nella demo) | Test servizi sul ciclo con risposte registrate; e2e assistente |
| Tre lingue (en, it, es), formati `Intl` per tenant | Funziona | Test di parità delle chiavi fallisce se manca una traduzione |

## 3. Cosa è mock o simulato

Tutto ciò che tocca il mondo esterno è dietro un'interfaccia e, in questa consegna, è servito da un simulatore.

| Cosa | Com'è oggi | Cosa serve per renderlo reale |
| --- | --- | --- |
| Shopify, Meta, Google | Adapter live scritti e testati su payload registrati (fixture); in esecuzione gira il mock in memoria che genera dati coerenti con il seed e simula webhook, rate limit e token scaduti. La creazione di un ordine sostitutivo passa da draft order completato con pagamento in sospeso: comportamento di tasse, spedizione e gateway contrassegno da verificare sul negozio reale | Un negozio di sviluppo Shopify, un account Meta e Google Ads di test, le chiavi nel `.env`, `KEEL_INTEGRATION_MODE=live`. Prevedere una settimana di aggiustamenti sui payload reali: le fixture sono scritte in base alla documentazione, non registrate da un account vero |
| Fatturazione | `MockBillingProvider` di default. `StripeBillingProvider` parla con l'API REST in test mode ma non riceve webhook né gestisce carte | Chiavi Stripe test, webhook `invoice.paid` / `payment_failed`, Checkout per la carta |
| Magic link | Stampato in console | Un provider email (Resend, Postmark) |
| Notifiche | Solo in-app | Email o Slack sulle stesse notifiche |
| Corrieri, 3PL, WhatsApp | Solo interfacce (`CarrierProvider`, `WarehouseProvider`, `MessagingChannel`) e mock; nel catalogo come "Disponibile su richiesta" | Un connettore per cliente, come da modello di business |
| Assistente AI | Adapter Anthropic scritto con l'SDK ufficiale e testato su risposte registrate; nella demo gira un modello simulato che chiama gli strumenti veri (numeri e link reali, testo essenziale) | Il negozio crea un account Anthropic con credito, incolla la chiave in Integrazioni → AI (Anthropic), `KEEL_INTEGRATION_MODE=live`. Il costo lo paga il negozio direttamente ad Anthropic |
| Dati demo | Generatore deterministico: 15.000 + 6.000 ordini in circa 40 secondi | Nulla: restano utili per demo commerciali e test |

Alcune caratteristiche "interessanti" del seed sono garantite strutturalmente (prodotti in esaurimento senza merce in arrivo, campagne in perdita); altre sono probabilistiche e possono variare leggermente a ogni riseed.

## 4. Cosa manca

Richiesto dal brief ma non completo:

- **GA4 (`AnalyticsPlatform`)**: solo interfaccia, nessun adapter.
- **Scrittura verso Shopify** limitata a: annullo ordine, modifica di contatti, indirizzo e nota, ordine sostitutivo (cambio righe e unioni), sconto su ordine esistente, prezzo e stato prodotto, stock al ricevimento (facoltativo), creazione sconti e pool. Non si evade. L'indirizzo di fatturazione non è modificabile via API su Shopify e resta solo in Keel.
- **Connettore MCP** citato nell'analisi di partenza: non implementato.
- **Resi Shopify**: il webhook `returns/*` è parsato e registrato, ma il flusso resi nasce in Keel; non si crea un reso su Shopify.
- **Vista mobile**: le pagine sono fluide e usabili su tablet; su telefono le tabelle larghe (ordini, registro campagne) scorrono in orizzontale, non sono riprogettate.

Richiesto da Federico dopo la consegna, in lavorazione:

- **Form resi pubblico** personalizzabile (campi, motivi, testi, lingua) che alimenta la pagina Resi.
- **Resi scritti su Shopify** (ordine marcato come reso, rimborso, rientro a stock).
- **P/L con costi fissi e di spedizione per periodo**, stima e consuntivo.
- **Editor dei flag per tenant** nella console (il meccanismo `featureFlags` c'è, manca l'interfaccia).

Non richiesto ma necessario prima della produzione:

- Rate limiting e protezione brute force sul login; 2FA.
- Backup, migrazioni zero-downtime, osservabilità (log strutturati, tracing, allarmi su `integration_health`).
- Esportazione e cancellazione dati per GDPR; retention dei payload webhook.
- Onboarding self-service (oggi il tenant lo crea il super-admin, coerente con la fee di installazione).

## 5. Debiti tecnici

1. **Fixture degli adapter scritte a mano.** I 20 test di `packages/integrations` passano su payload costruiti dalla documentazione. La prima connessione reale li correggerà; va messa in conto.
2. **Query per lista scritte in SQL grezzo in alcuni punti** (`services/crm`, `services/analytics`): parametrizzate e testate, ma Drizzle non le tipizza. Un refactor verso query builder è possibile e non urgente.
3. **Elaborazione inline dei webhook quando il worker non c'è.** Comodo in sviluppo (`KEEL_JOBS_QUEUE` vuoto), pericoloso in produzione se qualcuno dimentica di impostare la variabile: un picco di webhook occuperebbe il processo web. Va reso obbligatorio il worker in produzione.
4. **Seed e test condividono i generatori**: un cambiamento al generatore può spostare i dati su cui gli e2e fanno affidamento. Gli e2e sono stati resi robusti (scelgono righe per stato, non per posizione), ma il legame resta.
5. **Impostazioni tenant in una colonna JSON** validata da zod: flessibile, ma ogni nuova chiave richiede un default e una migrazione "soft". Documentato in `tenant-settings.ts`.
6. **Nessuna cache**: ogni pagina interroga il database. Sui 21.000 ordini del demo le pagine rispondono sotto il secondo; sopra i 200.000 ordini serviranno viste materializzate per analisi e RFM.
7. **Il registro giornaliero per campagna** mostra l'intero periodo scelto senza paginazione; con 12 mesi è una pagina lunghissima.
8. **Playwright gira contro la build di produzione** e i test della console modificano i tenant demo: ordinati per girare dopo gli altri, ma un `db:reset` prima della suite è la via sicura.

## 6. Rischi

| Rischio | Probabilità | Impatto | Mitigazione |
| --- | --- | --- | --- |
| I payload reali di Shopify/Meta/Google differiscono dalle fixture | Alta | Medio: giorni di lavoro, non settimane | Adapter con `fetch` iniettabile: si registra il payload vero, si aggiorna la fixture, il test lo copre per sempre |
| Regole di stato configurate male dal cliente → ordini nello stato sbagliato | Media | Alto | Anteprima su 50 ordini già presente; aggiungere un report "ordini senza regola" e un default conservativo (`pending_review`) |
| Attribuzione campagne incompleta (UTM mancanti, iOS) | Alta | Medio: profitto per campagna sottostimato | Dichiarare la copertura dell'attribuzione in pagina; valutare un modello di attribuzione a quota in fase 2 |
| Costi prodotto assenti all'inizio → P/L non attendibile | Alta nelle prime settimane | Alto | La checklist di setup chiede i costi; aggiungere import CSV dei costi e un indicatore "P/L con costi mancanti su N ordini" |
| Sospensione automatica per insoluto su un cliente che paga con bonifico in ritardo | Media | Alto commerciale | `suspend_after_days` configurabile per tenant e sospensione manuale sticky già esistono; impostare 30 giorni di default per i primi clienti |
| Un bug nell'add-on contrassegno tocca il core | Bassa | Alto | Pacchetto separato, il core non lo importa; test di isolamento sulle sue tabelle |
| Crescita del volume (webhook) senza worker | Media | Alto | Rendere `KEEL_JOBS_QUEUE=1` obbligatorio in produzione (vedi debiti) |

## 7. I dieci passi verso il primo cliente pagante

1. **Scegliere il primo cliente tra chi vende su Shopify e paga con carta o PayPal**, non in contrassegno: valida il core senza l'add-on. Il brand di calzature può arrivare secondo, con `addon.cod`.
2. **Collegare un negozio di sviluppo Shopify in modalità live**, registrare i payload veri come fixture e correggere i mapper. Stimo una settimana.
3. **Collegare Meta e Google con account di test**, verificare insight giornalieri e la pausa campagna con conferma. Tre giorni.
4. **Deploy di staging**: Postgres gestito, web e worker separati, `KEEL_JOBS_QUEUE=1`, backup giornalieri, log strutturati. Due giorni.
5. **Email transazionali**: magic link, invito utente, notifiche di menzione e di errore integrazione. Un giorno.
6. **Import iniziale dei costi prodotto e delle commissioni di pagamento** via CSV nella checklist di setup, altrimenti il P/L del primo mese non è credibile. Due giorni.
7. **Pilota di quattro settimane gratuito con il primo cliente**, con revisione settimanale di: regole di stato, attribuzione campagne, soglie semaforo. Raccogliere i casi in cui lo stato canonico è sbagliato.
8. **Stripe in test mode end-to-end**: Checkout per la carta, webhook `invoice.paid`, poi chiavi live. Due giorni.
9. **Pagine legali e GDPR minime**: DPA, esportazione dati del tenant, cancellazione su richiesta. Tre giorni con un modello.
10. **Prezzo e contratto**: fee di installazione (già nei piani: 490/1.500/3.000 $) coperta dalle ore dei passi 2, 3 e 6; abbonamento Growth al primo cliente con uno sconto a tempo. Passare da pilota a pagante alla fine delle quattro settimane.

## 8. Come valutare il prodotto in trenta minuti

1. Entra come `owner@northwind.demo`: dashboard, Ordini (cerca un numero, apri un dettaglio, cambia stato, scrivi una nota con @), Spedizioni ferme.
2. Analisi → P/L: clicca un numero e arriva sugli ordini che lo compongono.
3. Campagne: ordina per profitto, apri una campagna in perdita, leggi la raccomandazione e i prodotti collegati; prova la pausa (il mock la accetta).
4. Magazzino: prodotti critici senza merce in arrivo → "nuovo ordine d'acquisto" precompilato → ricevilo e guarda stock e costo cambiare.
5. Clienti → RFM: clicca una cella, nasce un segmento precompilato; esportalo.
6. Resi: crea una richiesta da un ordine consegnato, approvala, ricevila, rimborsa con rientro a stock.
7. Integrazioni: simula un webhook e un errore di rate limit, guarda salute e registro.
8. Coda contrassegno: registra una chiamata, guarda il delivery score spiegato.
9. Entra come `owner@harborhome.demo`: stesso prodotto, nessuna traccia del contrassegno, dollari, inglese.
10. Entra come `superadmin@keel.demo`: spegni `addon.cod` a Northwind e prova ad aprire `/t/northwind-apparel/cod` → 404. Riaccendilo. Esegui la fatturazione.

Gli screenshot in `docs/screenshots/` (en e it, tenant e super-admin) coprono le stesse pagine.
